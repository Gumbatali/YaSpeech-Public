/**
 * HttpDiarization — адаптер к любому self-hosted сервису диаризации,
 * говорящему на контракте из ./contract.md.
 *
 * Один класс покрывает NeMo Sortformer, Streaming Sortformer, diart,
 * EEND-EDA и self-hosted pyannote — они различаются только URL и весами,
 * но не протоколом. Это и есть смысл общего контракта: сравнивать бэкенды,
 * не переписывая интеграцию под каждый.
 *
 * Интерфейс идентичен PyannoteDiarization (diarize(audioKey) → segments|null),
 * поэтому это drop-in замена в SmartAsrGateway.
 */

import { logger } from "../../shared/logger.js";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // диаризация часовой записи идёт минуты
const DEFAULT_RETRIES = 2;
const RETRY_DELAY_MS = 3000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export class HttpDiarization {
  /**
   * @param {{
   *   baseUrl: string,
   *   backend?: string,
   *   artifactStorage: { readStream: (key: string) => Promise<AsyncIterable<Uint8Array>> },
   *   timeoutMs?: number,
   *   retries?: number,
   *   numSpeakers?: number|null,
   *   minSpeakers?: number|null,
   *   maxSpeakers?: number|null,
   *   authToken?: string|null,
   * }} options
   */
  constructor({
    baseUrl,
    backend = "http",
    artifactStorage,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    numSpeakers = null,
    minSpeakers = null,
    maxSpeakers = null,
    authToken = null,
    retryDelayMs = RETRY_DELAY_MS,
  }) {
    this.baseUrl = baseUrl ? baseUrl.replace(/\/+$/, "") : null;
    this.backend = backend;
    this.artifactStorage = artifactStorage;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.numSpeakers = numSpeakers;
    this.minSpeakers = minSpeakers;
    this.maxSpeakers = maxSpeakers;
    this.authToken = authToken;
    this.retryDelayMs = retryDelayMs;
  }

  get available() {
    return Boolean(this.baseUrl);
  }

  /** Проверка готовности сервиса. Модель может ещё грузиться в память. */
  async health() {
    if (!this.available) return { status: "disabled" };
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(10_000),
        headers: this._authHeaders(),
      });
      if (!res.ok) return { status: "unhealthy", httpStatus: res.status };
      return await res.json();
    } catch (e) {
      return { status: "unreachable", error: e.message };
    }
  }

  /**
   * @param {string} audioKey ключ аудио в S3
   * @returns {Promise<Array<{speaker: string, start: number, stop: number}>|null>}
   */
  async diarize(audioKey) {
    if (!this.available) {
      logger.info(`${this.backend}: skipped (no service URL configured)`);
      return null;
    }

    const audioBuffer = await this._readAudio(audioKey);
    if (!audioBuffer) return null;

    for (let attempt = 1; attempt <= this.retries + 1; attempt++) {
      try {
        const result = await this._callService(audioBuffer, audioKey);
        logger.info(`${this.backend}: diarization done`, {
          segments: result.segments.length,
          speakers: result.numSpeakersDetected,
          processingSec: result.processingTimeSec,
        });
        return result.segments;
      } catch (e) {
        const isLast = attempt === this.retries + 1;
        // Модель ещё грузится или сервис перезапускается — есть смысл повторить.
        const isTransient =
          e.name === "TimeoutError" ||
          /\b(502|503|504)\b/.test(e.message) ||
          /fetch failed|ECONNREFUSED|socket hang up/i.test(e.message);

        if (isTransient && !isLast) {
          logger.warn(`${this.backend}: transient failure, retry ${attempt}/${this.retries}`, {
            error: e.message,
          });
          await sleep(this.retryDelayMs * attempt);
          continue;
        }

        logger.error(`${this.backend}: diarization failed`, { error: e.message, attempt });
        return null; // не роняем пайплайн — встреча обработается без спикеров
      }
    }

    return null;
  }

  async _readAudio(audioKey) {
    try {
      const stream = await this.artifactStorage.readStream(audioKey);
      const chunks = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks);
    } catch (e) {
      logger.error(`${this.backend}: could not read audio from storage`, {
        audioKey,
        error: e.message,
      });
      return null;
    }
  }

  _authHeaders() {
    return this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {};
  }

  async _callService(audioBuffer, audioKey) {
    const startMs = Date.now();

    const form = new FormData();
    form.append("audio", new Blob([audioBuffer]), basename(audioKey));
    if (this.numSpeakers != null) form.append("num_speakers", String(this.numSpeakers));
    if (this.minSpeakers != null) form.append("min_speakers", String(this.minSpeakers));
    if (this.maxSpeakers != null) form.append("max_speakers", String(this.maxSpeakers));

    const res = await fetch(`${this.baseUrl}/diarize`, {
      method: "POST",
      body: form,
      headers: this._authHeaders(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${this.backend} HTTP ${res.status}: ${text.slice(0, 300)}`);
    }

    const data = await res.json();
    const segments = normalizeSegments(data.segments);

    logger.info(`${this.backend}: service responded`, {
      latencyMs: Date.now() - startMs,
      model: data.model,
    });

    return {
      segments,
      numSpeakersDetected: data.num_speakers_detected ?? countSpeakers(segments),
      processingTimeSec: data.processing_time_sec ?? null,
    };
  }
}

/**
 * Приводит сегменты к инвариантам контракта: числовые границы, stop > start,
 * сортировка по времени. Перекрытия сохраняются — это валидные данные.
 */
export function normalizeSegments(rawSegments) {
  if (!Array.isArray(rawSegments)) return [];

  return rawSegments
    .map((s) => ({
      speaker: String(s.speaker ?? s.label ?? "SPEAKER_00"),
      start: Number(s.start),
      stop: Number(s.stop ?? s.end),
    }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.stop) && s.stop > s.start)
    .sort((a, b) => a.start - b.start || a.stop - b.stop);
}

function countSpeakers(segments) {
  return new Set(segments.map((s) => s.speaker)).size;
}

function basename(key) {
  const name = String(key).split("/").pop() || "audio.wav";
  return name;
}
