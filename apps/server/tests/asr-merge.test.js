import test from "node:test";
import assert from "node:assert/strict";
import { mergeChunkTranscripts } from "../src/application/asr-merge.js";

function phrase(speakerId, text, startTimeMs, endTimeMs) {
  return { speakerId, speakerLabel: `raw-${speakerId}`, detectedName: null, text, startTimeMs, endTimeMs };
}

test("mergeChunkTranscripts: один чанк — просто переносится (offset 0)", () => {
  const result = mergeChunkTranscripts([
    {
      offsetSeconds: 0,
      transcript: {
        jobId: "job-1", meetingId: "m1",
        phrases: [phrase("speaker-1", "привет", 0, 1000), phrase("speaker-2", "привет-привет", 1000, 2000)]
      }
    }
  ]);

  assert.equal(result.phrases.length, 2);
  assert.equal(result.phrases[0].speakerId, "speaker-1");
  assert.equal(result.phrases[1].speakerId, "speaker-2");
  assert.equal(result.phrases[0].startTimeMs, 0);
  assert.equal(result.mergedFromChunks, 1);
});

test("mergeChunkTranscripts: временные метки сдвигаются на offset чанка", () => {
  const result = mergeChunkTranscripts([
    { offsetSeconds: 0, transcript: { phrases: [phrase("speaker-1", "первый чанк", 0, 5000)] } },
    { offsetSeconds: 600, transcript: { phrases: [phrase("speaker-1", "второй чанк", 0, 3000)] } } // offset 10 минут
  ]);

  assert.equal(result.phrases[0].startTimeMs, 0);
  assert.equal(result.phrases[0].endTimeMs, 5000);
  assert.equal(result.phrases[1].startTimeMs, 600_000);
  assert.equal(result.phrases[1].endTimeMs, 603_000);
});

test("mergeChunkTranscripts: нумерация спикеров сквозная по границам чанков, не переиспользуется", () => {
  const result = mergeChunkTranscripts([
    {
      offsetSeconds: 0,
      transcript: {
        phrases: [phrase("speaker-1", "a", 0, 1000), phrase("speaker-2", "b", 1000, 2000)]
      }
    },
    {
      offsetSeconds: 100,
      transcript: {
        // Локально снова "speaker-1"/"speaker-2" — но это НЕ обязательно те же люди,
        // поэтому глобальные ID должны продолжить счёт, а не начаться заново
        phrases: [phrase("speaker-1", "c", 0, 1000), phrase("speaker-2", "d", 1000, 2000)]
      }
    }
  ]);

  const ids = result.phrases.map((p) => p.speakerId);
  assert.deepEqual(ids, ["speaker-1", "speaker-2", "speaker-3", "speaker-4"]);
});

test("mergeChunkTranscripts: чанки сортируются по offsetSeconds независимо от порядка входа (параллельные ответы могут прийти не по порядку)", () => {
  const result = mergeChunkTranscripts([
    { offsetSeconds: 200, transcript: { phrases: [phrase("speaker-1", "поздний по времени", 0, 1000)] } },
    { offsetSeconds: 0, transcript: { phrases: [phrase("speaker-1", "ранний по времени", 0, 1000)] } }
  ]);

  assert.equal(result.phrases[0].text, "ранний по времени");
  assert.equal(result.phrases[1].text, "поздний по времени");
});

test("mergeChunkTranscripts: один и тот же локальный speakerId внутри чанка мапится на один и тот же глобальный ID", () => {
  const result = mergeChunkTranscripts([
    {
      offsetSeconds: 0,
      transcript: {
        phrases: [
          phrase("speaker-1", "первая реплика", 0, 1000),
          phrase("speaker-2", "вторая реплика", 1000, 2000),
          phrase("speaker-1", "снова первый спикер", 2000, 3000)
        ]
      }
    }
  ]);

  assert.equal(result.phrases[0].speakerId, "speaker-1");
  assert.equal(result.phrases[2].speakerId, "speaker-1"); // тот же человек внутри чанка — тот же ID
  assert.equal(result.phrases[1].speakerId, "speaker-2");
});

test("mergeChunkTranscripts: пустой чанк не ломает слияние", () => {
  const result = mergeChunkTranscripts([
    { offsetSeconds: 0, transcript: { phrases: [phrase("speaker-1", "текст", 0, 1000)] } },
    { offsetSeconds: 100, transcript: { phrases: [] } }
  ]);
  assert.equal(result.phrases.length, 1);
});

test("mergeChunkTranscripts: rawText собирается в формате «Спикер N: текст»", () => {
  const result = mergeChunkTranscripts([
    { offsetSeconds: 0, transcript: { phrases: [phrase("speaker-1", "привет всем", 0, 1000)] } }
  ]);
  assert.equal(result.rawText, "Спикер 1: привет всем");
});
