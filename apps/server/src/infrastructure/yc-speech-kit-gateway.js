/**
 * SpeechKit v3 async recognition.
 *
 * Ключевые отличия от v2:
 *   - literatureText: true — расставляет знаки препинания, нормализует числа
 *   - Диаризация через channelTag (0/1) — несколько спикеров
 *   - Реальные временные метки для каждого слова
 *
 * ВАЖНО: v3 возвращает результаты НЕ через op.response, а через отдельный
 *   endpoint /stt/v3/getRecognition?operationId={id} в формате NDJSON.
 *
 * API: https://stt.api.cloud.yandex.net/stt/v3/recognizeFileAsync
 * Result: https://stt.api.cloud.yandex.net/stt/v3/getRecognition?operationId={id}
 * Polling: https://operation.api.cloud.yandex.net/operations/{id}
 *
 * Формат аудио: наш препроцессор отдаёт WAV (RIFF + PCM 16kHz mono).
 *   audioFormat.containerAudio.containerAudioType = "WAV"
 */

import { getIamToken, invalidateIamToken } from "../shared/iam-token.js";
import { logger } from "../shared/logger.js";

const SPEECHKIT_V3_URL     = "https://stt.api.cloud.yandex.net/stt/v3/recognizeFileAsync";
const SPEECHKIT_V3_GET_URL = "https://stt.api.cloud.yandex.net/stt/v3/getRecognition";
const OPERATION_URL        = "https://operation.api.cloud.yandex.net/operations";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class YcSpeechKitGateway {
  constructor({ bucket }) {
    this.bucket = bucket;
  }

  /**
   * Запускает асинхронное распознавание и немедленно возвращает operationId.
   * Используется в split-flow: воркер отдельно стартует, отдельно поллит.
   *
   * @param {{ meeting: object, project?: object, audioKey?: string }} params
   *   audioKey — переопределяет ключ аудио в S3 (для параллельного ASR
   *   больших записей: каждый чанк лежит по своему ключу, см.
   *   meeting-pipeline-service.js _startParallelRecognition). По умолчанию —
   *   оригинальный файл целиком.
   */
  async startRecognition({ meeting, audioKey }) {
    let iamToken = await getIamToken();
    const key = audioKey ?? meeting.artifacts.audioOriginalKey;
    const audioUri = `https://storage.yandexcloud.net/${this.bucket}/${key}`;
    logger.info("SpeechKit v3: startRecognition", { meetingId: meeting.id, audioUri });

    const makeRequest = async (token) => fetch(SPEECHKIT_V3_URL, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        uri: audioUri,
        recognitionModel: {
          model: "general",
          audioFormat: { containerAudio: { containerAudioType: "WAV" } },
          textNormalization: {
            textNormalization: "TEXT_NORMALIZATION_ENABLED",
            profanityFilter: false,
            literatureText: true
          },
          languageRestriction: { restrictionType: "WHITELIST", languageCode: ["ru-RU"] },
          audioProcessingType: "FULL_DATA"
        },
        speakerLabeling: { speakerLabeling: "SPEAKER_LABELING_ENABLED" }
      })
    });

    let startRes = await makeRequest(iamToken);
    if (startRes.status === 401) {
      invalidateIamToken();
      iamToken = await getIamToken();
      startRes = await makeRequest(iamToken);
    }
    if (!startRes.ok) {
      const text = await startRes.text().catch(() => "");
      logger.error(`SpeechKit v3: startRecognition failed ${startRes.status} ${text}`, { meetingId: meeting.id });
      throw new Error(`SpeechKit v3 start failed ${startRes.status}: ${text}`);
    }

    const operation = await startRes.json();
    const operationId = operation.id;
    if (!operationId) {
      throw new Error(`SpeechKit v3: no operation id: ${JSON.stringify(operation)}`);
    }
    logger.info("SpeechKit v3: operation created", { meetingId: meeting.id, operationId });
    return { operationId };
  }

  /**
   * Однократный опрос операции. Возвращает { done: false } если ещё не готово,
   * или { done: true, jobId, transcript } когда готово.
   * Вызывается в отдельных инвокациях воркера через YMQ.
   */
  async pollRecognitionOnce({ meeting, operationId }) {
    let iamToken = await getIamToken();

    let res = await fetch(`${OPERATION_URL}/${operationId}`, {
      headers: { "Authorization": `Bearer ${iamToken}` }
    });
    if (res.status === 401) {
      invalidateIamToken();
      iamToken = await getIamToken();
      res = await fetch(`${OPERATION_URL}/${operationId}`, {
        headers: { "Authorization": `Bearer ${iamToken}` }
      });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`SpeechKit poll failed ${res.status}: ${text}`);
    }

    const op = await res.json();
    if (!op.done) {
      logger.info("SpeechKit v3: pollRecognitionOnce — not ready yet", { meetingId: meeting.id, operationId });
      return { done: false };
    }
    if (op.error) {
      throw new Error(`SpeechKit error: ${JSON.stringify(op.error)}`);
    }

    // Готово — забираем результаты
    const chunks = await this.fetchRecognition(operationId, iamToken, meeting.id);
    logger.info("SpeechKit v3: recognition complete", { meetingId: meeting.id, chunksCount: chunks.length });

    if (chunks.length === 0) {
      logger.warn("SpeechKit v3: empty chunks, falling back to v2", { meetingId: meeting.id });
      const audioUri = `https://storage.yandexcloud.net/${this.bucket}/${meeting.artifacts.audioOriginalKey}`;
      const v2Result = await this.processMeetingV2({ meeting, project: null, iamToken: await getIamToken(), audioUri });
      return { done: true, jobId: v2Result.jobId, transcript: v2Result.transcript };
    }

    const transcript = this.parseTranscript(chunks, meeting);
    logger.info("SpeechKit v3: transcript parsed", {
      meetingId: meeting.id,
      phrases: transcript.phrases.length,
      speakers: new Set(transcript.phrases.map((p) => p.speakerId)).size
    });
    return { done: true, jobId: operationId, transcript };
  }

  /**
   * Синхронный полный прогон (используется только для локальной разработки / fallback).
   * В облачном деплое используйте startRecognition + pollRecognitionOnce.
   */
  async processMeeting({ meeting, project }) {
    const { operationId } = await this.startRecognition({ meeting });

    // Ждём завершения операции (до 25 минут, поллинг каждые 3 сек)
    const iamToken = await getIamToken();
    await this.waitOperation(operationId, 500, 3000, iamToken);

    const result = await this.pollRecognitionOnce({ meeting, operationId });
    if (!result.done) {
      throw new Error("SpeechKit: unexpected not-done after waitOperation");
    }
    if (!result.transcript) {
      // Fallback to v2 (already handled inside pollRecognitionOnce for empty chunks)
      const audioUri = `https://storage.yandexcloud.net/${this.bucket}/${meeting.artifacts.audioOriginalKey}`;
      return this.processMeetingV2({ meeting, project, iamToken: await getIamToken(), audioUri });
    }
    return { jobId: result.jobId, transcript: result.transcript };
  }

  /**
   * Ожидает завершения операции через operation API.
   * Возвращает когда done=true, бросает ошибку если op.error.
   */
  async waitOperation(operationId, maxAttempts, intervalMs, iamToken) {
    let token = iamToken;
    for (let i = 0; i < maxAttempts; i++) {
      await sleep(intervalMs);

      let res = await fetch(`${OPERATION_URL}/${operationId}`, {
        headers: { "Authorization": `Bearer ${token}` }
      });
      if (res.status === 401) {
        invalidateIamToken();
        token = await getIamToken();
        res = await fetch(`${OPERATION_URL}/${operationId}`, {
          headers: { "Authorization": `Bearer ${token}` }
        });
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`SpeechKit poll failed ${res.status}: ${text}`);
      }

      const op = await res.json();
      if (op.done) {
        if (op.error) {
          throw new Error(`SpeechKit error: ${JSON.stringify(op.error)}`);
        }
        return; // готово
      }
    }
    throw new Error("SpeechKit recognition timed out after 25 minutes");
  }

  /**
   * Забирает чанки через getRecognition endpoint (NDJSON stream).
   * Каждая строка — JSON объект с result.final или result.speakerLabels.
   */
  async fetchRecognition(operationId, iamToken, meetingId) {
    let token = iamToken;
    let res = await fetch(`${SPEECHKIT_V3_GET_URL}?operationId=${operationId}`, {
      headers: { "Authorization": `Bearer ${token}` }
    });
    if (res.status === 401) {
      invalidateIamToken();
      token = await getIamToken();
      res = await fetch(`${SPEECHKIT_V3_GET_URL}?operationId=${operationId}`, {
        headers: { "Authorization": `Bearer ${token}` }
      });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.error(`SpeechKit v3: getRecognition failed ${res.status} ${text}`, { meetingId });
      return [];
    }

    const body = await res.text();
    const chunks = [];

    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj;
      try { obj = JSON.parse(trimmed); } catch { continue; }

      const result = obj?.result ?? {};
      const final = result.final;
      if (!final) continue;

      const alts = final.alternatives ?? [];
      if (!alts.length) continue;

      const text = alts[0].text ?? "";
      if (!text.trim()) continue;

      chunks.push({
        // channelTag: "0" или "1" — основной источник разделения спикеров
        channelTag: final.channelTag ?? result.channelTag ?? "0",
        speakerTag: null, // speakerLabels в отдельных событиях, пока не используем
        alternatives: alts,
        words: alts[0].words ?? []
      });
    }

    return chunks;
  }

  // ── Fallback: v2 longRunningRecognize ──────────────────────────────────────
  async processMeetingV2({ meeting, iamToken, audioUri }) {
    const V2_URL = "https://transcribe.api.cloud.yandex.net/speech/stt/v2/longRunningRecognize";
    logger.info("SpeechKit v2 fallback: starting", { meetingId: meeting.id });

    const res = await fetch(V2_URL, {
      method: "POST",
      headers: { "Authorization": `Bearer ${iamToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        config: {
          specification: {
            languageCode: "ru-RU",
            model: "general:rc",
            audioEncoding: "LINEAR16_PCM",
            sampleRateHertz: 16000,
            audioChannelCount: 1,
            speakerLabeling: "ENABLED",
            rawResults: false,
            partialResults: false
          }
        },
        audio: { uri: audioUri }
      })
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`SpeechKit v2 fallback failed ${res.status}: ${text}`);
    }

    const op = await res.json();
    // v2 использует старый pollOperation — результат в op.response
    const v2Result = await this.pollOperationV2(op.id, 500, 3000);
    const rawChunks = Array.isArray(v2Result) ? v2Result : (v2Result?.chunks ?? []);

    logger.info("SpeechKit v2 fallback: done", { meetingId: meeting.id, chunks: rawChunks.length });
    return { jobId: op.id, transcript: this.parseTranscriptV2(rawChunks, meeting) };
  }

  async pollOperationV2(operationId, maxAttempts, intervalMs) {
    for (let i = 0; i < maxAttempts; i++) {
      await sleep(intervalMs);
      let iamToken = await getIamToken();
      let res = await fetch(`${OPERATION_URL}/${operationId}`, {
        headers: { "Authorization": `Bearer ${iamToken}` }
      });
      if (res.status === 401) {
        invalidateIamToken();
        iamToken = await getIamToken();
        res = await fetch(`${OPERATION_URL}/${operationId}`, {
          headers: { "Authorization": `Bearer ${iamToken}` }
        });
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`SpeechKit v2 poll failed ${res.status}: ${text}`);
      }
      const op = await res.json();
      if (op.done) {
        if (op.error) throw new Error(`SpeechKit v2 error: ${JSON.stringify(op.error)}`);
        const raw = op.response;
        return raw?.chunks ?? raw?.result?.chunks ?? (Array.isArray(raw) ? raw : []);
      }
    }
    throw new Error("SpeechKit v2 recognition timed out");
  }

  parseTranscriptV2(chunks, meeting) {
    const grouped = [];
    for (const chunk of chunks) {
      const text = chunk.alternatives?.[0]?.text ?? "";
      if (!text.trim()) continue;
      const speakerTag = chunk.speakerTag ?? chunk.channelTag ?? "1";
      const last = grouped.at(-1);
      if (last && last.speakerTag === speakerTag) {
        last.text += " " + text;
      } else {
        grouped.push({ speakerTag, text });
      }
    }
    const speakerIds = [...new Set(grouped.map((g) => g.speakerTag))].sort();
    const phrases = grouped.map((seg, index) => {
      const idx = speakerIds.indexOf(seg.speakerTag);
      return {
        speakerId: `speaker-${idx + 1}`,
        speakerLabel: `Спикер ${idx + 1}`,
        speakerTag: seg.speakerTag,
        detectedName: null,
        startTimeMs: index * 1000,
        endTimeMs: (index + 1) * 1000,
        text: seg.text
      };
    });
    const rawText = phrases.map((p) => `${p.speakerLabel}: ${p.text}`).join("\n");
    return { jobId: meeting.id, meetingId: meeting.id, rawText, phrases, generatedAt: new Date().toISOString() };
  }

  /**
   * Парсит чанки от SpeechKit v3 getRecognition.
   *
   * Формат чанка (после fetchRecognition):
   * {
   *   channelTag: "0" | "1",
   *   alternatives: [{ words: [{text, startTimeMs, endTimeMs}], text }],
   *   words: [{text, startTimeMs, endTimeMs}]
   * }
   *
   * Временны́е метки — числа в миллисекундах (не строки "1.234s" как в старом API).
   */
  parseTranscript(chunks, meeting) {
    if (!Array.isArray(chunks) || chunks.length === 0) {
      return { jobId: meeting.id, meetingId: meeting.id, rawText: "", phrases: [], generatedAt: new Date().toISOString() };
    }

    const grouped = [];
    for (const chunk of chunks) {
      const alt = chunk.alternatives?.[0];
      const text = alt?.text ?? "";
      if (!text.trim()) continue;

      const speakerTag = chunk.channelTag ?? "0";

      // Временны́е метки: числа в мс
      const words = chunk.words ?? alt?.words ?? [];
      const startMs = words.length ? (parseInt(words[0].startTimeMs ?? 0) || 0) : null;
      const endMs   = words.length ? (parseInt(words.at(-1).endTimeMs ?? 0) || 0) : null;

      const last = grouped.at(-1);
      if (last && last.speakerTag === speakerTag && startMs !== null && last.endMs !== null
          && startMs - last.endMs < 2000) {
        last.text += " " + text;
        last.endMs = endMs;
      } else {
        grouped.push({ speakerTag, text, startMs, endMs });
      }
    }

    const speakerIds = [...new Set(grouped.map((g) => g.speakerTag))].sort();

    const phrases = grouped.map((seg) => {
      const idx = speakerIds.indexOf(seg.speakerTag);
      return {
        speakerId: `speaker-${idx + 1}`,
        speakerLabel: `Спикер ${idx + 1}`,
        speakerTag: seg.speakerTag,
        detectedName: null,
        startTimeMs: seg.startMs ?? 0,
        endTimeMs: seg.endMs ?? 0,
        text: seg.text
      };
    });

    const rawText = phrases.map((p) => `${p.speakerLabel}: ${p.text}`).join("\n");

    return { jobId: meeting.id, meetingId: meeting.id, rawText, phrases, generatedAt: new Date().toISOString() };
  }
}
