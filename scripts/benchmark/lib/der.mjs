/**
 * DER (Diarization Error Rate) — чистый JS, без зависимостей.
 *
 * DER = (MISS + FALSE ALARM + SPEAKER ERROR) / TOTAL_REFERENCE_SPEECH
 *
 *   MISS          — эталон говорит, система молчит
 *   FALSE ALARM   — система говорит, эталон молчит
 *   SPEAKER ERROR — оба говорят, но система приписала реплику не тому спикеру
 *
 * Ключевая тонкость, из-за которой наивная реализация даёт бессмысленные числа:
 * имена спикеров в эталоне и в выводе системы НЕ СВЯЗАНЫ. «SPEAKER_00» модели
 * может соответствовать «Прораб» из эталона. Поэтому перед подсчётом ошибок
 * нужно найти ОПТИМАЛЬНОЕ соответствие имён — то, которое минимизирует ошибку.
 * Жадное сопоставление здесь систематически завышает DER.
 *
 * Реализация считает по сетке кадров (по умолчанию 10 мс): это проще и
 * численно устойчивее, чем интервальная арифметика с перекрытиями, и ровно
 * так же поступают эталонные инструменты (dscore, pyannote.metrics).
 */

const DEFAULT_FRAME_SEC = 0.01;

// Стандартный collar: границы реплик размечены людьми с точностью ±0.25с,
// поэтому окрестность каждой границы исключается из подсчёта. Так делает
// NIST RT и все публикуемые числа DER — без collar значения несравнимы
// с литературой.
const DEFAULT_COLLAR_SEC = 0.25;

/**
 * @typedef {{ speaker: string, start: number, stop: number }} Segment
 */

/**
 * @param {Segment[]} reference эталонная разметка
 * @param {Segment[]} hypothesis вывод системы
 * @param {{frameSec?: number, collarSec?: number, skipOverlap?: boolean}} options
 */
export function computeDer(reference, hypothesis, options = {}) {
  const frameSec = options.frameSec ?? DEFAULT_FRAME_SEC;
  const collarSec = options.collarSec ?? DEFAULT_COLLAR_SEC;
  const skipOverlap = options.skipOverlap ?? false;

  const refSegments = sanitize(reference);
  const hypSegments = sanitize(hypothesis);

  if (refSegments.length === 0) {
    return emptyResult({ note: "reference is empty — DER undefined" });
  }

  const duration = Math.max(maxStop(refSegments), maxStop(hypSegments));
  const frameCount = Math.ceil(duration / frameSec);

  const refSpeakers = uniqueSpeakers(refSegments);
  const hypSpeakers = uniqueSpeakers(hypSegments);

  // Кадр → множество активных спикеров, отдельно для эталона и гипотезы.
  const refFrames = rasterize(refSegments, refSpeakers, frameCount, frameSec);
  const hypFrames = rasterize(hypSegments, hypSpeakers, frameCount, frameSec);

  const scored = buildScoringMask(refSegments, frameCount, frameSec, collarSec);

  // Матрица пересечений: сколько кадров эталонный спикер i делит с гипотезным j.
  const overlapMatrix = refSpeakers.map(() => new Array(hypSpeakers.length).fill(0));

  for (let f = 0; f < frameCount; f++) {
    if (!scored[f]) continue;
    const refActive = refFrames[f];
    const hypActive = hypFrames[f];
    if (refActive.length === 0 || hypActive.length === 0) continue;
    if (skipOverlap && refActive.length > 1) continue;

    for (const r of refActive) {
      for (const h of hypActive) {
        overlapMatrix[r][h] += 1;
      }
    }
  }

  const mapping = optimalMapping(overlapMatrix, refSpeakers.length, hypSpeakers.length);

  let missFrames = 0;
  let falseAlarmFrames = 0;
  let speakerErrorFrames = 0;
  let totalRefFrames = 0;
  let scoredFrames = 0;

  for (let f = 0; f < frameCount; f++) {
    if (!scored[f]) continue;
    scoredFrames++;

    const refActive = refFrames[f];
    const hypActive = hypFrames[f];

    if (skipOverlap && refActive.length > 1) continue;

    totalRefFrames += refActive.length;

    // Сколько эталонных спикеров этого кадра система нашла под правильным именем.
    const hypSet = new Set(hypActive);
    let correct = 0;
    for (const r of refActive) {
      const mapped = mapping.get(r);
      if (mapped != null && hypSet.has(mapped)) correct++;
    }

    const refCount = refActive.length;
    const hypCount = hypActive.length;

    // Классическая декомпозиция NIST: в кадре, где эталон насчитал N речей,
    // а система M, ошибкой считается недостача, избыток и неверная атрибуция.
    missFrames += Math.max(0, refCount - hypCount);
    falseAlarmFrames += Math.max(0, hypCount - refCount);
    speakerErrorFrames += Math.min(refCount, hypCount) - correct;
  }

  const totalSec = totalRefFrames * frameSec;
  const der =
    totalRefFrames > 0
      ? (missFrames + falseAlarmFrames + speakerErrorFrames) / totalRefFrames
      : 0;

  return {
    der,
    missRate: totalRefFrames > 0 ? missFrames / totalRefFrames : 0,
    falseAlarmRate: totalRefFrames > 0 ? falseAlarmFrames / totalRefFrames : 0,
    speakerErrorRate: totalRefFrames > 0 ? speakerErrorFrames / totalRefFrames : 0,
    missSec: missFrames * frameSec,
    falseAlarmSec: falseAlarmFrames * frameSec,
    speakerErrorSec: speakerErrorFrames * frameSec,
    totalSpeechSec: totalSec,
    scoredSec: scoredFrames * frameSec,
    refSpeakers: refSpeakers.length,
    hypSpeakers: hypSpeakers.length,
    mapping: describeMapping(mapping, refSpeakers, hypSpeakers),
  };
}

/**
 * Ошибка в подсчёте числа участников. Считается отдельно от DER, потому что
 * отвечает на другой вопрос продукта: «сколько человек в протоколе» —
 * это то, что пользователь видит сразу, ещё до чтения реплик.
 */
export function speakerCountError(reference, hypothesis) {
  const ref = uniqueSpeakers(sanitize(reference)).length;
  const hyp = uniqueSpeakers(sanitize(hypothesis)).length;
  return { reference: ref, hypothesis: hyp, diff: hyp - ref, correct: ref === hyp };
}

// ────────────────────────────────────────────────────────────────────────────
// Оптимальное сопоставление спикеров (венгерский алгоритм)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Находит соответствие эталонных спикеров гипотезным, максимизирующее суммарное
 * пересечение. Это задача о назначениях; решаем венгерским алгоритмом за O(n³).
 *
 * Жадный вариант («каждому эталонному — лучший свободный») даёт заметно худший
 * результат на записях, где два спикера частично перепутаны: он фиксирует
 * первое локально удачное решение и лишает второго спикера его пары.
 */
function optimalMapping(matrix, refCount, hypCount) {
  const mapping = new Map();
  if (refCount === 0 || hypCount === 0) return mapping;

  const n = Math.max(refCount, hypCount);

  // Квадратная матрица стоимостей: максимизацию пересечения превращаем
  // в минимизацию, вычитая из максимума.
  let maxValue = 0;
  for (let i = 0; i < refCount; i++) {
    for (let j = 0; j < hypCount; j++) maxValue = Math.max(maxValue, matrix[i][j]);
  }

  const cost = [];
  for (let i = 0; i < n; i++) {
    cost.push(new Array(n).fill(maxValue));
    for (let j = 0; j < n; j++) {
      if (i < refCount && j < hypCount) cost[i][j] = maxValue - matrix[i][j];
    }
  }

  const assignment = hungarian(cost, n);

  for (let i = 0; i < refCount; i++) {
    const j = assignment[i];
    // Пары с нулевым пересечением не значат ничего — это артефакт добивки
    // матрицы до квадратной, а не настоящее соответствие.
    if (j != null && j < hypCount && matrix[i][j] > 0) {
      mapping.set(i, j);
    }
  }

  return mapping;
}

/**
 * Венгерский алгоритм (метод потенциалов, O(n³)).
 * Возвращает массив: индекс строки → индекс назначенного столбца.
 */
function hungarian(cost, n) {
  const INF = Infinity;
  const u = new Array(n + 1).fill(0);
  const v = new Array(n + 1).fill(0);
  const p = new Array(n + 1).fill(0); // столбец → строка
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

// ────────────────────────────────────────────────────────────────────────────
// Растеризация и вспомогательное
// ────────────────────────────────────────────────────────────────────────────

function rasterize(segments, speakers, frameCount, frameSec) {
  const index = new Map(speakers.map((s, i) => [s, i]));
  const frames = Array.from({ length: frameCount }, () => []);

  for (const seg of segments) {
    const from = Math.max(0, Math.floor(seg.start / frameSec));
    const to = Math.min(frameCount, Math.ceil(seg.stop / frameSec));
    const speakerIdx = index.get(seg.speaker);

    for (let f = from; f < to; f++) {
      // Один спикер может попасть в кадр дважды (соседние сегменты) —
      // для подсчёта важно присутствие, а не кратность.
      if (!frames[f].includes(speakerIdx)) frames[f].push(speakerIdx);
    }
  }

  return frames;
}

/**
 * Маска кадров, участвующих в оценке. Кадры вблизи границ эталонных реплик
 * исключаются (collar): человеческая разметка там неточна, и штрафовать за
 * это модель нечестно.
 */
function buildScoringMask(refSegments, frameCount, frameSec, collarSec) {
  const scored = new Array(frameCount).fill(true);
  if (collarSec <= 0) return scored;

  const halfCollar = Math.ceil(collarSec / frameSec);

  for (const seg of refSegments) {
    for (const boundary of [seg.start, seg.stop]) {
      const center = Math.round(boundary / frameSec);
      for (let f = center - halfCollar; f < center + halfCollar; f++) {
        if (f >= 0 && f < frameCount) scored[f] = false;
      }
    }
  }

  return scored;
}

function sanitize(segments) {
  if (!Array.isArray(segments)) return [];
  return segments
    .map((s) => ({
      speaker: String(s.speaker ?? s.label ?? "UNKNOWN"),
      start: Number(s.start),
      stop: Number(s.stop ?? s.end),
    }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.stop) && s.stop > s.start)
    .sort((a, b) => a.start - b.start);
}

function uniqueSpeakers(segments) {
  return [...new Set(segments.map((s) => s.speaker))].sort();
}

function maxStop(segments) {
  return segments.reduce((max, s) => Math.max(max, s.stop), 0);
}

function describeMapping(mapping, refSpeakers, hypSpeakers) {
  const out = {};
  for (const [refIdx, hypIdx] of mapping.entries()) {
    out[refSpeakers[refIdx]] = hypSpeakers[hypIdx];
  }
  return out;
}

function emptyResult(extra) {
  return {
    der: 0,
    missRate: 0,
    falseAlarmRate: 0,
    speakerErrorRate: 0,
    missSec: 0,
    falseAlarmSec: 0,
    speakerErrorSec: 0,
    totalSpeechSec: 0,
    scoredSec: 0,
    refSpeakers: 0,
    hypSpeakers: 0,
    mapping: {},
    ...extra,
  };
}
