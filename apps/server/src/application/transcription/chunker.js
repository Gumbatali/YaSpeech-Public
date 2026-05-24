/**
 * Разбивает транскрипт на перекрывающиеся чанки для параллельной обработки GPT.
 *
 * Стратегия:
 *   - Нарезаем по репликам (не по символам) — не разрываем слова говорящего
 *   - Целевой размер чанка ~3000 символов
 *   - Перекрытие ~400 символов (2-3 реплики) — не теряем контекст на стыках
 *
 * Мотивация:
 *   YandexGPT context window ~8192 tokens ≈ 32 000 символов.
 *   Для безопасной работы используем MAX_CHUNK_CHARS = 20 000.
 *   Встречи > 1 часа дают 40 000+ символов транскрипта → нужна нарезка.
 */

const TARGET_CHUNK_CHARS = 3_000;
const OVERLAP_CHARS = 400;
const MAX_CHUNK_CHARS = 20_000;

/**
 * @typedef {{ speakerId: string, speakerLabel: string, text: string, startTimeMs?: number, endTimeMs?: number }} Phrase
 */

/**
 * Преобразует массив реплик в текстовую строку для передачи в LLM.
 * @param {Phrase[]} phrases
 * @returns {string}
 */
export function phrasesToText(phrases) {
  return phrases.map((p) => `${p.speakerLabel}: ${p.text}`).join("\n");
}

/**
 * Нарезает массив реплик на перекрывающиеся чанки.
 * Если весь транскрипт умещается в MAX_CHUNK_CHARS — возвращает один чанк.
 *
 * @param {Phrase[]} phrases
 * @returns {Array<{ index: number, total: number, phrases: Phrase[], text: string }>}
 */
export function chunkPhrases(phrases) {
  const fullText = phrasesToText(phrases);

  // Короткий транскрипт — без нарезки
  if (fullText.length <= MAX_CHUNK_CHARS) {
    return [{ index: 0, total: 1, phrases, text: fullText }];
  }

  const chunks = [];
  let start = 0;

  while (start < phrases.length) {
    let end = start;
    let charCount = 0;

    // Набираем реплики до TARGET_CHUNK_CHARS
    while (end < phrases.length && charCount < TARGET_CHUNK_CHARS) {
      charCount += phrases[end].text.length + phrases[end].speakerLabel.length + 2;
      end++;
    }

    if (end === start) end = start + 1; // минимум одна реплика
    if (end > phrases.length) end = phrases.length;

    const chunkPhraseSlice = phrases.slice(start, end);
    chunks.push({
      index: chunks.length,
      total: -1, // заполним ниже
      phrases: chunkPhraseSlice,
      text: phrasesToText(chunkPhraseSlice)
    });

    // Следующий чанк начинается с отступом назад на OVERLAP_CHARS
    let overlapChars = 0;
    let overlapBack = end;
    while (overlapBack > start + 1 && overlapChars < OVERLAP_CHARS) {
      overlapBack--;
      overlapChars += phrases[overlapBack].text.length;
    }
    start = overlapBack;
  }

  // Проставляем total
  const total = chunks.length;
  for (const c of chunks) c.total = total;

  return chunks;
}

/**
 * Объединяет результаты обработки чанков в единый исправленный текст.
 * Удаляем дублирующиеся реплики из перекрытий.
 *
 * @param {Array<{ phrases: Phrase[], correctedLines: string[] }>} chunkResults
 * @returns {string}
 */
export function mergeChunkResults(chunkResults) {
  const seen = new Set();
  const lines = [];

  for (const { correctedLines } of chunkResults) {
    for (const line of correctedLines) {
      const key = line.trim().toLowerCase().slice(0, 80);
      if (!seen.has(key)) {
        seen.add(key);
        lines.push(line.trim());
      }
    }
  }

  return lines.join("\n");
}
