import test from "node:test";
import assert from "node:assert/strict";
import {
  dedupeSimilarTasks,
  dedupeSimilarStrings,
  findBorderlineTaskPairs,
  findEntityOverlapPairs,
  findAllBorderlinePairs,
  resolveBorderlinePairsWithLLM
} from "../src/infrastructure/yc-yandex-gpt-gateway.js";

// Пары найдены на реальных прогонах protocol-пайплайна (oktyabrskaya-2,
// research/diarization-asr-lab) — не синтетика. Настоящий дубль (первая
// пара) исторически не ловился текущим порогом (word-overlap ratio 0.667
// < 0.7 из-за разных падежных окончаний "панеля"/"панели") — см.
// research/diarization-asr-lab/FINDINGS.md.

test("dedupeSimilarTasks: ловит перефразированный дубль с разными падежными окончаниями", () => {
  const items = [
    { owner: "Настя", task: "Накидать смету на вариант со сэндвич-панелями для сравнения стоимости с бетонными плитами", deadline: null },
    { owner: "Настя", task: "Накидать смету на замену плит на сэндвич-панели для сравнения стоимости", deadline: null }
  ];
  const result = dedupeSimilarTasks(items);
  assert.equal(result.length, 1, "два перефразирования одной и той же задачи должны схлопнуться в одну");
});

test("dedupeSimilarTasks: ловит дубль с разным числом (единственное/множественное)", () => {
  const items = [
    { owner: "Настя", task: "Связаться с заказчиком по Старому Осколу и уточнить наличие отчетов и трек-номера", deadline: null },
    { owner: "Настя", task: "Связаться с заказчиком по Старому Осколу и уточнить наличие отчетов и трек-номеров", deadline: null }
  ];
  const result = dedupeSimilarTasks(items);
  assert.equal(result.length, 1);
});

test("dedupeSimilarTasks: НЕ схлопывает структурно похожие, но разные задачи", () => {
  const items = [
    { owner: "Данил", task: "Связаться с заказчиком по Старому Осколу и уточнить наличие отчетов и трек-номера", deadline: null },
    { owner: "Данил", task: "Связаться с Верой Николаевной по объекту в Базарево, запросить проектную документацию", deadline: null }
  ];
  const result = dedupeSimilarTasks(items);
  assert.equal(result.length, 2, "разные объекты/адресаты — разные задачи, не должны схлопываться");
});

test("dedupeSimilarTasks: НЕ схлопывает разные задачи с общим глаголом", () => {
  const items = [
    { owner: "Настя", task: "Подготовить дефектные ведомости для Рыбинска и Апатитов", deadline: null },
    { owner: "Настя", task: "Подготовить дефектные акты и графики по Старому Осколу и Ярославлю", deadline: null }
  ];
  const result = dedupeSimilarTasks(items);
  assert.equal(result.length, 2);
});

test("dedupeSimilarTasks: разные owner не схлопываются, даже если текст идентичен", () => {
  const items = [
    { owner: "Данил", task: "Отправить документы по Алексину и Рыбинску, скорректировать замечания по Рыбинску.", deadline: null },
    { owner: "Александр", task: "Отправить документы по Алексину и Рыбинску, скорректировать замечания по Рыбинску.", deadline: null }
  ];
  const result = dedupeSimilarTasks(items);
  assert.equal(result.length, 2, "одинаковый текст на разных исполнителей — это по построению разные пункты (owner не сравнивается как текст)");
});

test("dedupeSimilarTasks: одинаковый owner с ё/е-вариацией написания схлопывается", () => {
  // Найдено на реальном прогоне (встреча 3, --b2-votes 7): "Семён" и
  // "Семен" — два разных ensemble-сэмпла назвали одного и того же
  // человека по-разному ("ё" и "е" — разные code point в JS-строке).
  const items = [
    { owner: "Семён", task: "Завершить договор по Якутии 11 МКД до четверга", deadline: null },
    { owner: "Семен", task: "Довести договор по Якутии 11 МКД до четверга", deadline: null }
  ];
  const result = dedupeSimilarTasks(items);
  assert.equal(result.length, 1, "ё/е-вариант написания одного имени не должен создавать двух разных owner");
});

test("findBorderlineTaskPairs: реальный пропущенный дубль с N=9 сэмплов попадает в серую зону", () => {
  const items = [
    { owner: "Александр", task: "Разобраться с отчетом по Харьковской 9 и связаться с Романовым" },
    { owner: "Александр", task: "Разобраться с отчетом по Харьковская 9, связаться с Полиной и Данилом по поводу выезда в Москву." },
    { owner: "Настя", task: "Проверить трек-номера по отправленным отчетам по школам в Самаре" }
  ];
  const pairs = findBorderlineTaskPairs(items);
  assert.equal(pairs.length, 1, "пара 0-1 (одинаковый owner, похожий текст) должна попасть в серую зону");
  assert.deepEqual([pairs[0].i, pairs[0].j], [0, 1]);
});

test("findBorderlineTaskPairs: не сравнивает разных owner", () => {
  const items = [
    { owner: "Александр", task: "Разобраться с отчетом по Харьковской 9" },
    { owner: "Данил", task: "Разобраться с отчетом по Харьковской 9" }
  ];
  assert.equal(findBorderlineTaskPairs(items).length, 0);
});

test("findBorderlineTaskPairs: реальный пропущенный дубль-кластер 'защитки по Приморскому району' (встреча 4, merged+7/5) попадает в серую зону", () => {
  // Найдено на реальном прогоне (research/diarization-asr-lab,
  // oktyabrskaya-4-merged-r2) — 4 формулировки одной и той же задачи
  // (подготовить/забрать защитные документы по Приморскому району)
  // пережили и триграммный дедуп, и первую версию LLM-промпта
  // (симметричное "одна и та же задача, даже если слова разные?" —
  // слишком легко отвечало false на разный глагол при том же районе).
  // См. FINDINGS.md раздел 18.
  const items = [
    { owner: "Настя", task: "Подготовить защитные документы (защиточки) для Приморского объекта." },
    { owner: "Настя", task: "Подготовить защитные папки по Приморскому району" },
    { owner: "Настя", task: "Взять в работу защитные материалы по Приморскому району (2 защиточки от Старикова)" },
    { owner: "Настя", task: "Взять в работу защитки по Приморскому району (папка 198) и Адмиралтейскому, чтобы не пропустить сроки." }
  ];
  const pairs = findBorderlineTaskPairs(items);
  assert.ok(pairs.length >= 3, "большинство из 6 пар в кластере должны попасть в серую зону 0.3-0.6");
});

test("resolveBorderlinePairsWithLLM: мержит пару, если LLM говорит 'same'", async () => {
  const items = [
    { owner: "Александр", task: "Разобраться с отчетом по Харьковской 9 и связаться с Романовым" },
    { owner: "Александр", task: "Разобраться с отчетом по Харьковская 9, связаться с Полиной и Данилом по поводу выезда в Москву." }
  ];
  const pairs = findBorderlineTaskPairs(items);
  const mockCompleteBatch = async (requests) => requests.map(() => '{"same": true}');
  const result = await resolveBorderlinePairsWithLLM(items, pairs, mockCompleteBatch);
  assert.equal(result.length, 1, "LLM подтвердил дубль — должна остаться одна задача");
});

test("resolveBorderlinePairsWithLLM: НЕ мержит, если LLM говорит 'different'", async () => {
  const items = [
    { owner: "Александр", task: "Разобраться с отчетом по Харьковской 9 и связаться с Романовым" },
    { owner: "Александр", task: "Разобраться с отчетом по Харьковская 9, связаться с Полиной и Данилом по поводу выезда в Москву." }
  ];
  const pairs = findBorderlineTaskPairs(items);
  const mockCompleteBatch = async (requests) => requests.map(() => '{"same": false}');
  const result = await resolveBorderlinePairsWithLLM(items, pairs, mockCompleteBatch);
  assert.equal(result.length, 2, "LLM сказал 'разные' — обе задачи должны остаться");
});

test("resolveBorderlinePairsWithLLM: сбой LLM не мержит наугад (fail-safe)", async () => {
  const items = [
    { owner: "Александр", task: "Разобраться с отчетом по Харьковской 9 и связаться с Романовым" },
    { owner: "Александр", task: "Разобраться с отчетом по Харьковская 9, связаться с Полиной и Данилом по поводу выезда в Москву." }
  ];
  const pairs = findBorderlineTaskPairs(items);
  const failingCompleteBatch = async () => { throw new Error("network error"); };
  const result = await resolveBorderlinePairsWithLLM(items, pairs, failingCompleteBatch);
  assert.equal(result.length, 2, "сбой сети — обе задачи остаются как есть, не мержим наугад");
});

test("findEntityOverlapPairs: ловит поглощение — 'пачка' объектов vs гранулярная задача по одному из них", () => {
  // Найдено на реальном прогоне (research/diarization-asr-lab,
  // oktyabrskaya-4-merged, --c1-samples 5): один C1-сэмпл пакует 6
  // объектов в одну задачу, другой сэмпл — те же объекты по отдельности.
  // Текст почти не пересекается по триграммам (findBorderlineTaskPairs
  // эту пару не находит), но пересекается по топонимам-сущностям.
  const items = [
    { owner: "Данил", task: "Направить на согласование/печать отчеты по Воронежу, Клинцам, Тонской, Северо-Задонску, Сокольникам, Донской" },
    { owner: "Данил", task: "Направить заключение по Клинцам (водонапорная башня) Славе на проверку" },
    { owner: "Данил", task: "Направить заключение по Сокольникам (Московская область) в конце четверга" },
    { owner: "Настя", task: "Проверить трек-номера по отправленным отчетам по школам в Самаре" }
  ];
  const entityPairs = findEntityOverlapPairs(items);
  const keys = new Set(entityPairs.map((p) => `${p.i}:${p.j}`));
  assert.ok(keys.has("0:1"), "пачка (0) должна пересечься по сущностям с Клинцами (1)");
  assert.ok(keys.has("0:2"), "пачка (0) должна пересечься по сущностям с Сокольниками (2)");
  assert.ok(!keys.has("0:3") && !keys.has("1:3") && !keys.has("2:3"), "не должно пересекаться с не связанной задачей по Самаре");
});

test("findEntityOverlapPairs: не сравнивает разных owner", () => {
  const items = [
    { owner: "Данил", task: "Направить заключение по Клинцам и Донской" },
    { owner: "Александр", task: "Заняться Клинцами на этой неделе" }
  ];
  assert.equal(findEntityOverlapPairs(items).length, 0);
});

test("findEntityOverlapPairs: КАПС-акроним (УКН) считается сущностью наравне со словом с большой буквы", () => {
  // Найдено при код-ревью: исходный паттерн ловил только "Слово-с-Большой-
  // буквы", акронимы (УКН, МКД, СОШ) без сопутствующего номера папки рядом
  // были невидимы для детектора.
  const items = [
    { owner: "Данил", task: "Отправить схемы заказчику по УКН" },
    { owner: "Данил", task: "Направить согласованные схемы заказчику по объекту УКН" },
    { owner: "Данил", task: "Составить программу мониторинга по Калуге" }
  ];
  const pairs = findEntityOverlapPairs(items);
  const keys = new Set(pairs.map((p) => `${p.i}:${p.j}`));
  assert.ok(keys.has("0:1"), "оба пункта про УКН должны пересечься по сущности");
  assert.ok(!keys.has("0:2") && !keys.has("1:2"), "Калуга — не связанная задача");
});

test("findAllBorderlinePairs: объединяет текстовый и сущностный детектор без дублей пар", () => {
  const items = [
    { owner: "Александр", task: "Разобраться с отчетом по Харьковской 9 и связаться с Романовым" },
    { owner: "Александр", task: "Разобраться с отчетом по Харьковская 9, связаться с Полиной и Данилом по поводу выезда в Москву." }
  ];
  // Одна и та же пара 0-1 должна найтись текстовым детектором и
  // потенциально сущностным (общая "Харьковской"/"9") — на выходе одна
  // запись, не две
  const pairs = findAllBorderlinePairs(items);
  const keys = new Set(pairs.map((p) => `${p.i}:${p.j}`));
  assert.equal(keys.size, pairs.length, "не должно быть повторяющихся пар индексов");
});

test("dedupeSimilarStrings: та же морфологическая ловушка на decisions/openQuestions", () => {
  const items = [
    "Накидать смету на вариант со сэндвич-панелями для сравнения стоимости с бетонными плитами",
    "Накидать смету на замену плит на сэндвич-панели для сравнения стоимости"
  ];
  const result = dedupeSimilarStrings(items);
  assert.equal(result.length, 1);
});
