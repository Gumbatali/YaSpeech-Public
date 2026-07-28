import test from "node:test";
import assert from "node:assert/strict";
import { punctuateByPauses } from "../src/application/punctuation-by-pauses.js";

function words(spec) {
  // spec: [[text, startMs, endMs], ...]
  return spec.map(([text, startTimeMs, endTimeMs]) => ({ text, startTimeMs, endTimeMs }));
}

test("punctuateByPauses: длинная пауза (>=500мс) становится точкой с капитализацией следующего слова", () => {
  const input = words([
    ["коллеги", 0, 400],
    ["начнём", 450, 700],
    ["на", 1300, 1350], // пауза 600мс от предыдущего конца (700)
    ["садовой", 1360, 1600]
  ]);
  assert.equal(punctuateByPauses(input), "Коллеги начнём. На садовой.");
});

test("punctuateByPauses: средняя пауза (200-500мс) становится запятой", () => {
  const input = words([
    ["фундамент", 0, 400],
    ["готов", 650, 900] // пауза 250мс
  ]);
  assert.equal(punctuateByPauses(input), "Фундамент, готов.");
});

test("punctuateByPauses: короткая пауза (<200мс) не даёт знака препинания", () => {
  const input = words([
    ["мы", 0, 200],
    ["едем", 250, 500] // пауза 50мс
  ]);
  assert.equal(punctuateByPauses(input), "Мы едем.");
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
