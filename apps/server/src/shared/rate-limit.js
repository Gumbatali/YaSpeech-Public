/**
 * Простой in-memory rate limiter (sliding window) для auth-эндпоинтов.
 *
 * Ограничение: серверлес-инстанс может быть пересоздан YC в любой момент,
 * так что это best-effort защита, а не гарантия — но в пределах одного
 * прогретого инстанса (типичный случай при повторных запросах атакующего)
 * она реально режет brute-force и спам регистраций.
 */
const buckets = new Map();

function pruneOld(timestamps, windowMs, now) {
  return timestamps.filter((t) => now - t < windowMs);
}

/**
 * @param {string} key           уникальный ключ (например `${ip}:${login}`)
 * @param {number} maxAttempts   сколько попыток разрешено в окне
 * @param {number} windowMs      размер окна в мс
 * @returns {boolean} true, если попытка разрешена (и уже засчитана)
 */
export function tryConsumeRateLimit(key, maxAttempts, windowMs, now = Date.now()) {
  const existing = buckets.get(key) ?? [];
  const recent = pruneOld(existing, windowMs, now);

  if (recent.length >= maxAttempts) {
    buckets.set(key, recent);
    return false;
  }

  recent.push(now);
  buckets.set(key, recent);
  return true;
}

export function requestIp(request) {
  const forwarded = request.headers["x-forwarded-for"];
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.socket?.remoteAddress ?? "unknown";
}

/** Только для тестов: сбрасывает состояние лимитера между независимыми тест-серверами. */
export function resetRateLimits() {
  buckets.clear();
}
