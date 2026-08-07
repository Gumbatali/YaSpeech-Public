/**
 * SmartAsrGateway — многоуровневый ASR с диаризацией.
 *
 * Стратегия:
 *   1. Транскрипция: Groq Whisper large-v3 (если GROQ_API_KEY) → SpeechKit (fallback)
 *   2. Диаризация: pyannote via HF (если HF_TOKEN) → LLM B2-pass (fallback, уже есть)
 *   3. Выравнивание: Whisper сегменты + pyannote временные метки → speaker-labeled phrases
 *
 * Контракт — синхронный: processMeeting() возвращает готовый транскрипт за один
 * вызов. Это НЕ полная замена YcSpeechKitGateway: у того есть ещё двухфазная
 * пара startRecognition() + pollRecognitionOnce() для случая, когда распознавание
 * длиннее таймаута функции. Pipeline различает оба вида по наличию
 * startRecognition (см. startAsrPhase), поэтому синхронный гейтвей обязан
 * укладываться в WORKER_TIMEOUT — deploy.sh поднимает его до 600s для smart.
 */

import { GroqWhisperGateway } from "./groq-whisper-gateway.js";
import { alignTranscriptWithDiarization } from "./pyannote-diarization.js";
import { makeDiarizer } from "./diarization/make-diarizer.js";
import { YcSpeechKitGateway } from "./yc-speech-kit-gateway.js";
import { logger } from "../shared/logger.js";

export class SmartAsrGateway {
  /**
   * @param {{
   *   groqApiKey?: string,
   *   speechKitBucket: string,
   *   artifactStorage: import("./yc-artifact-storage.js").YcArtifactStorage,
   *   env?: Record<string, string|undefined>,
   *   diarizer?: object
   * }}
   */
  constructor({ groqApiKey, speechKitBucket, artifactStorage, env = process.env, diarizer }) {
    this.artifactStorage = artifactStorage;
    this.speechKitBucket = speechKitBucket; // нужен для fallback при ошибке Groq

    // Транскрипция
    if (groqApiKey) {
      this.transcriber = new GroqWhisperGateway({ apiKey: groqApiKey, artifactStorage });
      logger.info("SmartASR: using Groq Whisper large-v3 as primary transcriber");
    } else {
      this.transcriber = new YcSpeechKitGateway({ bucket: speechKitBucket });
      logger.info("SmartASR: using SpeechKit (no GROQ_API_KEY)");
    }

    // Диаризация — бэкенд выбирается переменной DIARIZER (или внедряется в тестах).
    this.diarizer = diarizer ?? makeDiarizer({ env, artifactStorage });
    logger.info("SmartASR: diarizer configured", {
      backend: this.diarizer.backend,
      available: this.diarizer.available,
    });
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

    // ── Шаг 2: Диаризация ───────────────────────────────────────────────────
    //
    // Раньше здесь стояло условие «только если транскрибировали Groq»: считалось,
    // что SpeechKit сам вернёт speakerTag и перетирать его не нужно.
    //
    // Замер 2026-08-05 это опроверг: при speakerLabeling=ENABLED поле speakerTag
    // в ответе SpeechKit STT v3 не приходит вообще — ни на русском, ни на
    // английском. Есть только channelTag 0/1, и оба канала покрывают запись
    // целиком, то есть это потоки распознавания, а не говорящие. Все фразы
    // сваливались в одного-двух «спикеров».
    //
    // Поэтому внешний диаризатор нужен при ЛЮБОМ ASR. Если он настроен —
    // применяем его и к SpeechKit тоже.
    if (this.diarizer.available && transcript.phrases.length > 0) {
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
    logger.info("SmartASR: running diarization", { backend: this.diarizer.backend });

    const audioKey = meeting.artifacts.audioOriginalKey;
    const diarizationSegments = await this.diarizer.diarize(audioKey);

    if (!diarizationSegments?.length) {
      logger.warn("SmartASR: diarizer returned no segments, falling back to single-speaker", {
        backend: this.diarizer.backend,
      });
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
