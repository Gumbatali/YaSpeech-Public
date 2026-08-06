import { test } from "node:test";
import assert from "node:assert/strict";

import { computeCpWer, computeWer } from "../../../scripts/benchmark/lib/cpwer.mjs";

test("perfect transcript with matching speakers gives cpWER 0", () => {
  const ref = [
    { speaker: "A", start: 0, text: "привет как дела" },
    { speaker: "B", start: 5, text: "всё хорошо спасибо" },
  ];
  const hyp = [
    { speaker: "SPEAKER_00", start: 0, text: "привет как дела" },
    { speaker: "SPEAKER_01", start: 5, text: "всё хорошо спасибо" },
  ];

  assert.equal(computeCpWer(ref, hyp).cpwer, 0);
});

test("swapped speaker labels still give cpWER 0 via optimal permutation", () => {
  // Имена спикеров произвольны: если система назвала того же человека
  // иначе, но слова привязала верно — это не ошибка.
  const ref = [
    { speaker: "A", start: 0, text: "привет как дела" },
    { speaker: "B", start: 5, text: "всё хорошо спасибо" },
  ];
  const hyp = [
    { speaker: "SPEAKER_01", start: 0, text: "привет как дела" },
    { speaker: "SPEAKER_00", start: 5, text: "всё хорошо спасибо" },
  ];

  const result = computeCpWer(ref, hyp);
  assert.equal(result.cpwer, 0);
  assert.equal(result.mapping.A, "SPEAKER_01");
});

test("cpWER punishes text assigned to the wrong speaker", () => {
  // Важно: полный обмен репликами между двумя спикерами cpWER НЕ штрафует —
  // перестановка распутывает его и даёт 0, это корректно (имена произвольны).
  //
  // Настоящая ошибка атрибуции — когда часть реплик одного человека уехала
  // к другому. Такую перестановкой не исправить.
  const ref = [
    { speaker: "A", start: 0, text: "один два три" },
    { speaker: "B", start: 5, text: "четыре пять шесть" },
  ];
  const hyp = [
    // Система отдала "три" второму спикеру.
    { speaker: "S0", start: 0, text: "один два" },
    { speaker: "S1", start: 5, text: "три четыре пять шесть" },
  ];

  const wer = computeWer(ref, hyp);
  const cp = computeCpWer(ref, hyp);

  assert.equal(wer.wer, 0, "все слова на месте — WER этого не видит");
  assert.ok(cp.cpwer > 0, "но cpWER обязан заметить неверную атрибуцию");
  assert.ok(
    cp.cpwer > wer.wer,
    `cpWER (${cp.cpwer}) должен быть строго хуже WER (${wer.wer})`
  );
});

test("WER ignores speaker attribution entirely", () => {
  // Тот же текст, но весь приписан одному спикеру.
  // Для WER это идеальная расшифровка.
  const ref = [
    { speaker: "A", start: 0, text: "один два три" },
    { speaker: "B", start: 5, text: "четыре пять шесть" },
  ];
  const hyp = [{ speaker: "S0", start: 0, text: "один два три четыре пять шесть" }];

  assert.equal(computeWer(ref, hyp).wer, 0, "слова все на месте");
  assert.ok(computeCpWer(ref, hyp).cpwer > 0, "но привязка к людям потеряна");
});

test("cpWER counts substitutions in recognised words", () => {
  const ref = [{ speaker: "A", start: 0, text: "прораб сказал бетон привезут завтра" }];
  const hyp = [{ speaker: "S0", start: 0, text: "прораб сказал бетон привезут в среду" }];

  const result = computeCpWer(ref, hyp);
  // 5 слов эталона, "завтра" → "в среду": замена + вставка = 2 ошибки.
  assert.equal(result.refWords, 5);
  assert.ok(result.cpwer > 0 && result.cpwer < 1, `got ${result.cpwer}`);
});

test("missing speaker entirely counts as deletions", () => {
  const ref = [
    { speaker: "A", start: 0, text: "первый спикер говорит" },
    { speaker: "B", start: 5, text: "второй спикер отвечает" },
  ];
  const hyp = [{ speaker: "S0", start: 0, text: "первый спикер говорит" }];

  const result = computeCpWer(ref, hyp);
  // Потерян весь второй спикер — 3 слова из 6.
  assert.ok(Math.abs(result.cpwer - 0.5) < 0.01, `got ${result.cpwer}`);
  assert.equal(result.deletions, 3);
});

test("extra hallucinated speaker counts as insertions", () => {
  const ref = [{ speaker: "A", start: 0, text: "один два три" }];
  const hyp = [
    { speaker: "S0", start: 0, text: "один два три" },
    { speaker: "S1", start: 5, text: "лишний выдуманный спикер" },
  ];

  const result = computeCpWer(ref, hyp);
  assert.equal(result.insertions, 3);
  assert.ok(result.cpwer > 0);
});

test("utterances are concatenated in time order, not input order", () => {
  // Реплики одного человека пришли вперемешку — метрика не должна
  // штрафовать за порядок в массиве.
  const ref = [
    { speaker: "A", start: 0, text: "начало" },
    { speaker: "A", start: 10, text: "конец" },
  ];
  const hyp = [
    { speaker: "S0", start: 10, text: "конец" },
    { speaker: "S0", start: 0, text: "начало" },
  ];

  assert.equal(computeCpWer(ref, hyp).cpwer, 0);
});

test("cpWER handles more hypothesis speakers than reference", () => {
  // Система раздробила одного человека на двоих — классическая
  // ошибка диаризации при смене интонации.
  const ref = [{ speaker: "A", start: 0, text: "один два три четыре" }];
  const hyp = [
    { speaker: "S0", start: 0, text: "один два" },
    { speaker: "S1", start: 5, text: "три четыре" },
  ];

  const result = computeCpWer(ref, hyp);
  assert.equal(result.refSpeakers, 1);
  assert.equal(result.hypSpeakers, 2);
  // Половина слов ушла "чужому" спикеру.
  assert.ok(result.cpwer > 0, `got ${result.cpwer}`);
});

test("empty hypothesis gives cpWER 1.0", () => {
  const ref = [{ speaker: "A", start: 0, text: "один два три" }];
  const result = computeCpWer(ref, []);

  assert.equal(result.cpwer, 1);
  assert.equal(result.deletions, 3);
});

test("empty reference is reported rather than dividing by zero", () => {
  const result = computeCpWer([], [{ speaker: "S0", start: 0, text: "что-то" }]);
  assert.equal(result.cpwer, 0);
  assert.match(result.note ?? "", /no words/);
});

test("normalisation strips punctuation and case", () => {
  const ref = [{ speaker: "A", start: 0, text: "Привет, как дела?" }];
  const hyp = [{ speaker: "S0", start: 0, text: "привет как дела" }];

  assert.equal(computeCpWer(ref, hyp).cpwer, 0);
});

test("per-speaker breakdown is reported", () => {
  const ref = [
    { speaker: "A", start: 0, text: "один два три четыре" },
    { speaker: "B", start: 5, text: "пять шесть" },
  ];
  const hyp = [
    { speaker: "S0", start: 0, text: "один два три четыре" },
    { speaker: "S1", start: 5, text: "совсем другое" },
  ];

  const result = computeCpWer(ref, hyp);
  const a = result.perSpeaker.find((s) => s.reference === "A");
  const b = result.perSpeaker.find((s) => s.reference === "B");

  assert.equal(a.wer, 0, "спикер A распознан идеально");
  assert.ok(b.wer > 0, "спикер B — с ошибками");
});
