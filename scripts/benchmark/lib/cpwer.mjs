/**
 * cpWER — concatenated minimum-permutation Word Error Rate.
 *
 * Отвечает на вопрос, который не покрывают ни WER, ни DER по отдельности:
 * «насколько правильно слова привязаны к людям».
 *
 *   WER   — верны ли слова, но неважно кто сказал
 *   DER   — верно ли кто когда говорил, но неважно какие слова
 *   cpWER — верны ли слова И правильному ли человеку приписаны
 *
 * Именно cpWER отражает то, что видит пользователь в протоколе: реплика,
 * записанная не тому участнику, для читателя ошибка, даже если все слова
 * распознаны идеально.
 *
 * Алгоритм (стандарт из CHiME-6 / DIHARD):
 *   1. Склеить весь текст каждого спикера в одну строку (по возрастанию времени).
 *   2. Перебрать соответствия «гипотезный спикер → эталонный» и выбрать то,
 *      которое даёт минимальную суммарную ошибку. Имена спикеров произвольны,
 *      поэтому без оптимальной перестановки метрика бессмысленна.
 *   3. Посчитать WER на склеенных строках и поделить на общее число слов.
 *
 * Перестановку ищем венгерским алгоритмом: перебор всех вариантов —
 * это O(n!), что на 6 спикерах уже 720 вычислений матрицы расстояний,
 * каждое из которых само по себе дорогое.
 */

import { normalizeRu, tokenize, alignTokens } from "./wer.mjs";

/**
 * @typedef {{ speaker: string, text: string, start?: number }} Utterance
 */

/**
 * @param {Utterance[]} reference эталонные реплики со спикерами
 * @param {Utterance[]} hypothesis реплики системы
 * @returns {{cpwer: number, substitutions: number, deletions: number,
 *            insertions: number, refWords: number, mapping: object,
 *            perSpeaker: Array<object>}}
 */
export function computeCpWer(reference, hypothesis) {
  const refBySpeaker = concatenateBySpeaker(reference);
  const hypBySpeaker = concatenateBySpeaker(hypothesis);

  const refSpeakers = [...refBySpeaker.keys()].sort();
  const hypSpeakers = [...hypBySpeaker.keys()].sort();

  const refWordsTotal = refSpeakers.reduce(
    (sum, s) => sum + tokenize(refBySpeaker.get(s)).length,
    0
  );

  if (refWordsTotal === 0) {
    return emptyResult({ note: "reference has no words" });
  }

  // Матрица ошибок: сколько правок нужно, чтобы превратить речь
  // гипотезного спикера j в речь эталонного i.
  const size = Math.max(refSpeakers.length, hypSpeakers.length);
  const cost = [];
  const details = [];

  for (let i = 0; i < size; i++) {
    cost.push(new Array(size).fill(0));
    details.push(new Array(size).fill(null));

    const refText = i < refSpeakers.length ? refBySpeaker.get(refSpeakers[i]) : "";
    const refTokens = tokenize(refText);

    for (let j = 0; j < size; j++) {
      const hypText = j < hypSpeakers.length ? hypBySpeaker.get(hypSpeakers[j]) : "";
      const hypTokens = tokenize(hypText);

      const stats = alignTokens(refTokens, hypTokens);
      const errors = stats.substitutions + stats.deletions + stats.insertions;

      cost[i][j] = errors;
      details[i][j] = stats;
    }
  }

  const assignment = hungarian(cost, size);

  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;
  const mapping = {};
  const perSpeaker = [];

  for (let i = 0; i < size; i++) {
    const j = assignment[i];
    if (j == null) continue;

    const stats = details[i][j];
    substitutions += stats.substitutions;
    deletions += stats.deletions;
    insertions += stats.insertions;

    // В отчёт попадают только настоящие спикеры, а не добивка матрицы
    // до квадратной.
    if (i < refSpeakers.length) {
      const hypName = j < hypSpeakers.length ? hypSpeakers[j] : null;
      mapping[refSpeakers[i]] = hypName;

      const refTokens = tokenize(refBySpeaker.get(refSpeakers[i]));
      perSpeaker.push({
        reference: refSpeakers[i],
        hypothesis: hypName,
        refWords: refTokens.length,
        errors: stats.substitutions + stats.deletions + stats.insertions,
        wer: refTokens.length ? (stats.substitutions + stats.deletions + stats.insertions) / refTokens.length : 0,
      });
    }
  }

  return {
    cpwer: (substitutions + deletions + insertions) / refWordsTotal,
    substitutions,
    deletions,
    insertions,
    refWords: refWordsTotal,
    refSpeakers: refSpeakers.length,
    hypSpeakers: hypSpeakers.length,
    mapping,
    perSpeaker,
  };
}

/**
 * WER без учёта спикеров: весь текст в одну строку.
 * Разница между ним и cpWER показывает, сколько ошибки даёт именно
 * неверная атрибуция, а не распознавание слов.
 */
export function computeWer(reference, hypothesis) {
  const refText = flatten(reference);
  const hypText = flatten(hypothesis);

  const refTokens = tokenize(refText);
  const hypTokens = tokenize(hypText);

  if (refTokens.length === 0) return emptyResult({ note: "reference has no words" });

  const stats = alignTokens(refTokens, hypTokens);
  const errors = stats.substitutions + stats.deletions + stats.insertions;

  return {
    wer: errors / refTokens.length,
    substitutions: stats.substitutions,
    deletions: stats.deletions,
    insertions: stats.insertions,
    refWords: refTokens.length,
  };
}

// ────────────────────────────────────────────────────────────────────────────

function concatenateBySpeaker(utterances) {
  const bySpeaker = new Map();
  if (!Array.isArray(utterances)) return bySpeaker;

  // Сортировка по времени обязательна: cpWER сравнивает последовательности
  // слов, и переставленные реплики одного человека дадут лишние ошибки.
  const sorted = [...utterances].sort((a, b) => (a.start ?? 0) - (b.start ?? 0));

  for (const u of sorted) {
    const speaker = String(u.speaker ?? "UNKNOWN");
    const text = normalizeRu(String(u.text ?? ""));
    if (!text) continue;

    const prev = bySpeaker.get(speaker);
    bySpeaker.set(speaker, prev ? `${prev} ${text}` : text);
  }

  return bySpeaker;
}

function flatten(utterances) {
  if (!Array.isArray(utterances)) return "";
  return [...utterances]
    .sort((a, b) => (a.start ?? 0) - (b.start ?? 0))
    .map((u) => normalizeRu(String(u.text ?? "")))
    .filter(Boolean)
    .join(" ");
}

/**
 * Венгерский алгоритм (метод потенциалов, O(n³)).
 * Возвращает: индекс строки → индекс назначенного столбца.
 */
function hungarian(cost, n) {
  const INF = Infinity;
  const u = new Array(n + 1).fill(0);
  const v = new Array(n + 1).fill(0);
  const p = new Array(n + 1).fill(0);
  const way = new Array(n + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(n + 1).fill(INF);
    const used = new Array(n + 1).fill(false);

    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF;
      let j1 = 0;

      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }

      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }

      j0 = j1;
    } while (p[j0] !== 0);

    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }

  const result = new Array(n).fill(null);
  for (let j = 1; j <= n; j++) {
    if (p[j] > 0) result[p[j] - 1] = j - 1;
  }
  return result;
}

function emptyResult(extra) {
  return {
    cpwer: 0,
    wer: 0,
    substitutions: 0,
    deletions: 0,
    insertions: 0,
    refWords: 0,
    refSpeakers: 0,
    hypSpeakers: 0,
    mapping: {},
    perSpeaker: [],
    ...extra,
  };
}
