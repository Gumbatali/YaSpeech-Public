import test from "node:test";
import assert from "node:assert/strict";
import { MeetingPipelineService } from "../src/application/meeting-pipeline-service.js";

function makeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    async readJson(k) { return data.has(k) ? structuredClone(data.get(k)) : null; },
    async writeJson(k, v) { data.set(k, structuredClone(v)); }
  };
}

function makeService({ storage, meeting, embeddings = null }) {
  let current = meeting;
  return new MeetingPipelineService({
    meetingRepository: {
      async getById() { return { ...current }; },
      async save(m) { current = { ...m }; return current; }
    },
    projectRepository: {},
    artifactStorage: storage,
    speechKitGateway: {},
    yandexGptGateway: {},
    diarizationGateway: { async readEmbeddings() { return embeddings; } },
    queueRunner: { async enqueue() {} },
    clock: { now: () => new Date("2026-10-09T00:00:00.000Z") }
  });
}

const meeting = {
  id: "m1",
  projectId: "p1",
  artifacts: { transcriptKey: "meetings/m1/transcript.json" },
  speakerDrafts: [
    { id: "speaker-1", label: "Спикер 1", guessedName: "Артем", confidence: "high" },
    { id: "speaker-2", label: "Спикер 2", guessedName: null, confidence: "low" }
  ]
};

test("saveVoiceEmbeddings: эмбеддинги привязываются к итоговым id после переименования по talk time", async () => {
  // RTTM-метки A < B < C -> speaker-1/2/3; по talk time A стал speaker-2, B — speaker-1
  const storage = makeStorage({
    "meetings/m1/transcript.json": {
      phrases: [
        { speakerId: "speaker-2", originalSpeakerId: "speaker-1" },
        { speakerId: "speaker-1", originalSpeakerId: "speaker-2" }
      ]
    }
  });
  const service = makeService({ storage, meeting });

  await service.saveVoiceEmbeddings(
    meeting,
    { embeddingsKey: "k" },
    [{ speaker: "SPEAKER_A" }, { speaker: "SPEAKER_B" }]
  );
  // makeService не вернул эмбеддинги -> ничего не пишем
  assert.equal(storage.data.has("meetings/m1/transcript.voice.json"), false);

  const withEmb = makeService({
    storage, meeting,
    embeddings: { model: "m", speakers: { SPEAKER_A: [1, 0], SPEAKER_B: [0, 1] } }
  });
  await withEmb.saveVoiceEmbeddings(
    meeting,
    { embeddingsKey: "k" },
    [{ speaker: "SPEAKER_A" }, { speaker: "SPEAKER_B" }]
  );
  const saved = storage.data.get("meetings/m1/transcript.voice.json");
  assert.deepEqual(saved.bySpeakerId, { "speaker-2": [1, 0], "speaker-1": [0, 1] });
});

test("collectVoiceSamples: копит образцы только для подтверждённых имён и заменяет прежние при повторе", async () => {
  const storage = makeStorage({
    "meetings/m1/transcript.voice.json": {
      model: "m",
      bySpeakerId: { "speaker-1": [1, 0], "speaker-2": [0, 1] }
    }
  });
  const service = makeService({ storage, meeting });

  await service.collectVoiceSamples(meeting, [
    { id: "speaker-1", guessedName: "Артем", proposedName: "Артем" },
    { id: "speaker-2", guessedName: null, proposedName: null }
  ]);
  let store = storage.data.get("projects/p1/_voice-samples.json");
  assert.equal(store.samples.length, 1);
  assert.deepEqual(
    [store.samples[0].name, store.samples[0].speakerId, store.samples[0].embedding],
    ["Артем", "speaker-1", [1, 0]]
  );

  await service.collectVoiceSamples(meeting, [
    { id: "speaker-1", guessedName: "Артем", proposedName: "Артем" },
    { id: "speaker-2", guessedName: "Влад", proposedName: null }
  ]);
  store = storage.data.get("projects/p1/_voice-samples.json");
  assert.deepEqual(store.samples.map((s) => s.name).sort(), ["Артем", "Влад"]);
});

test("collectVoiceSamples: без эмбеддингов встречи ничего не пишет", async () => {
  const storage = makeStorage();
  const service = makeService({ storage, meeting });
  await service.collectVoiceSamples(meeting, [{ id: "speaker-1", guessedName: "Артем" }]);
  assert.equal(storage.data.size, 0);
});
