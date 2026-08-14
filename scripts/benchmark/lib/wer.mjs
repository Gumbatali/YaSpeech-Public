/**
 * WER / CER для русского ASR. Без зависимостей.
 *
 * WER (Word Error Rate)      = (S + D + I) / N   по словам
 * CER (Character Error Rate) = (S + D + I) / N   по символам
 * где S — замены, D — удаления, I — вставки, N — число токенов в эталоне.
 *
 * Нормализация эталона и гипотезы делается одинаково, иначе метрика врёт.
 */

/**
 * Приводит русский текст к каноничной форме для сравнения:
 *   - нижний регистр, ё → е
 *   - убираем метки спикеров вида "Спикер 1:" в начале строки
 *   - выкидываем пунктуацию, схлопываем пробелы
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeRu(text) {
  if (!text) return "";
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/^[^\n:]{1,32}:\s/gm, " ") // "Спикер 1: " / "Иван: " в начале строки
    .replace(/[^a-zа-я0-9\s-]/g, " ") // оставляем буквы/цифры/дефис
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {string} text
 * @returns {string[]} список слов после нормализации
 */
export function tokenize(text) {
  const normalized = normalizeRu(text);
  return normalized.length === 0 ? [] : normalized.split(" ");
}

/**
 * Расстояние Левенштейна на уровне токенов с подсчётом S/D/I.
 * O(n*m) память по строке, но плоские Int32Array вместо (n+1)x(m+1) массивов
 * JS-объектов: на полной 36-минутной встрече (n≈8000, m≈6000) объектное
 * представление уходит в OOM на 4 ГБ heap до завершения — проверено вживую
 * 2026-08-11. Типизированные массивы держат тот же расчёт в сотнях МБ.
 *
 * @param {string[]} ref эталонные токены
 * @param {string[]} hyp распознанные токены
 * @returns {{ substitutions: number, deletions: number, insertions: number, distance: number }}
 */
export function alignTokens(ref, hyp) {
  const n = ref.length;
  const m = hyp.length;
  const width = m + 1;
  const cells = (n + 1) * width;

  // dp[i*width+j] = (расстояние, S, D, I) для ref[0..i) vs hyp[0..j)
  const dist = new Int32Array(cells);
  const subs = new Int32Array(cells);
  const dels = new Int32Array(cells);
  const inss = new Int32Array(cells);

  for (let i = 0; i <= n; i += 1) {
    dist[i * width] = i;
    dels[i * width] = i;
  }
  for (let j = 0; j <= m; j += 1) {
    dist[j] = j;
    inss[j] = j;
  }

  for (let i = 1; i <= n; i += 1) {
    const row = i * width;
    const prevRow = (i - 1) * width;
    for (let j = 1; j <= m; j += 1) {
      if (ref[i - 1] === hyp[j - 1]) {
        dist[row + j] = dist[prevRow + j - 1];
        subs[row + j] = subs[prevRow + j - 1];
        dels[row + j] = dels[prevRow + j - 1];
        inss[row + j] = inss[prevRow + j - 1];
        continue;
      }
      const sub = dist[prevRow + j - 1];
      const del = dist[prevRow + j];
      const ins = dist[row + j - 1];
      const min = Math.min(sub, del, ins);
      dist[row + j] = min + 1;

      if (min === sub) {
        subs[row + j] = subs[prevRow + j - 1] + 1;
        dels[row + j] = dels[prevRow + j - 1];
        inss[row + j] = inss[prevRow + j - 1];
      } else if (min === del) {
        subs[row + j] = subs[prevRow + j];
        dels[row + j] = dels[prevRow + j] + 1;
        inss[row + j] = inss[prevRow + j];
      } else {
        subs[row + j] = subs[row + j - 1];
        dels[row + j] = dels[row + j - 1];
        inss[row + j] = inss[row + j - 1] + 1;
      }
    }
  }

  const last = n * width + m;
  return {
    substitutions: subs[last],
    deletions: dels[last],
    insertions: inss[last],
    distance: dist[last]
  };
}

/**
 * Считает WER и CER между эталоном и гипотезой.
 *
 * @param {string} reference эталонный текст
 * @param {string} hypothesis распознанный текст
 * @returns {{
 *   wer: number, cer: number,
 *   refWords: number, hypWords: number,
 *   substitutions: number, deletions: number, insertions: number
 * }}
 */
export function scoreTranscript(reference, hypothesis) {
  const refWords = tokenize(reference);
  const hypWords = tokenize(hypothesis);
  const wordAlign = alignTokens(refWords, hypWords);
  const wer = refWords.length === 0
    ? (hypWords.length === 0 ? 0 : 1)
    : wordAlign.distance / refWords.length;

  const refChars = [...normalizeRu(reference).replace(/\s/g, "")];
  const hypChars = [...normalizeRu(hypothesis).replace(/\s/g, "")];
  const charAlign = alignTokens(refChars, hypChars);
  const cer = refChars.length === 0
    ? (hypChars.length === 0 ? 0 : 1)
    : charAlign.distance / refChars.length;

  return {
    wer,
    cer,
    refWords: refWords.length,
    hypWords: hypWords.length,
    substitutions: wordAlign.substitutions,
    deletions: wordAlign.deletions,
    insertions: wordAlign.insertions
  };
}
