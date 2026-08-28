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
// Открытые модели (Qwen/DeepSeek/gpt-oss) в Yandex Cloud доступны ТОЛЬКО
// через OpenAI-совместимый эндпоинт — обычный /foundationModels/v1/completion
// отвечает 400 "Model is not available via gRPC API" для них.
const OPENAI_COMPAT_URL = "https://llm.api.cloud.yandex.net/v1/chat/completions";
const OPENAI_COMPAT_MODEL_RE = /^(qwen|deepseek|gpt-oss)/i;

// Задержки для exponential backoff (ms)
const RETRY_DELAYS = [1000, 3000, 8000];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isOpenAiCompatModel(modelUri) {
  // modelUri = "gpt://<folderId>/<model>/latest"
  const modelName = modelUri.split("/")[3] ?? "";
  return OPENAI_COMPAT_MODEL_RE.test(modelName);
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
    this.openAiCompat = isOpenAiCompatModel(modelUri);
    // modelUri = "gpt://<folderId>/<model>/latest" — folderId нужен
    // отдельным заголовком x-folder-id для OpenAI-совместимого эндпоинта
    this.folderId = modelUri.split("/")[2] ?? "";
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

    const url = this.openAiCompat ? OPENAI_COMPAT_URL : GPT_URL;
    const body = this.openAiCompat
      ? JSON.stringify({
          model: this.modelUri,
          temperature,
          max_tokens: maxTokens,
          // Qwen/DeepSeek — reasoning-модели, по умолчанию тратят maxTokens
          // на reasoning_content (цепочку рассуждений) ДО настоящего
          // ответа — на наших промптах (2000-4500 токенов, рассчитано под
          // обычные, не reasoning, модели) бюджет кончался раньше, чем
          // модель доходила до content, и он оставался пустым.
          // reasoning_effort: "none" отключает эту фазу целиком.
          reasoning_effort: "none",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
          ]
        })
      : JSON.stringify({
          modelUri: this.modelUri,
          completionOptions: { stream: false, temperature, maxTokens },
          messages: [
            { role: "system", text: systemPrompt },
            { role: "user", text: userPrompt }
          ]
        });
    const buildHeaders = (iamToken) => this.openAiCompat
      ? { "Authorization": `Bearer ${iamToken}`, "Content-Type": "application/json", "x-folder-id": this.folderId }
      : { "Authorization": `Bearer ${iamToken}`, "Content-Type": "application/json" };

    let lastError;
    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_DELAYS[attempt - 1];
        logger.warn("YandexGPT: retry after error", { attempt, delay, error: lastError?.message });
        await sleep(delay);
      }

      try {
        let iamToken = await getIamToken();
        let res = await fetch(url, { method: "POST", headers: buildHeaders(iamToken), body });

        // IAM токен протух — обновляем и повторяем
        if (res.status === 401) {
          invalidateIamToken();
          iamToken = await getIamToken();
          res = await fetch(url, { method: "POST", headers: buildHeaders(iamToken), body });
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
        const raw = this.openAiCompat
          ? (data.choices?.[0]?.message?.content ?? "")
          : (data.result?.alternatives?.[0]?.message?.text ?? "");
        const inputTokens = this.openAiCompat
          ? (data.usage?.prompt_tokens ?? 0)
          : (data.result?.usage?.inputTextTokens ?? 0);
        const outputTokens = this.openAiCompat
          ? (data.usage?.completion_tokens ?? 0)
          : (data.result?.usage?.completionTokens ?? 0);

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
   * Выполняет несколько completion запросов с ограничением параллелизма.
   * Используется для обработки чанков транскрипта.
   * Лимит 3 одновременных запроса — предотвращает 429 при длинных встречах.
   *
   * @param {Array<{system: string, user: string, options?: object}>} requests
   * @param {number} concurrency — макс. параллельных запросов (default: 3)
   * @returns {Promise<string[]>}
   */
  async completeBatch(requests, concurrency = 3) {
    const results = new Array(requests.length);
    let index = 0;

    async function worker(self) {
      while (index < requests.length) {
        const i = index++;
        const { system, user, options } = requests[i];
        results[i] = await self.complete(system, user, options);
      }
    }

    const workers = Array.from(
      { length: Math.min(concurrency, requests.length) },
      () => worker(this)
    );
    await Promise.all(workers);
    return results;
  }

  /**
   * Безопасный JSON parse с логированием.
   */
  static parseJson(raw, fallback, label) {
    // Пробуем напрямую, потом стрипаем markdown-обёртку ```json...```
    const candidates = [
      raw,
      stripMarkdown(raw),
      // Если GPT вернул текст с JSON внутри — извлекаем первый {...} или [...]
      (raw.match(/(\{[\s\S]*\}|\[[\s\S]*\])/)?.[0] ?? "")
    ];
    for (const candidate of candidates) {
      if (!candidate.trim()) continue;
      try {
        return JSON.parse(candidate);
      } catch {
        // пробуем следующий вариант
      }
    }
    logger.error(`YandexGPT parse error [${label}]: ${raw.slice(0, 200)}`);
    return fallback;
  }
}
