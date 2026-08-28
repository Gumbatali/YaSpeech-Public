import test from "node:test";
import assert from "node:assert/strict";
import { repairNestedSummarySchema, YcYandexGptGateway } from "../src/infrastructure/yc-yandex-gpt-gateway.js";

// Найдено на реальном прогоне protocol-пайплайна (oktyabrskaya-2,
// research/diarization-asr-lab, --c1-samples 5): C1 иногда вкладывает
// participants/topics/decisions/actionItems/... внутрь summary вместо
// плоской схемы. summary.overview при этом валиден, поэтому такой сэмпл
// может выиграть отбор "лучшего" по длине overview — и его topics/decisions
// молча пропадают из финального протокола. См. FINDINGS.md раздел 18.

test("repairNestedSummarySchema: поднимает поля из вложенного summary на верхний уровень", () => {
  const malformed = {
    summary: {
      title: "Планёрка",
      overview: "Обсудили статус проектов.",
      participants: ["Данил", "Настя"],
      topics: [{ title: "Статус", narrative: "..." }],
      decisions: ["Решение 1"],
      actionItems: [{ owner: "Настя", task: "Сделать X", deadline: null }]
    },
    topics: [],
    participants: [],
    decisions: [],
    actionItems: []
  };
  const repaired = repairNestedSummarySchema(malformed);
  assert.deepEqual(repaired.summary, { title: "Планёрка", overview: "Обсудили статус проектов." });
  assert.equal(repaired.topics.length, 1);
  assert.equal(repaired.participants.length, 2);
  assert.equal(repaired.decisions.length, 1);
  assert.equal(repaired.actionItems.length, 1);
});

test("repairNestedSummarySchema: не трогает уже плоскую схему", () => {
  const flat = {
    summary: { title: "Планёрка", overview: "Обзор." },
    topics: [{ title: "A", narrative: "B" }],
    participants: ["Данил"],
    decisions: [],
    actionItems: []
  };
  const repaired = repairNestedSummarySchema(flat);
  assert.equal(repaired.topics.length, 1);
  assert.equal(repaired.participants.length, 1);
});

test("repairNestedSummarySchema: не перезаписывает уже непустой верхний уровень вложенным", () => {
  const mixed = {
    summary: { title: "Планёрка", overview: "Обзор.", topics: [{ title: "Вложенная", narrative: "не должна победить" }] },
    topics: [{ title: "Настоящая", narrative: "уже на верхнем уровне" }]
  };
  const repaired = repairNestedSummarySchema(mixed);
  assert.equal(repaired.topics.length, 1);
  assert.equal(repaired.topics[0].title, "Настоящая");
});

test("repairNestedSummarySchema: без summary-объекта или с summary-строкой не падает", () => {
  assert.deepEqual(repairNestedSummarySchema(null), null);
  assert.deepEqual(repairNestedSummarySchema({ summary: "просто строка" }), { summary: "просто строка" });
  assert.deepEqual(repairNestedSummarySchema(undefined), undefined);
});

// Найдено при ревью (не на реальном прогоне): generateProtocol звал
// qaProtocol без try/catch — сбой D1/D2 (квота/сеть, после исчерпания
// встроенных ретраев YandexGptClient.complete) ронял весь вызов целиком,
// теряя уже готовый protocol из extractProtocol/extractProtocolLong. Тот
// же класс бага уже был исправлен в лабораторном скрипте раньше прода
// (research/diarization-asr-lab/FINDINGS.md раздел 19).
test("generateProtocol: сбой qaProtocol не теряет уже извлечённый протокол", async () => {
  const gateway = new YcYandexGptGateway({ folderId: "test-folder" });
  const extractedProtocol = {
    summary: { title: "Тест", overview: "Обзор" },
    topics: [], participants: ["Данил"], decisions: [], actionItems: [],
    completedFromPrevious: [], carriedForward: [], openQuestions: [], transcriptHighlights: []
  };
  gateway.extractProtocol = async () => extractedProtocol;
  gateway.qaProtocol = async () => { throw new Error("simulated D1/D2 failure"); };

  const meeting = { gptContext: { domain: "тест", correctedText: "текст встречи" }, speakerDrafts: [] };
  const project = { name: "Проект" };
  const transcript = { rawText: "текст встречи" };

  const { protocol } = await gateway.generateProtocol({ meeting, project, transcript });
  assert.deepEqual(protocol, extractedProtocol, "сбой QA не должен отбрасывать уже готовый протокол");
});

// Порт ансамбля C1 из research/diarization-asr-lab/score/preview-protocol.mjs
// (--c1-samples) — см. FINDINGS.md разделы 11, 18-20. Мокаем extractProtocolOnce,
// чтобы проверить именно логику слияния N сэмплов, не реальный LLM-вызов.
test("extractProtocol: ансамбль сливает N сэмплов — берёт summary у самого длинного, дедупит задачи, объединяет participants", async () => {
  const gateway = new YcYandexGptGateway({ folderId: "test-folder" });
  const fakeSamples = [
    {
      summary: { title: "Планёрка", overview: "Короткий обзор." },
      topics: [{ title: "Короткая тема", narrative: "..." }],
      participants: ["Данил", "Настя"],
      decisions: ["Решение А"],
      actionItems: [{ owner: "Настя", task: "Подготовить смету по объекту Рыбинск", deadline: null }],
      completedFromPrevious: [], carriedForward: [],
      openQuestions: ["Вопрос 1"], transcriptHighlights: []
    },
    {
      summary: { title: "Планёрка", overview: "Гораздо более длинный и подробный обзор встречи со всеми деталями." },
      topics: [{ title: "Победившая тема", narrative: "должна выиграть по длине overview" }],
      participants: ["Данил", "Влад"],
      decisions: ["Решение А (перефразировано почти так же)"],
      actionItems: [{ owner: "Настя", task: "Накидать смету по объекту в Рыбинске для сравнения", deadline: null }],
      completedFromPrevious: [], carriedForward: [],
      openQuestions: ["Вопрос 1, но другими словами"], transcriptHighlights: []
    }
  ];
  let callCount = 0;
  gateway.extractProtocolOnce = async () => fakeSamples[callCount++];
  // Задачи-дубли в fakeSamples сформулированы по-разному настолько, что
  // попадают в "серую зону" триграммного дедупа (раздел 11/19 FINDINGS.md)
  // — реальный пайплайн отдаёт такие пары на прямой вопрос модели через
  // b2c1Client.completeBatch. Мокаем его, чтобы тест был герметичным и не
  // бил по реальной сети.
  gateway.b2c1Client = { completeBatch: async (requests) => requests.map(() => JSON.stringify({ same: true })) };

  const meeting = { titleDraft: null, date: "2026-08-21" };
  const project = { name: "Проект" };
  const speakers = [];

  process.env.GPT_C1_SAMPLES = "2";
  try {
    const protocol = await gateway.extractProtocol({
      correctedText: "текст", meeting, project, context: {}, speakers, previousProtocol: null
    });
    assert.equal(protocol.summary.overview, fakeSamples[1].summary.overview, "summary должен быть от сэмпла с более длинным overview");
    assert.equal(protocol.topics[0].title, "Победившая тема", "topics должны быть от того же сэмпла, что и summary");
    assert.deepEqual(new Set(protocol.participants), new Set(["Данил", "Настя", "Влад"]), "participants объединяются по всем сэмплам");
    assert.equal(protocol.actionItems.length, 1, "две формулировки одной и той же задачи должны схлопнуться дедупом");
  } finally {
    delete process.env.GPT_C1_SAMPLES;
  }
});
