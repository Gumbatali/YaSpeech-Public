import test from "node:test";
import assert from "node:assert/strict";
import { repairNestedSummarySchema } from "../src/infrastructure/yc-yandex-gpt-gateway.js";

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
