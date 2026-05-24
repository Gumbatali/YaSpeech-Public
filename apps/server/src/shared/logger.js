/**
 * Простой структурированный логгер для Cloud Functions.
 * Пишет JSON в stdout — Yandex Cloud Logging подхватывает автоматически.
 * Уровни: debug | info | warn | error
 */

const LEVEL_NUM = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL = LEVEL_NUM[process.env.LOG_LEVEL] ?? LEVEL_NUM.info;

function log(level, message, context = {}) {
  if ((LEVEL_NUM[level] ?? 0) < MIN_LEVEL) return;

  const entry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...context,
  };

  // Cloud Logging читает JSON из stdout; stderr используем только для ошибок
  const out = level === "error" ? process.stderr : process.stdout;
  out.write(JSON.stringify(entry) + "\n");
}

export const logger = {
  debug: (msg, ctx)  => log("debug", msg, ctx),
  info:  (msg, ctx)  => log("info",  msg, ctx),
  warn:  (msg, ctx)  => log("warn",  msg, ctx),
  error: (msg, ctx)  => log("error", msg, ctx),
};
