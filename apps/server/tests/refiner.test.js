import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRefineChunks,
  parseRefinedLines,
  extractNumericValues,
  numbersPreserved,
  applyRefinedLines,
  applyDialogueLines,
  wordOverlapRatio
} from "../src/application/transcription/refiner.js";

function makePhrases(count, textLength = 100) {
  return Array.from({ length: count }, (_, i) => ({
    speakerId: `speaker-${(i % 2) + 1}`,
    speakerLabel: `Спикер ${(i % 2) + 1}`,
    text: `реплика номер ${i + 1} ` + "слово ".repeat(Math.ceil(textLength / 6)),
    startTimeMs: i * 1000,
    endTimeMs: (i + 1) * 1000
  }));
}

test("buildRefineChunks: короткий транскрипт — один чанк со всеми ID", () => {
  const phrases = makePhrases(5);
  const chunks = buildRefineChunks(phrases);

  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0].ids, [1, 2, 3, 4, 5]);
  assert.equal(chunks[0].contextLines.length, 0);
  assert.match(chunks[0].lines[0], /^\[1\] Спикер 1: /);
});

test("buildRefineChunks: длинный транскрипт — чанки не перекрываются, ID сквозные", () => {
  const phrases = makePhrases(50, 600);
  const chunks = buildRefineChunks(phrases, { chunkChars: 5000 });

  assert.ok(chunks.length > 1, "должно быть несколько чанков");

  // Все ID присутствуют ровно один раз
  const allIds = chunks.flatMap((c) => c.ids);
  assert.equal(allIds.length, 50);
  assert.deepEqual([...new Set(allIds)].sort((a, b) => a - b), allIds);

  // У всех чанков кроме первого есть контекст
  for (const chunk of chunks.slice(1)) {
    assert.ok(chunk.contextLines.length > 0);
  }
});

test("parseRefinedLines: парсит line-ID формат и чистит префикс спикера", () => {
  const raw = `[1] Первая исправленная реплика.
[2] Спикер 2: Вторая реплика с префиксом, который надо убрать.
мусорная строка без номера
[3] Третья.`;

  const { byId, missingIds } = parseRefinedLines(raw, [1, 2, 3, 4]);

  assert.equal(byId.get(1), "Первая исправленная реплика.");
  assert.equal(byId.get(2), "Вторая реплика с префиксом, который надо убрать.");
  assert.equal(byId.get(3), "Третья.");
  assert.deepEqual(missingIds, [4]);
});

test("parseRefinedLines: обрыв вывода детектится как missing", () => {
  const { byId, missingIds } = parseRefinedLines("[1] Полная.\n[2] Обор", [1, 2, 3]);
  assert.equal(byId.size, 2);
  assert.deepEqual(missingIds, [3]);
});

test("extractNumericValues: цифры, числительные, составные числа", () => {
  assert.deepEqual(extractNumericValues("шаг двести, по факту 250"), [200, 250]);
  assert.deepEqual(extractNumericValues("м триста пятьдесят"), [350]);
  assert.deepEqual(extractNumericValues("М350 и КС-2"), [2, 350]);
  assert.deepEqual(extractNumericValues("до двадцатого июня"), [20]);
  assert.deepEqual(extractNumericValues("до двадцать первого июня"), [21]);
  assert.deepEqual(extractNumericValues("один миллион восемьсот тысяч"), [1800000]);
  assert.deepEqual(extractNumericValues("без чисел вообще"), []);
});

test("numbersPreserved: легитимные преобразования проходят", () => {
  // слова → цифры (та же величина)
  assert.ok(numbersPreserved("м триста пятьдесят заказан", "М350 заказан"));
  assert.ok(numbersPreserved("ка эс два передали", "КС-2 передали"));
  // текст без изменения чисел
  assert.ok(numbersPreserved("придут в четверг к семи утра", "Придут в четверг к семи утра."));
});

test("numbersPreserved: подмена даты ловится (кейс Lite из бенчмарка)", () => {
  assert.equal(
    numbersPreserved("кс три до двадцатого июня", "КС-3 до двадцать первого июня"),
    false
  );
  // потеря числа
  assert.equal(numbersPreserved("аванс десять процентов", "аванс согласован"), false);
  // придуманное число
  assert.equal(numbersPreserved("бетон заказан", "бетон М350 заказан"), false);
});

test("applyRefinedLines: применяет правки, валидатор откатывает подмену чисел", () => {
  const phrases = [
    { speakerId: "s1", speakerLabel: "Спикер 1", text: "исполниловка по третьему этажу" },
    { speakerId: "s2", speakerLabel: "Спикер 2", text: "кс три до двадцатого июня" },
    { speakerId: "s1", speakerLabel: "Спикер 1", text: "принял до среды сделаем" }
  ];

  const byId = new Map([
    [1, "Исполнительная документация по третьему этажу."],
    [2, "КС-3 до двадцать первого июня."], // подмена даты!
    [3, "принял до среды сделаем"]          // без изменений
  ]);

  const result = applyRefinedLines(phrases, byId);

  // 1: применено
  assert.equal(result.phrases[0].refined, true);
  assert.equal(result.phrases[0].text, "Исполнительная документация по третьему этажу.");
  assert.equal(result.phrases[0].originalText, "исполниловка по третьему этажу");

  // 2: отклонено валидатором — исходный текст сохранён
  assert.equal(result.phrases[1].refined, false);
  assert.equal(result.phrases[1].refineRejected, "numbers");
  assert.equal(result.phrases[1].text, "кс три до двадцатого июня");

  // 3: текст идентичен — не считается правкой
  assert.equal(result.phrases[2].refined, false);

  assert.equal(result.applied, 1);
  assert.equal(result.rejectedByValidator, 1);

  // Исходный массив не мутирован
  assert.equal(phrases[0].text, "исполниловка по третьему этажу");
});

test("applyDialogueLines: чистка филлеров проходит, подмена чисел и пересказ откатываются", () => {
  const phrases = [
    { speakerId: "s1", speakerLabel: "Иван", text: "ну вот короче я в общем-то думаю что кс три готов уже" },
    { speakerId: "s2", speakerLabel: "Пётр", text: "до двадцатого июня точно успеем сделать фасад" },
    { speakerId: "s1", speakerLabel: "Иван", text: "смотрите там на объекте на харьковской у нас бригады работают и всё идёт по плану, но нужно ещё бетон подвезти" }
  ];

  const byId = new Map([
    [1, "Я думаю, КС-3 уже готов."],                    // убрали филлеры, смысл сохранён
    [2, "До двадцать первого июня успеем сделать фасад."], // подмена даты!
    [3, "Всё по плану."]                                  // пересказ вместо литературной записи — слишком коротко
  ]);

  const result = applyDialogueLines(phrases, byId);

  assert.equal(result.phrases[0].dialogueRewritten, true);
  assert.equal(result.phrases[0].text, "Я думаю, КС-3 уже готов.");
  assert.equal(result.phrases[0].dialogueOriginalText, phrases[0].text);

  assert.equal(result.phrases[1].dialogueRewritten, false);
  assert.equal(result.phrases[1].dialogueRejected, "numbers");
  assert.equal(result.phrases[1].text, phrases[1].text);

  assert.equal(result.phrases[2].dialogueRewritten, false);
  assert.equal(result.phrases[2].dialogueRejected, "too-short");
  assert.equal(result.phrases[2].text, phrases[2].text);

  assert.equal(result.applied, 1);
  assert.equal(result.rejectedByValidator, 2);

  // Исходный массив не мутирован
  assert.equal(phrases[0].text, "ну вот короче я в общем-то думаю что кс три готов уже");
});

test("applyDialogueLines: минимальный порог длины настраивается", () => {
  const phrases = [{ speakerId: "s1", speakerLabel: "Иван", text: "да, согласен полностью с этим предложением" }];
  const byId = new Map([[1, "Согласен."]]); // короче 35%, но допустимо при более мягком пороге

  const strict = applyDialogueLines(phrases, byId);
  assert.equal(strict.phrases[0].dialogueRewritten, false);

  const lenient = applyDialogueLines(phrases, byId, { minLengthRatio: 0.2 });
  assert.equal(lenient.phrases[0].dialogueRewritten, true);
});

test("wordOverlapRatio: пересечение по множеству слов относительно короткого текста", () => {
  assert.equal(wordOverlapRatio("да, давай, конечно", "Да, давай, конечно"), 1);
  assert.equal(wordOverlapRatio("совсем разные слова тут", "ничего общего вообще нет"), 0);
  // "вечером" общее, остальное разное — 1 из 2 слов короткого текста
  assert.equal(wordOverlapRatio("встретимся вечером на объекте", "вечером"), 1);
});

// Найдено на реальной 35-минутной записи 2026-07-14 (628 реплик): в одном
// из чанков DIALOGUE-прохода Pro-модель вернула валидный по формату ответ
// ([N] на каждой строке), но контент реплики 16 дословно совпал с REFINE-
// текстом реплики 24 — сдвиг на 8 позиций внутри чанка. numbersPreserved и
// порог длины это пропускают (чисел нет, длина сопоставима) — только
// пересечение словаря отличает подмену от литературной правки.
test("applyDialogueLines: подмена контента чужой реплики отклоняется (content-mismatch)", () => {
  const phrases = [
    { speakerId: "s2", speakerLabel: "Спикер 2", text: "пусть так и будет, да, всё правильно, соответственно, это искусственный" },
    { speakerId: "s2", speakerLabel: "Спикер 2", text: "ты с заказчиком согласовал схему, ты ему отправил сейчас или ты не отправлял" }
  ];
  const byId = new Map([
    // Реальный сбой: byId[1] получил текст, реально относящийся к byId[2]
    [1, "ты с заказчиком согласовал схему, ты ему отправил сейчас или ты не отправлял"],
    [2, "ты с заказчиком согласовал схему, ты ему отправил сейчас или ты не отправлял."] // легитимно (это его собственный текст)
  ]);

  const result = applyDialogueLines(phrases, byId);

  assert.equal(result.phrases[0].dialogueRewritten, false);
  assert.equal(result.phrases[0].dialogueRejected, "content-mismatch");
  assert.equal(result.phrases[0].text, phrases[0].text); // откат на исходный (refine) текст

  assert.equal(result.phrases[1].dialogueRewritten, true);
  assert.equal(result.rejectedByValidator, 1);
  assert.equal(result.applied, 1);
});

test("applyDialogueLines: порог пересечения слов настраивается", () => {
  const phrases = [{ speakerId: "s1", speakerLabel: "Иван", text: "полностью согласен с этим планом работ" }];
  const byId = new Map([[1, "совершенно другая формулировка мысли тут"]]); // overlap = 0

  const strict = applyDialogueLines(phrases, byId);
  assert.equal(strict.phrases[0].dialogueRejected, "content-mismatch");

  const permissive = applyDialogueLines(phrases, byId, { minWordOverlap: 0 });
  assert.equal(permissive.phrases[0].dialogueRewritten, true);
});
