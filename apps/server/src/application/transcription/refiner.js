/**
 * Ядро refine-пайплайна: LLM-коррекция расшифровки по line-ID-протоколу.
 *
 * Протокол обмена с LLM (вместо JSON — выбран по бенчмарку
 * scripts/experiments/llm-refine-bench, 100% compliance в 32 вызовах):
 *   вход:  [N] Спикер X: текст с ошибками ASR
 *   выход: [N] исправленный текст
 *
 * Решает проблемы старого A2-пайплайна:
 *   - обрыв вывода детектится по отсутствующим ID (а не тихий fallback на raw)
 *   - выравнивание 1:1 на исходные phrases → таймкоды и спикеры сохраняются
 *   - merge перекрытий не нужен — чанки не перекрываются, контекст передаётся
 *     отдельным блоком «только для чтения»
 *   - детерминированный валидатор чисел/дат ловит подмену фактов
 *     (Lite в бенчмарке один раз заменил «двадцатого» на «двадцать первого»)
 */

// Бюджет чанка в символах. Lite держит 32k токенов контекста;
// 8000 симв ≈ 3-4k токенов входа + столько же на выход — с запасом.
const CHUNK_CHARS = 8_000;
// Сколько финальных реплик предыдущего чанка показываем как контекст
const CONTEXT_PHRASES = 2;

/**
 * Нарезает phrases на НЕперекрывающиеся чанки с глобальными line-ID.
 * ID — 1-based индекс реплики во всём транскрипте (стабилен между чанками).
 *
 * @param {Array<{speakerLabel: string, text: string}>} phrases
 * @param {{ chunkChars?: number }} [options]
 * @returns {Array<{ ids: number[], lines: string[], contextLines: string[] }>}
 */
export function buildRefineChunks(phrases, { chunkChars = CHUNK_CHARS } = {}) {
  const chunks = [];
  let current = { ids: [], lines: [], contextLines: [] };
  let currentChars = 0;

  for (let i = 0; i < phrases.length; i++) {
    const phrase = phrases[i];
    const line = `[${i + 1}] ${phrase.speakerLabel}: ${phrase.text}`;

    if (currentChars + line.length > chunkChars && current.ids.length > 0) {
      chunks.push(current);
      // Контекст следующего чанка — хвост предыдущего (только для чтения)
      const tail = current.ids.slice(-CONTEXT_PHRASES);
      current = {
        ids: [],
        lines: [],
        contextLines: tail.map((id) => `${phrases[id - 1].speakerLabel}: ${phrases[id - 1].text}`)
      };
      currentChars = 0;
    }

    current.ids.push(i + 1);
    current.lines.push(line);
    currentChars += line.length;
  }

  if (current.ids.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Парсит ответ LLM в формате "[N] текст".
 * Строки без валидного ID игнорируются; префикс "Спикер N:" вычищается,
 * если модель его всё-таки включила.
 *
 * @param {string} raw - сырой ответ модели
 * @param {number[]} expectedIds
 * @returns {{ byId: Map<number, string>, missingIds: number[] }}
 */
export function parseRefinedLines(raw, expectedIds) {
  const byId = new Map();
  for (const line of (raw ?? "").split("\n")) {
    const m = line.trim().match(/^\[(\d+)\]\s*(.*)$/);
    if (!m) continue;
    const text = m[2].replace(/^Спикер\s*\d+\s*:\s*/i, "").trim();
    if (text) byId.set(Number(m[1]), text);
  }
  const missingIds = expectedIds.filter((id) => !byId.has(id));
  return { byId, missingIds };
}

// ── Валидатор чисел и дат ──────────────────────────────────────────────────
//
// Сравнивает мультимножества числовых ЗНАЧЕНИЙ входа и выхода строки.
// Слова-числительные парсятся в значения, чтобы легитимные преобразования
// («м триста пятьдесят» → «М350») проходили, а подмены («двадцатого» →
// «двадцать первого», 20 ≠ 21) — отклонялись.

const NUMBER_WORDS = new Map(Object.entries({
  // количественные + порядковые приводим к одному значению (по основе)
  "ноль": 0, "нол": 0,
  "один": 1, "одна": 1, "одно": 1, "перв": 1,
  "два": 2, "две": 2, "втор": 2,
  "три": 3, "трет": 3, "трех": 3, "трём": 3, "трем": 3,
  "четыре": 4, "четвер": 4, "четырех": 4, "четырёх": 4,
  "пять": 5, "пят": 5,
  "шесть": 6, "шест": 6,
  "семь": 7, "седьм": 7, "сем": 7,
  "восемь": 8, "восьм": 8, "восем": 8,
  "девять": 9, "девят": 9,
  "десять": 10, "десят": 10,
  "одиннадцат": 11, "двенадцат": 12, "тринадцат": 13, "четырнадцат": 14,
  "пятнадцат": 15, "шестнадцат": 16, "семнадцат": 17, "восемнадцат": 18,
  "девятнадцат": 19,
  "двадцат": 20, "тридцат": 30, "сорок": 40, "сороков": 40,
  "пятьдесят": 50, "пятидесят": 50, "шестьдесят": 60, "шестидесят": 60,
  "семьдесят": 70, "семидесят": 70, "восемьдесят": 80, "восьмидесят": 80,
  "девяносто": 90, "девяност": 90,
  "сто": 100, "сот": 100, "ста": 100,
  "двести": 200, "двухсот": 200, "триста": 300, "трехсот": 300, "трёхсот": 300,
  "четыреста": 400, "четырехсот": 400, "пятьсот": 500, "пятисот": 500,
  "шестьсот": 600, "шестисот": 600, "семьсот": 700, "семисот": 700,
  "восемьсот": 800, "восьмисот": 800, "девятьсот": 900, "девятисот": 900,
  "тысяч": 1000, "тыс": 1000,
  "миллион": 1e6, "мильон": 1e6, "млн": 1e6,
  "миллиард": 1e9, "млрд": 1e9
}));

// Длинные основы раньше коротких, чтобы "пятнадцат" не матчился как "пят"
const NUMBER_STEMS = [...NUMBER_WORDS.keys()].sort((a, b) => b.length - a.length);

function wordToValue(word) {
  for (const stem of NUMBER_STEMS) {
    if (word.startsWith(stem)) return NUMBER_WORDS.get(stem);
  }
  return null;
}

/**
 * Извлекает мультимножество числовых значений из текста.
 * Цифры — как есть; слова-числительные собираются стандартным групповым
 * алгоритмом: «один миллион восемьсот тысяч» → 1×1e6 + 800×1000 = 1 800 000,
 * «двадцать первого» → 21, «триста пятьдесят» → 350.
 *
 * @param {string} text
 * @returns {number[]} отсортированный список значений
 */
export function extractNumericValues(text) {
  const values = [];
  const tokens = (text ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^a-zа-я0-9]+/)
    .filter(Boolean);

  let total = null;     // накопленное с учётом множителей (миллионы, тысячи)
  let group = null;     // текущая группа < 1000 (сто двадцать пять)
  let lastAdded = null; // последний компонент группы — контроль убывания

  const flush = () => {
    if (total !== null || group !== null) {
      values.push((total ?? 0) + (group ?? 0));
    }
    total = null;
    group = null;
    lastAdded = null;
  };

  for (const token of tokens) {
    // Цифры (в т.ч. внутри марок: "м350" → 350, "135-я" → 135)
    const digitMatches = token.match(/\d+/g);
    if (digitMatches) {
      flush();
      for (const d of digitMatches) values.push(Number(d));
      continue;
    }

    const v = wordToValue(token);
    if (v === null) { flush(); continue; }

    if (v >= 1000) {
      // Множитель: «тысяч» без группы = 1000 («тысяча человек»)
      total = (total ?? 0) + (group ?? 1) * v;
      group = null;
      lastAdded = null;
    } else if (group === null) {
      group = v;
      lastAdded = v;
    } else if (v < lastAdded) {
      // Убывающая последовательность внутри группы: сто + двадцать + один
      group += v;
      lastAdded = v;
    } else {
      // Не убывает — это уже новое число («пять шесть» = 5 и 6)
      flush();
      group = v;
      lastAdded = v;
    }
  }
  flush();
  return values.sort((a, b) => a - b);
}

/**
 * Проверяет, что коррекция не изменила числовые факты.
 * Совпадение мультимножеств значений → true.
 *
 * @param {string} originalText
 * @param {string} refinedText
 * @returns {boolean} true — числа сохранены, false — расхождение
 */
export function numbersPreserved(originalText, refinedText) {
  const a = extractNumericValues(originalText);
  const b = extractNumericValues(refinedText);
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/**
 * Применяет результаты коррекции чанка к phrases с валидацией.
 * Возвращает новые phrase-объекты (исходные не мутируются).
 *
 * @param {Array<object>} phrases - все phrases транскрипта
 * @param {Map<number, string>} byId - id (1-based) → исправленный текст
 * @returns {{ phrases: Array<object>, applied: number, rejectedByValidator: number }}
 */
export function applyRefinedLines(phrases, byId) {
  let applied = 0;
  let rejectedByValidator = 0;

  const next = phrases.map((phrase, i) => {
    const refined = byId.get(i + 1);
    if (refined === undefined) return phrase;

    if (!numbersPreserved(phrase.text, refined)) {
      rejectedByValidator++;
      return { ...phrase, refined: false, refineRejected: "numbers" };
    }

    if (refined === phrase.text) {
      return { ...phrase, refined: false };
    }

    applied++;
    return { ...phrase, originalText: phrase.text, text: refined, refined: true };
  });

  return { phrases: next, applied, rejectedByValidator };
}
