/**
 * Groq Whisper large-v3 — ASR-провайдер для замены SpeechKit.
 *
 * Почему Groq Whisper:
 *   - Whisper large-v3 значительно точнее SpeechKit на шумных и многоголосных записях
 *   - Нативно поддерживает русский язык (обучен на 25%+ русских данных)
 *   - Бесплатный tier: 2 ч аудио/день, ~10x быстрее реального времени
 *   - Возвращает сегменты с временными метками → готово к диаризации
 *
 * Ограничение: Groq не делает speaker diarization самостоятельно.
 * Временные метки сегментов используются отдельно (→ pyannote-diarization.js).
 *
 * Лимит файла: 25 MB. Для длинных записей делаем WAV chunking.
 */

import { logger } from "../shared/logger.js";

const GROQ_API_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const MAX_BYTES = 24 * 1024 * 1024; // 24 MB — небольшой запас до лимита 25 MB

// ────────────────────────────────────────────────────────────────────────────
// WAV Utilities
// ────────────────────────────────────────────────────────────────────────────

/**
 * Читает базовые параметры из заголовка WAV.
 * Наши файлы всегда PCM 16-bit mono 16kHz — но читаем динамически.
 */
function parseWavHeader(buf) {
  if (buf.length < 44) throw new Error("WAV buffer too small");
  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bitsPerSample = buf.readUInt16LE(34);
  return { channels, sampleRate, bitsPerSample, headerSize: 44 };
}

/**
 * Пересобирает корректный WAV-заголовок для среза PCM-данных.
 */
function buildWavBuffer(pcmSlice, { channels, sampleRate, bitsPerSample }) {
  const dataSize = pcmSlice.length;
  const header = Buffer.allocUnsafe(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  header.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmSlice]);
}

/**
 * Нарезает WAV буфер на чанки ≤ maxBytes.
 * Каждый чанк — самостоятельный валидный WAV файл.
 *
 * @returns {Array<{ wavBuffer: Buffer, offsetSeconds: number, durationSeconds: number }>}
 */
function splitWav(wavBuf, maxBytes = MAX_BYTES) {
  if (wavBuf.length <= maxBytes) {
    const { sampleRate, bitsPerSample, channels, headerSize } = parseWavHeader(wavBuf);
    const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
    const durationSeconds = (wavBuf.length - headerSize) / bytesPerSecond;
    return [{ wavBuffer: wavBuf, offsetSeconds: 0, durationSeconds }];
  }

  const params = parseWavHeader(wavBuf);
  const { sampleRate, bitsPerSample, channels, headerSize } = params;
  const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
  const maxPcmBytes = maxBytes - headerSize;

  const pcm = wavBuf.slice(headerSize);
  const chunks = [];
  let offset = 0;

  while (offset < pcm.length) {
    const slice = pcm.slice(offset, offset + maxPcmBytes);
    const wav = buildWavBuffer(slice, params);
    const offsetSeconds = offset / bytesPerSecond;
    const durationSeconds = slice.length / bytesPerSecond;
    chunks.push({ wavBuffer: wav, offsetSeconds, durationSeconds });
    offset += maxPcmBytes;
  }

  logger.info("GroqWhisper: WAV split into chunks", { total: chunks.length });
  return chunks;
}

// ────────────────────────────────────────────────────────────────────────────
// Multipart builder (без npm-зависимостей)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Строит multipart/form-data тело вручную.
 * Node 18 fetch принимает Buffer как тело запроса.
 */
function buildMultipartBody(wavBuffer, fileName, boundary) {
  const textFields = [
    ["model", "whisper-large-v3"],
    ["language", "ru"],
    ["response_format", "verbose_json"],
    ["timestamp_granularities[]", "segment"],
  ];

  const parts = [];
  for (const [name, value] of textFields) {
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
      `${value}\r\n`
    ));
  }

  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
    `Content-Type: audio/wav\r\n\r\n`
  ));
  parts.push(wavBuffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  return Buffer.concat(parts);
}

// ────────────────────────────────────────────────────────────────────────────
// Gateway
// ────────────────────────────────────────────────────────────────────────────

export class GroqWhisperGateway {
  /**
   * @param {{ apiKey: string, artifactStorage: import("./yc-artifact-storage.js").YcArtifactStorage }}
   */
  constructor({ apiKey, artifactStorage }) {
    this.apiKey = apiKey;
    this.artifactStorage = artifactStorage;
  }

  async processMeeting({ meeting }) {
    logger.info("GroqWhisper: start", { meetingId: meeting.id });

    // 1. Скачиваем аудио из S3
    const audioKey = meeting.artifacts.audioOriginalKey;
    const audioStream = await this.artifactStorage.readStream(audioKey);
    const audioBuffer = await streamToBuffer(audioStream);

    logger.info("GroqWhisper: audio downloaded", {
      key: audioKey,
      sizeMb: (audioBuffer.length / 1024 / 1024).toFixed(1)
    });

    // 2. Распознаём (с chunking если нужно)
    const allSegments = await this.transcribeBuffer(audioBuffer, audioKey);

    // 3. Пакуем в наш формат
    const transcript = this.buildTranscript(allSegments, meeting);

    logger.info("GroqWhisper: done", {
      meetingId: meeting.id,
      segments: allSegments.length,
      chars: transcript.rawText.length
    });

    return { jobId: `groq-${Date.now()}`, transcript };
  }

  /**
   * Нарезает аудио на чанки (если нужно), отправляет каждый в Groq.
   * Возвращает объединённые сегменты с абсолютными временными метками.
   */
  async transcribeBuffer(audioBuffer, fileName) {
    // Определяем формат: если начинается с RIFF — это WAV, нарезаем
    const isWav = audioBuffer.slice(0, 4).toString("ascii") === "RIFF";
    const baseName = fileName.split("/").pop() ?? "audio.wav";

    if (isWav) {
      const chunks = splitWav(audioBuffer);
      if (chunks.length === 1) {
        return this.transcribeChunk(chunks[0].wavBuffer, baseName, 0);
      }

      // Параллельно обрабатываем чанки
      const results = await Promise.all(
        chunks.map(({ wavBuffer, offsetSeconds }, i) =>
          this.transcribeChunk(wavBuffer, `chunk${i}_${baseName}`, offsetSeconds)
        )
      );
      return results.flat();
    }

    // Не WAV (MP3, M4A) — отправляем как есть
    if (audioBuffer.length > MAX_BYTES) {
      logger.warn("GroqWhisper: file too large for non-WAV, truncating", {
        size: audioBuffer.length, limit: MAX_BYTES
      });
      audioBuffer = audioBuffer.slice(0, MAX_BYTES);
    }
    return this.transcribeChunk(audioBuffer, baseName, 0);
  }

  /**
   * Отправляет один чанк в Groq Whisper API.
   */
  async transcribeChunk(wavBuffer, fileName, offsetSeconds) {
    const boundary = `groq${Date.now().toString(16)}${Math.random().toString(16).slice(2, 6)}`;
    const body = buildMultipartBody(wavBuffer, fileName, boundary);

    const startMs = Date.now();
    const res = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Groq Whisper ${res.status}: ${text.slice(0, 300)}`);
    }

    const data = await res.json();
    const latencyMs = Date.now() - startMs;
    const audioDuration = data.duration ?? 0;

    logger.info("GroqWhisper: chunk done", {
      latencyMs,
      audioDuration: audioDuration.toFixed(1) + "s",
      realTimeFactor: audioDuration > 0 ? (latencyMs / 1000 / audioDuration).toFixed(2) : "?",
      segments: data.segments?.length ?? 0
    });

    // Сдвигаем временные метки на offset чанка
    return (data.segments ?? []).map((seg) => ({
      start: (seg.start ?? 0) + offsetSeconds,
      end: (seg.end ?? seg.start ?? 0) + offsetSeconds,
      text: (seg.text ?? "").trim(),
    })).filter((s) => s.text);
  }

  /**
   * Преобразует сегменты Groq в наш формат transcript.
   * Без диаризации — speakerId будет уточнён позже через pyannote или LLM.
   */
  buildTranscript(segments, meeting) {
    const phrases = segments.map((seg) => ({
      speakerId: "speaker-unknown",
      speakerLabel: "Спикер ?",
      detectedName: null,
      startTimeMs: Math.round(seg.start * 1000),
      endTimeMs: Math.round(seg.end * 1000),
      text: seg.text,
      // сохраняем для выравнивания с pyannote
      _whisperSegment: true
    }));

    const rawText = phrases.map((p) => p.text).join(" ");

    return {
      jobId: meeting.id,
      meetingId: meeting.id,
      rawText,
      phrases,
      transcriptionProvider: "groq/whisper-large-v3",
      generatedAt: new Date().toISOString()
    };
  }
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
