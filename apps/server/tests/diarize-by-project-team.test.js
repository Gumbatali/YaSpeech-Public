import test from "node:test";
import assert from "node:assert/strict";
import { MeetingPipelineService } from "../src/application/meeting-pipeline-service.js";

class FakeClock {
  constructor(startIso) {
    this.current = new Date(startIso);
  }
  now() {
    return new Date(this.current);
  }
}

/**
 * runRefinePhase больше не диаризует только mono-транскрипты — она ВСЕГДА
 * зовёт diarizeByProjectTeam с составом участников встречи (команда проекта,
 * отфильтрованная по participantIds, + гости). Эти тесты проверяют именно
 * то, что pipeline вычисляет этот список правильно и передаёт его дальше —
 * без них расчёт participantNames мог незаметно сломаться при рефакторинге.
 */
function makeService({ diarizeByProjectTeam, meetingRepository, artifactStorage }) {
  return new MeetingPipelineService({
    meetingRepository,
    projectRepository: { getGlossary: async () => null },
    artifactStorage,
    speechKitGateway: null,
    yandexGptGateway: {
      analyzeContext: async () => ({ domain: "строительство", mainTopics: [], mentionedEntities: {} }),
      diarizeByProjectTeam,
      extractGlossary: async () => null,
      refineLines: async ({ ids }) => ({ byId: new Map(), missingIds: ids }),
      identifySpeakers: async () => null
    },
    queueRunner: { enqueue: async () => {} },
    clock: new FakeClock("2026-07-14T10:00:00.000Z")
  });
}

function makeArtifactStorage(transcript) {
  const store = new Map([["projects/p/transcript.json", transcript]]);
  return {
    readJson: async (key) => store.get(key) ?? null,
    writeJson: async (key, value) => { store.set(key, value); }
  };
}

function makeMeetingRepository(meeting) {
  let current = meeting;
  return {
    getById: async () => current,
    save: async (updated) => { current = updated; }
  };
}

const baseTranscript = {
  rawText: "Спикер 1: привет всем, начинаем совещание по объекту",
  phrases: [{ speakerId: "speaker-1", speakerLabel: "Спикер 1", text: "привет всем, начинаем совещание по объекту" }]
};

test("runRefinePhase передаёт в diarizeByProjectTeam участников встречи, отфильтрованных по participantIds", async () => {
  let receivedParticipants = null;
  const diarizeByProjectTeam = async (transcript, domain, participants) => {
    receivedParticipants = participants;
    return transcript;
  };

  const meeting = {
    id: "m1",
    projectId: "p",
    participantIds: ["u1"],
    guests: [{ name: "Гость Иванов" }],
    artifacts: { transcriptKey: "projects/p/transcript.json" },
    llmRefine: { requestedAt: "2026-07-14T10:00:00.000Z" }
  };
  const project = {
    team: [
      { id: "u1", name: "Алексей Иванов" },
      { id: "u2", name: "Мария Петрова" } // не участвует в этой встрече — не должна попасть в список
    ]
  };

  const service = makeService({
    diarizeByProjectTeam,
    meetingRepository: makeMeetingRepository(meeting),
    artifactStorage: makeArtifactStorage(baseTranscript)
  });

  await service.runRefinePhase(meeting, project);

  assert.deepEqual(receivedParticipants, ["Алексей Иванов", "Гость Иванов"]);
});

test("runRefinePhase: если participantIds пуст, передаёт всю команду проекта + гостей", async () => {
  let receivedParticipants = null;
  const diarizeByProjectTeam = async (transcript, domain, participants) => {
    receivedParticipants = participants;
    return transcript;
  };

  const meeting = {
    id: "m2",
    projectId: "p",
    participantIds: [],
    guests: [],
    artifacts: { transcriptKey: "projects/p/transcript.json" },
    llmRefine: { requestedAt: "2026-07-14T10:00:00.000Z" }
  };
  const project = {
    team: [
      { id: "u1", name: "Алексей Иванов" },
      { id: "u2", name: "Мария Петрова" }
    ]
  };

  const service = makeService({
    diarizeByProjectTeam,
    meetingRepository: makeMeetingRepository(meeting),
    artifactStorage: makeArtifactStorage(baseTranscript)
  });

  await service.runRefinePhase(meeting, project);

  assert.deepEqual(receivedParticipants, ["Алексей Иванов", "Мария Петрова"]);
});

test("runRefinePhase: без проекта (null) не падает и передаёт пустой список участников", async () => {
  let receivedParticipants = "not-called";
  const diarizeByProjectTeam = async (transcript, domain, participants) => {
    receivedParticipants = participants;
    return transcript;
  };

  const meeting = {
    id: "m3",
    projectId: "p",
    participantIds: [],
    guests: [],
    artifacts: { transcriptKey: "projects/p/transcript.json" },
    llmRefine: { requestedAt: "2026-07-14T10:00:00.000Z" }
  };

  const service = makeService({
    diarizeByProjectTeam,
    meetingRepository: makeMeetingRepository(meeting),
    artifactStorage: makeArtifactStorage(baseTranscript)
  });

  await service.runRefinePhase(meeting, null);

  assert.deepEqual(receivedParticipants, []);
});
