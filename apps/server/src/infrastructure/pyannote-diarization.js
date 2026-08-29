/**
 * Клиент прод-сервиса диаризации (apps/diarization-service, Yandex Serverless
 * Container) — pyannote/speaker-diarization-3.1 + слияние кластеров по
 * эмбеддингу голоса, портировано из research/diarization-asr-lab.
 *
 * Асинхронно через YMQ, не напрямую по HTTP: Node (таймаут функции 60с)
 * только кладёт сообщение в очередь диаризации — дальше YMQ-триггер вызывает
 * контейнер по /process и держит соединение открытым на всё время обработки
 * ОДНОГО сообщения (до 3600с), что нужно для диаризации, которая длится
 * время, сравнимое с длиной встречи (RTF ~1x на CPU). Статус/результат — в
 * S3; getJobStatus/readRttm читают оттуда напрямую, не ходят в контейнер.
 *
 * Несколько очередей вместо одной: у YMQ-триггера нет режима "N воркеров на
 * одну очередь" (Yandex Cloud явно запрещает вешать второй триггер на ту же
 * очередь) — он последовательный consumer, держит только одно сообщение за
 * раз. Поэтому реальный параллелизм получаем через round-robin по нескольким
 * независимым очередям, у каждой свой триггер на тот же контейнер.
 */

import { signRequest } from "../shared/sign-v4.js";
import { logger } from "../shared/logger.js";

const YMQ_ENDPOINT = "https://message-queue.api.cloud.yandex.net";
const YMQ_REGION = "ru-central1";
const YMQ_SERVICE = "sqs";
const STATUS_PREFIX = "diarization-jobs";

export class PyannoteDiarization {
  /**
   * @param {{ queueUrls: string[], keyId: string, secret: string, artifactStorage: import("./yc-artifact-storage.js").YcArtifactStorage }}
   */
  constructor({ queueUrls, keyId, secret, artifactStorage }) {
    this.queues = (queueUrls ?? []).filter(Boolean).map((queueUrl) => {
      const url = new URL(queueUrl);
      return { queueUrl, host: url.host, path: url.pathname };
    });
    this.keyId = keyId;
    this.secret = secret;
    this.artifactStorage = artifactStorage;
    this._rrIndex = 0;
  }

  get available() {
    return this.queues.length > 0;
  }

  /**
   * Пишет "pending" в S3 и кладёт сообщение в очередь диаризации. Не ждёт
   * результата — обработка идёт асинхронно через YMQ-триггер на контейнере.
   * @returns {Promise<{ jobId: string }>}
   */
  async startJob({ meetingId, audioKey, minSpeakers = null, maxSpeakers = null }) {
    const jobId = meetingId;
    await this.artifactStorage.writeJson(statusKey(jobId), { status: "pending" });

    const queue = this.queues[this._rrIndex % this.queues.length];
    this._rrIndex += 1;

    const body = new URLSearchParams({
      Action: "SendMessage",
      MessageBody: JSON.stringify({ meetingId, audioKey, minSpeakers, maxSpeakers }),
      Version: "2012-11-05",
    }).toString();
    const contentType = "application/x-www-form-urlencoded";

    const sig = signRequest({
      method: "POST",
      host: queue.host,
      path: queue.path,
      headers: { "content-type": contentType },
      body,
      service: YMQ_SERVICE,
      region: YMQ_REGION,
      keyId: this.keyId,
      secret: this.secret,
    });

    const res = await fetch(`${YMQ_ENDPOINT}${queue.path}`, {
      method: "POST",
      headers: { host: queue.host, "content-type": contentType, ...sig },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Diarization queue SendMessage failed: ${res.status} ${text.slice(0, 200)}`);
    }

    logger.info("Diarization: job queued", { meetingId, jobId, queueUrl: queue.queueUrl });
    return { jobId };
  }

  /**
   * @returns {Promise<{ status: "pending"|"running"|"done"|"failed", rttmKey?: string, speakers?: number, error?: string }>}
   */
  async getJobStatus(jobId) {
    const status = await this.artifactStorage.readJson(statusKey(jobId));
    return status ?? { status: "pending" };
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

function statusKey(jobId) {
  return `${STATUS_PREFIX}/${jobId}/status.json`;
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
