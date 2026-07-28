import test from "node:test";
import assert from "node:assert/strict";
import { removeFillerWords, collapseRepeatedWords, FILLER_WORDS } from "../src/application/filler-words.js";

test("removeFillerWords: убирает междометия внутри длинной непрерывной реплики", () => {
  const input = "это в начале у эээ меня на прошлой неделе не было";
  const result = removeFillerWords(input);
  assert.equal(result, "это в начале у меня на прошлой неделе не было");
});

test("removeFillerWords: убирает несколько разных филлеров в одном тексте", () => {
  const input = "аа, видно, документация до заказчика дошла, аа, брал два контакта, вот перед совещанием";
  const result = removeFillerWords(input);
  assert.ok(!/\bаа\b/i.test(result), "аа должно быть удалено");
  assert.ok(!/\bвот\b/i.test(result), "вот должно быть удалено");
  assert.match(result, /документация до заказчика дошла/);
  assert.match(result, /брал два контакта/);
});

test("removeFillerWords: не трогает содержательные слова, похожие на филлеры по подстроке", () => {
  assert.equal(removeFillerWords("второй этаж готов"), "второй этаж готов");
  assert.equal(removeFillerWords("нужно сдать документы"), "нужно сдать документы");
  assert.equal(removeFillerWords("это важное решение"), "это важное решение");
});

test("removeFillerWords: многословный маркер удаляется целиком", () => {
  assert.equal(
    removeFillerWords("как-то так получилось с проектом"),
    "получилось с проектом"
  );
});

test("removeFillerWords: не ломается на пустом/undefined тексте", () => {
  assert.equal(removeFillerWords(""), "");
  assert.equal(removeFillerWords(undefined), "");
});

test("collapseRepeatedWords: схлопывает повтор слова-реакции через запятую", () => {
  assert.equal(
    collapseRepeatedWords("да, да, да, конечно, едем в Рязань"),
    "да, конечно, едем в Рязань"
  );
});

test("collapseRepeatedWords: НЕ схлопывает два разных содержательных употребления одного слова", () => {
  // Реальный кейс, найденный на практике: оба "второе" значимы — схлопывание
  // потеряло бы смысл ("на второе[число]" и "второе[он] не берёт трубку")
  const input = "направил меня на второе, второе не берёт трубку";
  assert.equal(collapseRepeatedWords(input), input);
});

test("collapseRepeatedWords: не трогает обычные повторяющиеся содержательные слова", () => {
  assert.equal(
    collapseRepeatedWords("готово, готово всё сделано"),
    "готово, готово всё сделано"
  );
});

test("FILLER_WORDS: отсортирован по убыванию длины строки", () => {
  for (let i = 1; i < FILLER_WORDS.length; i++) {
    assert.ok(
      FILLER_WORDS[i - 1].length >= FILLER_WORDS[i].length,
      `нарушен порядок сортировки на индексе ${i}: "${FILLER_WORDS[i - 1]}" короче "${FILLER_WORDS[i]}"`
    );
  }
});

test("removeFillerWords + collapseRepeatedWords: полный пример из реального разбора качества", () => {
  const input = "да, да, это в начале у эээ меня на прошлой неделе не было, я был в командировке, поэтому за две недели да, да, да, конечно, едем Рязань, и здесь сто семьдесят шестая и сто пятьдесят пятая в папке, соответственно, подписались в ЕИС, аа, видно, документация до заказчика дошла, аа, брал два контакта, вот перед совещанием до одного дозвонился, направил меня на второе, второе не берёт трубку";

  const step1 = collapseRepeatedWords(input);
  const result = removeFillerWords(step1);

  assert.ok(!/эээ/i.test(result));
  assert.ok(!/\bаа\b/i.test(result));
  assert.ok(!/да, да, да/i.test(result));
  // числа и факты не должны пострадать
  assert.match(result, /сто семьдесят шестая/);
  assert.match(result, /сто пятьдесят пятая/);
  assert.match(result, /ЕИС/);
  // семантически значимый повтор "второе, второе" должен сохраниться
  assert.match(result, /на второе, второе не берёт трубку/);
});
