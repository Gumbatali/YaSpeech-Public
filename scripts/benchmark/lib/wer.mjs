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
 * O(n*m) память по строке — достаточно для расшифровок до десятков тысяч слов.
 *
 * @param {string[]} ref эталонные токены
 * @param {string[]} hyp распознанные токены
 * @returns {{ substitutions: number, deletions: number, insertions: number, distance: number }}
 */
export function alignTokens(ref, hyp) {
  const n = ref.length;
  const m = hyp.length;

  // dp[i][j] = (расстояние, S, D, I) для ref[0..i) vs hyp[0..j)
  const dist = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  const ops = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(null));

  for (let i = 0; i <= n; i += 1) {
    dist[i][0] = i;
    ops[i][0] = { s: 0, d: i, ins: 0 };
  }
  for (let j = 0; j <= m; j += 1) {
    dist[0][j] = j;
    ops[0][j] = { s: 0, d: 0, ins: j };
  }

  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      if (ref[i - 1] === hyp[j - 1]) {
        dist[i][j] = dist[i - 1][j - 1];
        ops[i][j] = ops[i - 1][j - 1];
        continue;
      }
      const sub = dist[i - 1][j - 1];
      const del = dist[i - 1][j];
      const ins = dist[i][j - 1];
      const min = Math.min(sub, del, ins);
      dist[i][j] = min + 1;

      if (min === sub) {
        const p = ops[i - 1][j - 1];
        ops[i][j] = { s: p.s + 1, d: p.d, ins: p.ins };
      } else if (min === del) {
        const p = ops[i - 1][j];
        ops[i][j] = { s: p.s, d: p.d + 1, ins: p.ins };
      } else {
        const p = ops[i][j - 1];
        ops[i][j] = { s: p.s, d: p.d, ins: p.ins + 1 };
      }
    }
  }

  const final = ops[n][m];
  return {
    substitutions: final.s,
    deletions: final.d,
    insertions: final.ins,
    distance: dist[n][m]
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
