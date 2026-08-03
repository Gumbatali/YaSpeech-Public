import { test } from "node:test";
import assert from "node:assert/strict";

import { computeDer, speakerCountError } from "../../../scripts/benchmark/lib/der.mjs";

// collar по умолчанию (0.25с) вырезает окрестности границ, что на коротких
// синтетических примерах съедает почти всё. Для проверки самой арифметики
// отключаем его, а поведение collar тестируем отдельно.
const NO_COLLAR = { collarSec: 0 };

test("perfect match gives DER 0", () => {
  const ref = [
    { speaker: "A", start: 0, stop: 10 },
    { speaker: "B", start: 10, stop: 20 },
  ];
  const hyp = [
    { speaker: "SPEAKER_00", start: 0, stop: 10 },
    { speaker: "SPEAKER_01", start: 10, stop: 20 },
  ];

  const result = computeDer(ref, hyp, NO_COLLAR);
  assert.equal(result.der, 0);
});

test("swapped speaker names still give DER 0 via optimal mapping", () => {
  // Имена в эталоне и выводе системы не связаны — «перепутанные» ярлыки
  // при полном совпадении границ ошибкой не являются.
  const ref = [
    { speaker: "A", start: 0, stop: 10 },
    { speaker: "B", start: 10, stop: 20 },
  ];
  const hyp = [
    { speaker: "SPEAKER_01", start: 0, stop: 10 },
    { speaker: "SPEAKER_00", start: 10, stop: 20 },
  ];

  assert.equal(computeDer(ref, hyp, NO_COLLAR).der, 0);
});

test("optimal mapping beats greedy on a partially confused pair", () => {
  // Жадный алгоритм закрепил бы за A первого попавшегося и завысил бы DER.
  const ref = [
    { speaker: "A", start: 0, stop: 10 },
    { speaker: "B", start: 10, stop: 30 },
  ];
  const hyp = [
    { speaker: "X", start: 0, stop: 10 },
    { speaker: "Y", start: 10, stop: 30 },
  ];

  const result = computeDer(ref, hyp, NO_COLLAR);
  assert.equal(result.der, 0);
  assert.deepEqual(result.mapping, { A: "X", B: "Y" });
});

test("total miss gives DER 1.0", () => {
  const ref = [{ speaker: "A", start: 0, stop: 10 }];
  const result = computeDer(ref, [], NO_COLLAR);

  assert.equal(result.der, 1);
  assert.equal(result.missRate, 1);
});

test("half missed speech gives DER 0.5", () => {
  const ref = [{ speaker: "A", start: 0, stop: 10 }];
  const hyp = [{ speaker: "X", start: 0, stop: 5 }];

  const result = computeDer(ref, hyp, NO_COLLAR);
  assert.ok(Math.abs(result.der - 0.5) < 0.01, `got ${result.der}`);
  assert.ok(Math.abs(result.missRate - 0.5) < 0.01);
});

test("false alarm is counted when system invents speech", () => {
  const ref = [{ speaker: "A", start: 0, stop: 10 }];
  const hyp = [
    { speaker: "X", start: 0, stop: 10 },
    { speaker: "Y", start: 0, stop: 10 }, // второй голос, которого нет в эталоне
  ];

  const result = computeDer(ref, hyp, NO_COLLAR);
  assert.ok(result.falseAlarmRate > 0, "false alarm must be reported");
  assert.ok(Math.abs(result.falseAlarmRate - 1.0) < 0.01, `got ${result.falseAlarmRate}`);
});

test("speaker error is counted when speech is attributed to the wrong person", () => {
  // Система нашла речь везде правильно, но во второй половине приписала
  // её тому же спикеру, что и в первой.
  const ref = [
    { speaker: "A", start: 0, stop: 10 },
    { speaker: "B", start: 10, stop: 20 },
  ];
  const hyp = [{ speaker: "X", start: 0, stop: 20 }];

  const result = computeDer(ref, hyp, NO_COLLAR);
  assert.ok(result.speakerErrorRate > 0, "speaker error must be reported");
  assert.ok(Math.abs(result.der - 0.5) < 0.02, `got ${result.der}`);
});

test("collar excludes frames around reference boundaries", () => {
  const ref = [
    { speaker: "A", start: 0, stop: 10 },
    { speaker: "B", start: 10, stop: 20 },
  ];
  // Система ошиблась ровно на границе — с collar это не должно штрафоваться.
  const hyp = [
    { speaker: "X", start: 0, stop: 10.2 },
    { speaker: "Y", start: 10.2, stop: 20 },
  ];

  const withCollar = computeDer(ref, hyp, { collarSec: 0.25 });
  const withoutCollar = computeDer(ref, hyp, NO_COLLAR);

  assert.ok(
    withCollar.der < withoutCollar.der,
    `collar must forgive boundary jitter: ${withCollar.der} vs ${withoutCollar.der}`
  );
  assert.ok(withCollar.der < 0.01, `expected near-zero DER, got ${withCollar.der}`);
});

test("overlapping speech is scored, not silently dropped", () => {
  // Двое говорят одновременно 0–10. Система услышала только одного.
  const ref = [
    { speaker: "A", start: 0, stop: 10 },
    { speaker: "B", start: 0, stop: 10 },
  ];
  const hyp = [{ speaker: "X", start: 0, stop: 10 }];

  const result = computeDer(ref, hyp, NO_COLLAR);
  assert.ok(Math.abs(result.missRate - 0.5) < 0.01, `got missRate ${result.missRate}`);
});

test("skipOverlap ignores overlapped regions when asked", () => {
  const ref = [
    { speaker: "A", start: 0, stop: 10 },
    { speaker: "B", start: 0, stop: 10 },
  ];
  const hyp = [{ speaker: "X", start: 0, stop: 10 }];

  const result = computeDer(ref, hyp, { ...NO_COLLAR, skipOverlap: true });
  assert.equal(result.totalSpeechSec, 0, "everything was overlap, nothing left to score");
});

test("empty reference is reported rather than dividing by zero", () => {
  const result = computeDer([], [{ speaker: "X", start: 0, stop: 5 }], NO_COLLAR);
  assert.equal(result.der, 0);
  assert.match(result.note ?? "", /reference is empty/);
});

test("malformed segments are filtered out", () => {
  const ref = [
    { speaker: "A", start: 0, stop: 10 },
    { speaker: "B", start: 5, stop: 5 }, // нулевая длина
    { speaker: "C", start: 8, stop: 2 }, // stop < start
    { speaker: "D", start: NaN, stop: 3 },
  ];

  const result = computeDer(ref, [{ speaker: "X", start: 0, stop: 10 }], NO_COLLAR);
  assert.equal(result.refSpeakers, 1);
  assert.equal(result.der, 0);
});

test("speakerCountError reports over- and under-counting", () => {
  const ref = [
    { speaker: "A", start: 0, stop: 5 },
    { speaker: "B", start: 5, stop: 10 },
  ];

  const over = speakerCountError(ref, [
    { speaker: "X", start: 0, stop: 3 },
    { speaker: "Y", start: 3, stop: 6 },
    { speaker: "Z", start: 6, stop: 10 },
  ]);
  assert.equal(over.diff, 1);
  assert.equal(over.correct, false);

  const exact = speakerCountError(ref, [
    { speaker: "X", start: 0, stop: 5 },
    { speaker: "Y", start: 5, stop: 10 },
  ]);
  assert.equal(exact.correct, true);
});

test("DER can exceed 1.0 when the system hallucinates heavily", () => {
  // Это не баг: false alarm не ограничен сверху длиной эталонной речи.
  const ref = [{ speaker: "A", start: 0, stop: 10 }];
  const hyp = [
    { speaker: "X", start: 0, stop: 10 },
    { speaker: "Y", start: 0, stop: 10 },
    { speaker: "Z", start: 0, stop: 10 },
  ];

  const result = computeDer(ref, hyp, NO_COLLAR);
  assert.ok(result.der > 1, `expected DER > 1, got ${result.der}`);
});
