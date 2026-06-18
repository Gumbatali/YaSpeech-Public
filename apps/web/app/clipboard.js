/**
 * Копирование текста в буфер обмена с fallback для небезопасного контекста.
 *
 * `navigator.clipboard` доступен ТОЛЬКО в secure context (HTTPS / localhost).
 * Статика раздаётся из Object Storage website-хостинга по HTTP, где
 * `navigator.clipboard === undefined` — поэтому нужен legacy-путь через
 * `document.execCommand("copy")` со скрытой textarea.
 *
 * @param {string} text
 * @returns {Promise<void>} резолвится при успехе, реджектится при провале обоих путей
 */
export async function copyText(text) {
  // Secure context — современный API
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // NotAllowedError / отказ браузера — падаем в legacy-путь ниже
    }
  }

  if (copyViaExecCommand(text)) return;

  throw new Error("Браузер заблокировал копирование. Скопируйте текст вручную.");
}

/**
 * Legacy-копирование через скрытую textarea + execCommand.
 * Работает по HTTP, где Clipboard API недоступен.
 *
 * @param {string} text
 * @returns {boolean} true — успешно скопировано
 */
function copyViaExecCommand(text) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  // Убираем из потока и с экрана, не вызывая скролл/зум на мобильных
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  textarea.style.opacity = "0";

  document.body.appendChild(textarea);
  try {
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}
