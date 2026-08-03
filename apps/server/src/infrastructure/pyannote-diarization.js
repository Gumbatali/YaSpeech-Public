/**
 * pyannote/speaker-diarization-3.1 via HuggingFace Inference API.
 *
 * pyannote — лучший open-source диаризатор (2024).
 * Работает НА АУДИО ФИЧАХ (не на тексте) → работает для любого языка, включая русский.
 * Особенно хорош для:
 *   - Нескольких спикеров с похожей речью
 *   - Перекрывающейся речи
 *   - Шумных записей
 *
 * Для использования:
 *   1. Получить HF token: huggingface.co/settings/tokens
 *   2. Принять условия модели: huggingface.co/pyannote/speaker-diarization-3.1
 *   3. Выставить env: HF_TOKEN=hf_...
 *
 * Без HF_TOKEN модуль возвращает null (pipeline продолжает без диаризации).
 *
 * API Response:
 *   [{ "label": "SPEAKER_00", "speaker": "SPEAKER_00", "start": 0.5, "stop": 3.2 }, ...]
 */

import { logger } from "../shared/logger.js";
import { chunkWav, parseWavHeader, stitchChunkedSegments } from "./diarization/wav-chunker.js";

const DEFAULT_MODEL = "pyannote/speaker-diarization-community-1";
const MAX_BYTES = 24 * 1024 * 1024; // предел HF Inference API
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000; // HF может грузить модель — ждём

// 10 минут WAV PCM 16 kHz mono ≈ 19 МБ — с запасом влезает в лимит HF.
const CHUNK_SEC = 600;
const CHUNK_OVERLAP_SEC = 10;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export class PyannoteDiarization {
  /**
   * @param {{ hfToken: string, artifactStorage: import("./yc-artifact-storage.js").YcArtifactStorage }}
   */
  constructor({ hfToken, artifactStorage, model = DEFAULT_MODEL }) {
    this.hfToken = hfToken;
    this.artifactStorage = artifactStorage;
    this.model = model;
    this.apiUrl = `https://api-inference.huggingface.co/models/${model}`;
    this.backend = "pyannote-hf";
  }

  get available() {
    return Boolean(this.hfToken);
  }

  /**
   * Запускает диаризацию для аудиофайла из S3.
   *
   * @param {string} audioKey  - ключ файла в S3
   * @returns {Promise<DiarizationSegment[] | null>}
   *
   * @typedef {{ speaker: string, start: number, stop: number }} DiarizationSegment
   */
  async diarize(audioKey) {
    if (!this.available) {
      logger.info("Pyannote: skipped (no HF_TOKEN)");
      return null;
    }

    logger.info("Pyannote: downloading audio for diarization", { audioKey });

    const audioStream = await this.artifactStorage.readStream(audioKey);
    const audioBuffer = await streamToBuffer(audioStream);

    // Длинная запись не влезает в лимит HF. Раньше её резали по сырым байтам —
    // хвост встречи молча терял спикеров. Теперь режем по времени и сшиваем.
    if (audioBuffer.length > MAX_BYTES) {
      return this._diarizeChunked(audioBuffer);
    }

    return this._diarizeWhole(audioBuffer);
  }

  /** Диаризация записи, целиком помещающейся в лимит API. */
  async _diarizeWhole(audioBuffer) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = await this._callApi(audioBuffer);
        logger.info("Pyannote: diarization done", {
          segments: result.length,
          speakers: [...new Set(result.map((s) => s.speaker))].length
        });
        return result;
      } catch (e) {
        if (e.message.includes("loading") || e.message.includes("503")) {
          // HF грузит модель в оперативку — нормально, ждём
          logger.warn(`Pyannote: model loading, retry ${attempt}/${MAX_RETRIES}`, {
            delay: RETRY_DELAY_MS
          });
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }
        logger.error("Pyannote: diarization failed", { error: e.message, attempt });
        return null; // Fallback — не крашим весь pipeline
      }
    }

    logger.error("Pyannote: all retries exhausted");
    return null;
  }

  /**
   * Диаризация длинной записи по частям.
   *
   * Работает только для WAV PCM — именно его отдаёт браузерный preprocessor.
   * Для любого другого формата честно отказываемся: обрезать «как раньше»
   * значит тихо испортить данные, а это хуже явного отсутствия диаризации.
   */
  async _diarizeChunked(audioBuffer) {
    const info = parseWavHeader(audioBuffer);

    if (!info) {
      logger.error("Pyannote: audio exceeds HF limit and is not WAV PCM — cannot chunk safely", {
        sizeMb: (audioBuffer.length / 1024 / 1024).toFixed(1),
      });
      return null;
    }

    const chunks = chunkWav(audioBuffer, {
      maxChunkSec: CHUNK_SEC,
      overlapSec: CHUNK_OVERLAP_SEC,
    });

    logger.info("Pyannote: audio exceeds HF limit, processing in chunks", {
      durationSec: Math.round(info.durationSec),
      chunks: chunks.length,
    });

    const results = [];

    for (const chunk of chunks) {
      const segments = await this._diarizeWhole(chunk.buffer);

      if (!segments) {
        // Один провалившийся чанк не должен обнулять остальные: лучше
        // разметить 50 минут из 60, чем не разметить ничего.
        logger.warn("Pyannote: chunk failed, continuing without it", {
          index: chunk.index,
          startSec: Math.round(chunk.startSec),
        });
        continue;
      }

      results.push({ startSec: chunk.startSec, segments });
    }

    if (results.length === 0) {
      logger.error("Pyannote: every chunk failed");
      return null;
    }

    const stitched = stitchChunkedSegments(results, { overlapSec: CHUNK_OVERLAP_SEC });

    logger.info("Pyannote: chunks stitched", {
      chunksOk: results.length,
      chunksTotal: chunks.length,
      segments: stitched.length,
      speakers: new Set(stitched.map((s) => s.speaker)).size,
    });

    return stitched;
  }

  async _callApi(audioBuffer) {
    const startMs = Date.now();

    const res = await fetch(this.apiUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.hfToken}`,
        "Content-Type": "audio/wav",
      },
      body: audioBuffer,
    });

    if (res.status === 503) {
      const data = await res.json().catch((err) => {
        logger.warn("Pyannote: could not parse 503 body", { error: err.message });
        return {};
      });
      throw new Error(`loading: ${data.estimated_time ?? "unknown"} sec`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HF API ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json();

    logger.info("Pyannote: API response", { latencyMs: Date.now() - startMs });

    // Нормализуем формат ответа
    const segments = Array.isArray(data) ? data : (data.output ?? []);
    return segments.map((s) => ({
      speaker: s.speaker ?? s.label ?? "SPEAKER_00",
      start: Number(s.start ?? s.timestamp?.[0] ?? 0),
      stop: Number(s.stop ?? s.end ?? s.timestamp?.[1] ?? 0),
    })).filter((s) => s.stop > s.start);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Alignment: combines Whisper segments with pyannote segments
// ────────────────────────────────────────────────────────────────────────────

/**
 * Выравнивает сегменты Whisper (текст + временные метки) с сегментами pyannote (спикеры + временные метки).
 *
 * Алгоритм: для каждого Whisper-сегмента находим спикера с максимальным перекрытием по времени.
 *
 * @param {Array<{ start, end, text }>} whisperSegments
 * @param {Array<{ speaker, start, stop }>} diarizationSegments
 * @returns {Array<{ speakerId, speakerLabel, text, startTimeMs, endTimeMs }>}
 */
export function alignTranscriptWithDiarization(whisperSegments, diarizationSegments) {
  // Строим карту нормализованных имён спикеров (SPEAKER_00 → speaker-1 и т.д.)
  const speakerIds = [...new Set(diarizationSegments.map((s) => s.speaker))].sort();
  const speakerMap = new Map(
    speakerIds.map((id, i) => [id, { newId: `speaker-${i + 1}`, label: `Спикер ${i + 1}` }])
  );

  return whisperSegments.map((seg) => {
    const bestSpeaker = findDominantSpeaker(seg.start, seg.end, diarizationSegments);
    const mapped = speakerMap.get(bestSpeaker);

    return {
      speakerId: mapped?.newId ?? "speaker-1",
      speakerLabel: mapped?.label ?? "Спикер 1",
      detectedName: null,
      startTimeMs: Math.round(seg.start * 1000),
      endTimeMs: Math.round(seg.end * 1000),
      text: seg.text
    };
  });
}

/**
 * Находит спикера с максимальным перекрытием в диапазоне [start, end].
 */
function findDominantSpeaker(start, end, segments) {
  const overlap = {};

  for (const seg of segments) {
    const lo = Math.max(start, seg.start);
    const hi = Math.min(end, seg.stop);
    if (hi > lo) {
      overlap[seg.speaker] = (overlap[seg.speaker] ?? 0) + (hi - lo);
    }
  }

  if (!Object.keys(overlap).length) return "SPEAKER_00";

  return Object.entries(overlap).sort((a, b) => b[1] - a[1])[0][0];
}

// ────────────────────────────────────────────────────────────────────────────
// Utils
// ────────────────────────────────────────────────────────────────────────────

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
