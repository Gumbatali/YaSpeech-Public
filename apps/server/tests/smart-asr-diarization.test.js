import { test } from "node:test";
import assert from "node:assert/strict";

import { SmartAsrGateway } from "../src/infrastructure/smart-asr-gateway.js";

/**
 * Транскрайбер-заглушка: отдаёт фразы без разметки спикеров — ровно так,
 * как это делает SpeechKit, у которого speakerTag в ответе не приходит.
 */
function makeTranscriber(phrases) {
  return {
    async processMeeting() {
      return {
        jobId: "job-1",
        transcript: {
          rawText: "",
          phrases: phrases.map((p) => ({ ...p })),
        },
      };
    },
  };
}

function makeDiarizer(segments, { available = true } = {}) {
  return {
    backend: "test-diarizer",
    available,
    calls: 0,
    async diarize() {
      this.calls++;
      return segments;
    },
  };
}

const meeting = { artifacts: { audioOriginalKey: "audio/meeting.wav" } };

const SPEECHKIT_PHRASES = [
  { speakerId: "speaker-1", speakerLabel: "Спикер 1", startTimeMs: 0, endTimeMs: 5000, text: "первая реплика" },
  { speakerId: "speaker-1", speakerLabel: "Спикер 1", startTimeMs: 6000, endTimeMs: 10000, text: "вторая реплика" },
];

test("diarizer is applied even when transcription came from SpeechKit", async () => {
  // Главная регрессия, которую стережёт этот тест: раньше диаризация
  // запускалась только для Whisper, потому что считалось, что SpeechKit
  // вернёт speakerTag сам. Замер показал, что не возвращает.
  const diarizer = makeDiarizer([
    { speaker: "SPEAKER_00", start: 0, stop: 5 },
    { speaker: "SPEAKER_01", start: 6, stop: 10 },
  ]);

  const gateway = new SmartAsrGateway({
    speechKitBucket: "bucket",
    artifactStorage: {},
    diarizer,
    env: {},
  });
  gateway.transcriber = makeTranscriber(SPEECHKIT_PHRASES);

  const { transcript } = await gateway.processMeeting({ meeting, project: {} });

  assert.equal(diarizer.calls, 1, "диаризатор должен быть вызван");
  assert.equal(
    new Set(transcript.phrases.map((p) => p.speakerId)).size,
    2,
    "две реплики должны получить разных спикеров"
  );
});

test("phrases keep their text after diarization", async () => {
  const diarizer = makeDiarizer([
    { speaker: "SPEAKER_00", start: 0, stop: 5 },
    { speaker: "SPEAKER_01", start: 6, stop: 10 },
  ]);

  const gateway = new SmartAsrGateway({
    speechKitBucket: "bucket",
    artifactStorage: {},
    diarizer,
    env: {},
  });
  gateway.transcriber = makeTranscriber(SPEECHKIT_PHRASES);

  const { transcript } = await gateway.processMeeting({ meeting, project: {} });

  assert.deepEqual(
    transcript.phrases.map((p) => p.text),
    ["первая реплика", "вторая реплика"]
  );
});

test("rawText is rebuilt with the new speaker labels", async () => {
  const diarizer = makeDiarizer([
    { speaker: "SPEAKER_00", start: 0, stop: 5 },
    { speaker: "SPEAKER_01", start: 6, stop: 10 },
  ]);

  const gateway = new SmartAsrGateway({
    speechKitBucket: "bucket",
    artifactStorage: {},
    diarizer,
    env: {},
  });
  gateway.transcriber = makeTranscriber(SPEECHKIT_PHRASES);

  const { transcript } = await gateway.processMeeting({ meeting, project: {} });

  assert.match(transcript.rawText, /Спикер 1: первая реплика/);
  assert.match(transcript.rawText, /Спикер 2: вторая реплика/);
});

test("transcription passes through untouched when no diarizer is configured", async () => {
  const diarizer = makeDiarizer([], { available: false });

  const gateway = new SmartAsrGateway({
    speechKitBucket: "bucket",
    artifactStorage: {},
    diarizer,
    env: {},
  });
  gateway.transcriber = makeTranscriber(SPEECHKIT_PHRASES);

  const { transcript } = await gateway.processMeeting({ meeting, project: {} });

  assert.equal(diarizer.calls, 0, "выключенный диаризатор не должен вызываться");
  assert.equal(transcript.phrases.length, 2);
});

test("empty transcription does not call the diarizer", async () => {
  // Диаризовать нечего — незачем и тратить минуты на инференс.
  const diarizer = makeDiarizer([{ speaker: "SPEAKER_00", start: 0, stop: 5 }]);

  const gateway = new SmartAsrGateway({
    speechKitBucket: "bucket",
    artifactStorage: {},
    diarizer,
    env: {},
  });
  gateway.transcriber = makeTranscriber([]);

  const { transcript } = await gateway.processMeeting({ meeting, project: {} });

  assert.equal(diarizer.calls, 0);
  assert.equal(transcript.phrases.length, 0);
});

test("failed diarization leaves the transcript usable", async () => {
  // Протокол без разделения по спикерам полезнее, чем упавшая обработка.
  const diarizer = {
    backend: "broken",
    available: true,
    async diarize() {
      return null;
    },
  };

  const gateway = new SmartAsrGateway({
    speechKitBucket: "bucket",
    artifactStorage: {},
    diarizer,
    env: {},
  });
  gateway.transcriber = makeTranscriber(SPEECHKIT_PHRASES);

  const { transcript } = await gateway.processMeeting({ meeting, project: {} });

  assert.equal(transcript.phrases.length, 2, "фразы должны сохраниться");
  assert.ok(transcript.phrases.every((p) => p.text));
});
