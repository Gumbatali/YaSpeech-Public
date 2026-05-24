/**
 * SmartAsrGateway — многоуровневый ASR с диаризацией.
 *
 * Стратегия:
 *   1. Транскрипция: Groq Whisper large-v3 (если GROQ_API_KEY) → SpeechKit (fallback)
 *   2. Диаризация: pyannote via HF (если HF_TOKEN) → LLM B2-pass (fallback, уже есть)
 *   3. Выравнивание: Whisper сегменты + pyannote временные метки → speaker-labeled phrases
 *
 * Интерфейс идентичен YcSpeechKitGateway → drop-in замена.
 */

import { GroqWhisperGateway } from "./groq-whisper-gateway.js";
import { PyannoteDiarization, alignTranscriptWithDiarization } from "./pyannote-diarization.js";
import { YcSpeechKitGateway } from "./yc-speech-kit-gateway.js";
import { logger } from "../shared/logger.js";

export class SmartAsrGateway {
  /**
   * @param {{
   *   groqApiKey?: string,
   *   hfToken?: string,
   *   speechKitBucket: string,
   *   artifactStorage: import("./yc-artifact-storage.js").YcArtifactStorage
   * }}
   */
  constructor({ groqApiKey, hfToken, speechKitBucket, artifactStorage }) {
    this.artifactStorage = artifactStorage;

    // Транскрипция
    if (groqApiKey) {
      this.transcriber = new GroqWhisperGateway({ apiKey: groqApiKey, artifactStorage });
      logger.info("SmartASR: using Groq Whisper large-v3 as primary transcriber");
    } else {
      this.transcriber = new YcSpeechKitGateway({ bucket: speechKitBucket });
      logger.info("SmartASR: using SpeechKit (no GROQ_API_KEY)");
    }

    // Диаризация
    this.diarizer = new PyannoteDiarization({ hfToken, artifactStorage });
    if (hfToken) {
      logger.info("SmartASR: pyannote diarization enabled");
    } else {
      logger.info("SmartASR: pyannote disabled (no HF_TOKEN), will use LLM diarization");
    }
  }

  /**
   * Главный метод — интерфейс идентичен SpeechKit gateway.
   */
  async processMeeting({ meeting, project }) {
    // ── Шаг 1: Транскрипция ──────────────────────────────────────────────────
    let transcriptResult;
    try {
      transcriptResult = await this.transcriber.processMeeting({ meeting, project });
    } catch (e) {
      if (this.transcriber instanceof GroqWhisperGateway) {
        logger.error("SmartASR: Groq failed, falling back to SpeechKit", { error: e.message });
        const fallback = new YcSpeechKitGateway({ bucket: this.speechKitBucket });
        transcriptResult = await fallback.processMeeting({ meeting, project });
      } else {
        throw e;
      }
    }

    const { jobId, transcript } = transcriptResult;

    // ── Шаг 2: Диаризация (только если использовали Groq) ───────────────────
    // SpeechKit уже возвращает speakerTag — не перетираем его
    if (
      this.diarizer.available &&
      this.transcriber instanceof GroqWhisperGateway &&
      transcript.phrases.some((p) => p._whisperSegment)
    ) {
      transcript.phrases = await this.applyDiarization(transcript, meeting);
    }

    // Убираем служебный флаг
    for (const p of transcript.phrases) {
      delete p._whisperSegment;
    }

    // ── Шаг 3: Пересчёт rawText после диаризации ────────────────────────────
    transcript.rawText = transcript.phrases
      .map((p) => `${p.speakerLabel}: ${p.text}`)
      .join("\n");

    return { jobId, transcript };
  }

  async applyDiarization(transcript, meeting) {
    logger.info("SmartASR: running pyannote diarization");

    const audioKey = meeting.artifacts.audioOriginalKey;
    const diarizationSegments = await this.diarizer.diarize(audioKey);

    if (!diarizationSegments?.length) {
      logger.warn("SmartASR: pyannote returned no segments, falling back to single-speaker");
      // Назначаем всем фразам Спикер 1
      return transcript.phrases.map((p) => ({
        ...p,
        speakerId: "speaker-1",
        speakerLabel: "Спикер 1",
      }));
    }

    // Выравниваем Whisper сегменты с временными метками pyannote
    const whisperSegments = transcript.phrases.map((p) => ({
      start: p.startTimeMs / 1000,
      end: p.endTimeMs / 1000,
      text: p.text,
    }));

    const aligned = alignTranscriptWithDiarization(
      whisperSegments,
      diarizationSegments
    );

    const speakerCount = new Set(aligned.map((p) => p.speakerId)).size;
    logger.info("SmartASR: diarization applied", {
      segments: aligned.length,
      speakers: speakerCount,
    });

    return aligned;
  }
}
