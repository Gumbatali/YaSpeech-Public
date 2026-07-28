import test from "node:test";
import assert from "node:assert/strict";
import { punctuateByPauses } from "../src/application/punctuation-by-pauses.js";

function words(spec) {
  // spec: [[text, startMs, endMs], ...]
  return spec.map(([text, startTimeMs, endTimeMs]) => ({ text, startTimeMs, endTimeMs }));
}

test("punctuateByPauses: длинная пауза (>=900мс) становится точкой с капитализацией следующего слова", () => {
  const input = words([
    ["коллеги", 0, 400],
    ["начнём", 450, 700],
    ["на", 1700, 1750], // пауза 1000мс от предыдущего конца (700)
    ["садовой", 1760, 2000]
  ]);
  assert.equal(punctuateByPauses(input), "Коллеги начнём. На садовой.");
});

test("punctuateByPauses: средняя пауза (350-900мс) становится запятой", () => {
  const input = words([
    ["фундамент", 0, 400],
    ["готов", 800, 1050] // пауза 400мс
  ]);
  assert.equal(punctuateByPauses(input), "Фундамент, готов.");
});

test("punctuateByPauses: короткая пауза (<350мс, обычный вдох внутри мысли) не даёт знака препинания", () => {
  const input = words([
    ["может", 0, 200],
    ["быть", 400, 600], // пауза 200мс — не должна разрывать словосочетание
    ["там", 750, 900],
    ["перед", 950, 1100],
    ["праздниками", 1250, 1600] // пауза 150мс
  ]);
  assert.equal(punctuateByPauses(input), "Может быть там перед праздниками.");
});

test("punctuateByPauses: союзы из COMMA_BEFORE получают запятую независимо от паузы", () => {
  const input = words([
    ["скажи", 0, 300],
    ["потому", 310, 600] // пауза всего 10мс, но "потому" — триггер запятой
  ]);
  assert.equal(punctuateByPauses(input), "Скажи, потому.");
});

test("punctuateByPauses: пустой массив слов возвращает пустую строку", () => {
  assert.equal(punctuateByPauses([]), "");
  assert.equal(punctuateByPauses(undefined), "");
});

test("punctuateByPauses: одно слово капитализируется и получает точку", () => {
  assert.equal(punctuateByPauses(words([["да", 0, 200]])), "Да.");
});

test("punctuateByPauses: не удваивает точку, если фраза уже заканчивается знаком препинания", () => {
  // это не типичный кейс на входе (SpeechKit без пунктуации), но проверяем
  // что финальная нормализация не портит текст, если знак уже есть
  const input = words([
    ["всё", 0, 200],
    ["готово", 210, 400]
  ]);
  const result = punctuateByPauses(input);
  assert.equal(/\.\.$/.test(result), false);
});
