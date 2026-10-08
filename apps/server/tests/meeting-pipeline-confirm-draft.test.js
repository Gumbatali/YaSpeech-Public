import test from "node:test";
import assert from "node:assert/strict";
import { MeetingPipelineService } from "../src/application/meeting-pipeline-service.js";

function makeService(speakerDrafts) {
  let meeting = {
    id: "m1",
    projectId: "p1",
    status: "draft_ready",
    currentStage: "draft_ready",
    titleDraft: "Встреча",
    speakerDrafts
  };
  const meetingRepository = {
    async getById(id) { return id === meeting.id ? { ...meeting } : null; },
    async save(updated) { meeting = { ...updated }; return meeting; },
    current: () => meeting
  };
  const service = new MeetingPipelineService({
    meetingRepository,
    projectRepository: {},
    artifactStorage: {},
    speechKitGateway: {},
    yandexGptGateway: {},
    queueRunner: { async enqueue() {} },
    clock: { now: () => new Date("2026-10-08T00:00:00.000Z") }
  });
  return { service, meetingRepository };
}

const draft = (id, guessedName, confidence = "high") => ({
  id, label: `Спикер ${id}`, guessedName, guessedRole: null, dialogueRole: null, confidence
});

test("confirmDraft: сохраняет предположение B2 рядом с подтверждённым именем", async () => {
  const { service, meetingRepository } = makeService([
    draft("s1", "Артем"),
    draft("s2", "Наталья", "low"),
    draft("s3", null, "low")
  ]);

  await service.confirmDraft("m1", {
    speakerDrafts: [
      draft("s1", "Артем"),
      draft("s2", "Настя Хохлова"),
      draft("s3", "Вячеслав", "unknown")
    ]
  });

  const saved = meetingRepository.current().speakerDrafts;
  assert.deepEqual(
    saved.map((s) => [s.id, s.guessedName, s.proposedName, s.proposedConfidence]),
    [
      ["s1", "Артем", "Артем", "high"],
      ["s2", "Настя Хохлова", "Наталья", "low"],
      ["s3", "Вячеслав", null, "low"]
    ]
  );
});

test("confirmDraft: повторное подтверждение не затирает исходное предположение", async () => {
  const { service, meetingRepository } = makeService([draft("s1", "Семен")]);

  await service.confirmDraft("m1", { speakerDrafts: [draft("s1", "Данила")] });
  await service.confirmDraft("m1", { speakerDrafts: [draft("s1", "Влад")] });

  const [saved] = meetingRepository.current().speakerDrafts;
  assert.equal(saved.guessedName, "Влад");
  assert.equal(saved.proposedName, "Семен");
});

test("confirmDraft: предположение берётся из хранилища, а не из тела запроса", async () => {
  const { service, meetingRepository } = makeService([draft("s1", "Артем")]);

  await service.confirmDraft("m1", {
    speakerDrafts: [{ ...draft("s1", "Владимир"), proposedName: "Подделка" }]
  });

  assert.equal(meetingRepository.current().speakerDrafts[0].proposedName, "Артем");
});

test("confirmDraft: пустой speakerDrafts оставляет сохранённые черновики как есть", async () => {
  const stored = [draft("s1", "Артем")];
  const { service, meetingRepository } = makeService(stored);

  await service.confirmDraft("m1", { speakerDrafts: [] });

  assert.deepEqual(meetingRepository.current().speakerDrafts, stored);
});
