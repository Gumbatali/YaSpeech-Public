import test from "node:test";
import assert from "node:assert/strict";
import { MeetingPipelineService } from "../src/application/meeting-pipeline-service.js";

function fakeClock() {
  return { now: () => new Date("2026-08-29T00:00:00.000Z") };
}

function fakeMeetingRepository(initial) {
  let meeting = { ...initial };
  return {
    async getById(id) {
      return id === meeting.id ? { ...meeting } : null;
    },
    async save(updated) {
      meeting = { ...updated };
      return meeting;
    },
    _current: () => meeting
  };
}

function fakeQueueRunner() {
  const enqueued = [];
  return {
    enqueued,
    async enqueue(key, _task, options) {
      enqueued.push({ key, options });
    }
  };
}

function baseMeeting(overrides = {}) {
  return {
    id: "m1",
    projectId: "p1",
    status: "protocol_generating",
    currentStage: "protocol_generating",
    artifacts: {
      audioOriginalKey: "base/audio.wav",
      transcriptKey: "base/transcript.json",
      protocolJsonKey: "base/protocol.json",
      protocolTextKey: "base/protocol.txt",
      manifestKey: "base/meeting.json",
      baseKey: "base"
    },
    ...overrides
  };
}

test("processMeeting: протокол ждёт refine (queued) вместо сборки по сырому тексту", async () => {
  const meeting = baseMeeting({ llmRefine: { status: "queued" } });
  const meetingRepository = fakeMeetingRepository(meeting);
  const queueRunner = fakeQueueRunner();
  const projectRepository = { async getById() { return { id: "p1", name: "Проект" }; } };

  const service = new MeetingPipelineService({
    meetingRepository,
    projectRepository,
    artifactStorage: {},
    speechKitGateway: {},
    yandexGptGateway: { generateProtocol() { throw new Error("не должен вызываться, пока refine не done/failed"); } },
    queueRunner,
    clock: fakeClock()
  });

  await service.processMeeting("m1", "poll-refine");

  assert.equal(meetingRepository._current().status, "protocol_generating", "статус не должен продвинуться");
  assert.ok(
    queueRunner.enqueued.some((e) => e.key === "meeting:m1:poll-refine"),
    "должна быть пере-поставлена та же фаза ожидания"
  );
});

test("processMeeting: протокол собирается, когда refine done", async () => {
  const meeting = baseMeeting({ llmRefine: { status: "done" } });
  const meetingRepository = fakeMeetingRepository(meeting);
  const queueRunner = fakeQueueRunner();
  const projectRepository = { async getById() { return { id: "p1", name: "Проект" }; } };
  let generateProtocolCalled = false;

  const service = new MeetingPipelineService({
    meetingRepository,
    projectRepository,
    artifactStorage: {},
    speechKitGateway: {},
    yandexGptGateway: {},
    queueRunner,
    clock: fakeClock()
  });
  service.generateProtocol = async () => { generateProtocolCalled = true; };

  await service.processMeeting("m1", "poll-refine");

  assert.ok(generateProtocolCalled, "generateProtocol должен быть вызван, когда refine уже done");
});

test("startDiarizePhase: без diarizationGateway пропускает диаризацию и идёт сразу в draft", async () => {
  const meeting = baseMeeting({ status: "speechkit_processing", currentStage: "speechkit_processing" });
  const meetingRepository = fakeMeetingRepository(meeting);
  const queueRunner = fakeQueueRunner();
  const project = { id: "p1", name: "Проект" };
  const rawTranscript = {
    rawText: "это достаточно длинный текст для прохождения проверки качества расшифровки да действительно очень длинный текст с достаточным количеством слов чтобы пройти проверку качества расшифровки успешно",
    phrases: [{ speakerId: "speaker-1", speakerLabel: "Спикер 1", startTimeMs: 0, endTimeMs: 1000, text: "текст" }]
  };

  const service = new MeetingPipelineService({
    meetingRepository,
    projectRepository: { async getById() { return project; } },
    artifactStorage: {
      writeJson: async () => {},
      readJson: async () => rawTranscript
    },
    speechKitGateway: {},
    yandexGptGateway: {},
    diarizationGateway: { available: false },
    queueRunner,
    clock: fakeClock()
  });

  let prepareDraftCalled = false;
  service.prepareDraftFromTranscript = async () => { prepareDraftCalled = true; };

  await service.startDiarizePhase(meeting, project, "job-1", rawTranscript);

  assert.ok(prepareDraftCalled, "должен пропустить диаризацию и продолжить сборку черновика");
  assert.equal(queueRunner.enqueued.length, 0, "не должен ставить poll-diarize, если сервис недоступен");
});

test("startDiarizePhase: с diarizationGateway запускает job и ставит poll-diarize", async () => {
  const meeting = baseMeeting({ status: "speechkit_processing", currentStage: "speechkit_processing" });
  const meetingRepository = fakeMeetingRepository(meeting);
  const queueRunner = fakeQueueRunner();
  const project = { id: "p1", name: "Проект" };
  const rawTranscript = {
    rawText: "это достаточно длинный текст для прохождения проверки качества расшифровки да действительно очень длинный текст с достаточным количеством слов чтобы пройти проверку качества расшифровки успешно",
    phrases: [{ speakerId: "speaker-1", speakerLabel: "Спикер 1", startTimeMs: 0, endTimeMs: 1000, text: "текст" }]
  };

  let startJobCalledWith = null;
  const service = new MeetingPipelineService({
    meetingRepository,
    projectRepository: { async getById() { return project; } },
    artifactStorage: { writeJson: async () => {} },
    speechKitGateway: {},
    yandexGptGateway: {},
    diarizationGateway: {
      available: true,
      async startJob(args) { startJobCalledWith = args; return { jobId: "diar-1" }; }
    },
    queueRunner,
    clock: fakeClock()
  });

  await service.startDiarizePhase(meeting, project, "job-1", rawTranscript);

  assert.equal(startJobCalledWith.audioKey, "base/audio.wav");
  assert.equal(meetingRepository._current().status, "diarizing");
  assert.equal(meetingRepository._current().diarizationJobId, "diar-1");
  assert.ok(queueRunner.enqueued.some((e) => e.key === "meeting:m1:poll-diarize"));
});
