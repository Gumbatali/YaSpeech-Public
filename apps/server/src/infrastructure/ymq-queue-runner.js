import { signRequest } from "../shared/sign-v4.js";
import { logger } from "../shared/logger.js";

const REGION   = "ru-central1";
const SERVICE  = "sqs";
const ENDPOINT = "https://message-queue.api.cloud.yandex.net";

/**
 * Отправляет задачу в YMQ через SQS-совместимый API.
 * Никаких npm-зависимостей — только fetch + HMAC-SHA256 (Node.js crypto).
 */
export class YmqQueueRunner {
  constructor({ queueUrl, keyId, secret }) {
    this.queueUrl = queueUrl;
    this.keyId    = keyId;
    this.secret   = secret;

    const url      = new URL(queueUrl);
    this.host      = url.host;
    this.path      = url.pathname;
  }

  /**
   * @param {string} taskId  — идентификатор задачи (напр. "meeting:abc123")
   * @param {Function} _fn   — колбэк для LocalQueueRunner (YMQ игнорирует)
   * @param {{ delaySeconds?: number, phase?: string | null }} [options]
   */
  async enqueue(taskId, _fn, options = {}) {
    const meetingId    = taskId.replace(/^meeting:/, "").replace(/:.*$/, "");
    const phase        = options.phase ?? null;
    const delaySeconds = options.delaySeconds ?? 0;
    const messageBody  = JSON.stringify({ meetingId, ...(phase ? { phase } : {}) });
    try {
      await this._send(messageBody, delaySeconds);
      logger.info("YMQ: message sent", { meetingId, phase, delaySeconds });
    } catch (err) {
      logger.error("YMQ: failed to enqueue meeting", { meetingId, phase, error: err.message });
      throw err;
    }
  }

  // Совместимость с LocalQueueRunner API
  async waitForIdle() {}

  // ── private ────────────────────────────────────────────────────────────────

  async _send(messageBody, delaySeconds = 0) {
    const params = new URLSearchParams({
      Action:      "SendMessage",
      MessageBody: messageBody,
      Version:     "2012-11-05",
    });

    if (delaySeconds > 0) {
      params.set("DelaySeconds", String(Math.min(delaySeconds, 900))); // SQS max = 900
    }

    const body        = params.toString();
    const contentType = "application/x-www-form-urlencoded";

    const sig = signRequest({
      method:  "POST",
      host:    this.host,
      path:    this.path,
      headers: { "content-type": contentType },
      body,
      service: SERVICE,
      region:  REGION,
      keyId:   this.keyId,
      secret:  this.secret,
    });

    const res = await fetch(`${ENDPOINT}${this.path}`, {
      method:  "POST",
      headers: { host: this.host, "content-type": contentType, ...sig },
      body,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`YMQ SendMessage failed: ${res.status} ${text}`);
    }
  }
}
