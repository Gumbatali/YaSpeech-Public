/**
 * Клиент прод-сервиса диаризации (apps/diarization-service, Yandex Serverless
 * Container) — pyannote/speaker-diarization-3.1 + слияние кластеров по
 * эмбеддингу голоса, портировано из research/diarization-asr-lab.
 *
 * Раньше здесь был вызов HuggingFace Inference API с обрезкой аудио до 24 МБ
 * и классом SmartAsrGateway, который на самом деле никогда не создавался в
 * make-deps.js — то есть pyannote в проде не запускался вообще, а разделение
 * на "Спикер 1/2" было побочным продуктом channelTag у SpeechKit. См.
 * research/diarization-asr-lab/CLAUDE.md и обсуждение находки в чате.
 *
 * Работа асинхронная (диаризация на CPU занимает время, сравнимое с длиной
 * встречи — RTF ~1x): startJob ставит задачу и возвращает jobId сразу,
 * getJobStatus поллится из meeting-pipeline-service.js по тому же паттерну,
 * что и SpeechKit-поллинг (см. pollAsrPhase).
 */

import { logger } from "../shared/logger.js";
import { getIamToken } from "../shared/iam-token.js";

export class PyannoteDiarization {
  /**
   * @param {{ serviceUrl: string, artifactStorage: import("./yc-artifact-storage.js").YcArtifactStorage }}
   */
  constructor({ serviceUrl, artifactStorage }) {
    this.serviceUrl = serviceUrl;
    this.artifactStorage = artifactStorage;
  }

  get available() {
    return Boolean(this.serviceUrl);
  }

  /**
   * Запускает диаризацию для аудиофайла из S3. Не ждёт результата.
   * @returns {Promise<{ jobId: string }>}
   */
  async startJob({ meetingId, audioKey, minSpeakers = null, maxSpeakers = null }) {
    // Контейнер требует IAM-авторизацию (не открыт публично, invoker-роль
    // выдана тому же SA, что у api/worker) — тот же getIamToken(), что
    // используется для других межсервисных вызовов внутри облака.
    const token = await getIamToken();
    const res = await fetch(`${this.serviceUrl}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ meetingId, audioKey, minSpeakers, maxSpeakers })
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Diarization service ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    logger.info("Diarization: job started", { meetingId, jobId: data.jobId });
    return data;
  }

  /**
   * @returns {Promise<{ status: "pending"|"running"|"done"|"failed", rttmKey?: string, speakers?: number, error?: string }>}
   */
  async getJobStatus(jobId) {
    const token = await getIamToken();
    const res = await fetch(`${this.serviceUrl}/jobs/${jobId}`, {
      headers: { "Authorization": `Bearer ${token}` }
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Diarization service ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  /**
   * Загружает готовый RTTM-результат и парсит его в сегменты диаризации.
   * @returns {Promise<DiarizationSegment[]>}
   * @typedef {{ speaker: string, start: number, stop: number }} DiarizationSegment
   */
  async readRttm(rttmKey) {
    const text = await this.artifactStorage.readText(rttmKey);
    return parseRttm(text);
  }
}

function parseRttm(text) {
  const segments = [];
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] !== "SPEAKER") continue;
    const start = Number(parts[3]);
    const duration = Number(parts[4]);
    const speaker = parts[7];
    segments.push({ speaker, start, stop: start + duration });
  }
  return segments;
}

// ────────────────────────────────────────────────────────────────────────────
// Alignment: combines ASR phrases (мс) with pyannote-сегментами (сек)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Переразмечает фразы ASR (speakerId/speakerLabel/speakerTag) по результату
 * диаризации. Текст, тайминги и прочие поля фраз не трогает.
 *
 * Алгоритм: для каждой фразы находим спикера с максимальным перекрытием по
 * времени среди сегментов диаризации.
 *
 * @param {Array<{ startTimeMs, endTimeMs, text, [key: string]: any }>} phrases
 * @param {Array<{ speaker, start, stop }>} diarizationSegments
 * @returns {Array<object>} те же фразы с обновлёнными speakerId/speakerLabel/speakerTag
 */
export function alignTranscriptWithDiarization(phrases, diarizationSegments) {
  const speakerIds = [...new Set(diarizationSegments.map((s) => s.speaker))].sort();
  const speakerMap = new Map(
    speakerIds.map((id, i) => [id, { newId: `speaker-${i + 1}`, label: `Спикер ${i + 1}`, tag: String(i) }])
  );

  return phrases.map((phrase) => {
    const startSec = (phrase.startTimeMs ?? 0) / 1000;
    const endSec = (phrase.endTimeMs ?? phrase.startTimeMs ?? 0) / 1000;
    const bestSpeaker = findDominantSpeaker(startSec, endSec, diarizationSegments);
    const mapped = speakerMap.get(bestSpeaker);

    return {
      ...phrase,
      speakerId: mapped?.newId ?? "speaker-1",
      speakerLabel: mapped?.label ?? "Спикер 1",
      speakerTag: mapped?.tag ?? "0"
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

  const entries = Object.entries(overlap);
  if (!entries.length) return "SPEAKER_00";

  return entries.sort((a, b) => b[1] - a[1])[0][0];
}
