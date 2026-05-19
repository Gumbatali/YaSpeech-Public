import { signRequest } from "../shared/sign-v4.js";

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

  enqueue(taskId, _fn) {
    const meetingId = taskId.replace("meeting:", "");
    this._send(JSON.stringify({ meetingId })).catch(
      (err) => console.error("YMQ send error:", err)
    );
  }

  // Совместимость с LocalQueueRunner API
  async waitForIdle() {}

  // ── private ────────────────────────────────────────────────────────────────

  async _send(messageBody) {
    const params = new URLSearchParams({
      Action:      "SendMessage",
      MessageBody: messageBody,
      Version:     "2012-11-05",
    });
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
