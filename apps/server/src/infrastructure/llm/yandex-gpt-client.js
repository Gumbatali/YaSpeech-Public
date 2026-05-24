/**
 * Низкоуровневый клиент YandexGPT Foundation Models API.
 *
 * Ответственность:
 *   - HTTP-запрос + retry при 429/500
 *   - Авто-обновление IAM-токена при 401
 *   - Очистка markdown-обёртки из ответа
 *   - Логирование latency и token usage
 */

import { getIamToken, invalidateIamToken } from "../../shared/iam-token.js";
import { logger } from "../../shared/logger.js";

const GPT_URL = "https://llm.api.cloud.yandex.net/foundationModels/v1/completion";

// Задержки для exponential backoff (ms)
const RETRY_DELAYS = [1000, 3000, 8000];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Удаляет обёртку ```json ... ``` которую GPT иногда добавляет.
 */
function stripMarkdown(text) {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

export class YandexGptClient {
  constructor({ modelUri }) {
    this.modelUri = modelUri;
  }

  /**
   * Выполняет completion с автоматическим retry при ошибках сервера.
   *
   * @param {string} systemPrompt
   * @param {string} userPrompt
   * @param {{ temperature?: number, maxTokens?: number }} options
   * @returns {Promise<string>} - очищенный текст ответа
   */
  async complete(systemPrompt, userPrompt, options = {}) {
    const { temperature = 0.3, maxTokens = 4000 } = options;
    const startMs = Date.now();

    const body = JSON.stringify({
      modelUri: this.modelUri,
      completionOptions: { stream: false, temperature, maxTokens },
      messages: [
        { role: "system", text: systemPrompt },
        { role: "user", text: userPrompt }
      ]
    });

    let lastError;
    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_DELAYS[attempt - 1];
        logger.warn("YandexGPT: retry after error", { attempt, delay, error: lastError?.message });
        await sleep(delay);
      }

      try {
        let iamToken = await getIamToken();
        let res = await fetch(GPT_URL, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${iamToken}`,
            "Content-Type": "application/json"
          },
          body
        });

        // IAM токен протух — обновляем и повторяем
        if (res.status === 401) {
          invalidateIamToken();
          iamToken = await getIamToken();
          res = await fetch(GPT_URL, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${iamToken}`,
              "Content-Type": "application/json"
            },
            body
          });
        }

        // Сервер перегружен → retry
        if (res.status === 429 || res.status >= 500) {
          const errText = await res.text().catch(() => "");
          lastError = new Error(`YandexGPT ${res.status}: ${errText.slice(0, 200)}`);
          continue;
        }

        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          throw new Error(`YandexGPT failed ${res.status}: ${errText}`);
        }

        const data = await res.json();
        const raw = data.result?.alternatives?.[0]?.message?.text ?? "";
        const inputTokens = data.result?.usage?.inputTextTokens ?? 0;
        const outputTokens = data.result?.usage?.completionTokens ?? 0;

        logger.info("YandexGPT: complete", {
          latencyMs: Date.now() - startMs,
          inputTokens,
          outputTokens,
          temperature
        });

        return stripMarkdown(raw);

      } catch (e) {
        lastError = e;
        // Сетевые ошибки тоже ретраим
        if (attempt === RETRY_DELAYS.length) break;
      }
    }

    throw lastError ?? new Error("YandexGPT: all retries exhausted");
  }

  /**
   * Выполняет несколько completion запросов параллельно.
   * Используется для обработки чанков транскрипта.
   *
   * @param {Array<{system: string, user: string, options?: object}>} requests
   * @returns {Promise<string[]>}
   */
  async completeBatch(requests) {
    return Promise.all(
      requests.map(({ system, user, options }) => this.complete(system, user, options))
    );
  }

  /**
   * Безопасный JSON parse с логированием.
   */
  static parseJson(raw, fallback, label) {
    try {
      return JSON.parse(raw);
    } catch (e) {
      logger.error(`YandexGPT parse error [${label}]`, {
        error: e.message,
        preview: raw.slice(0, 400)
      });
      return fallback;
    }
  }
}
