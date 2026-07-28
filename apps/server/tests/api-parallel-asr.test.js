import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { createTestServer } from "../src/test-server.js";

const SAMPLE_RATE = 16000;

/** Собирает валидный WAV (16kHz mono 16-bit PCM) заданной длительности. */
function makeWav(durationSeconds) {
  const totalSamples = Math.round(durationSeconds * SAMPLE_RATE);
  const pcm = Buffer.alloc(totalSamples * 2);
  for (let i = 0; i < totalSamples; i++) pcm.writeInt16LE(i % 32768, i * 2);

  const header = Buffer.allocUnsafe(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function withServer(options, run) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "yaspeech-parallel-asr-"));
  const server = await createTestServer({ dataDir, ...options });
  try {
    await server.start();
    await run(server, dataDir);
  } finally {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function requestJson(server, pathname, init) {
  const response = await fetch(`${server.baseUrl}${pathname}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) }
  });
  return { response, body: await response.json() };
}

async function waitForDraft(server, meetingId, attempts = 100) {
  for (let i = 0; i < attempts; i++) {
    const { body } = await requestJson(server, `/api/meetings/${meetingId}`);
    if (["draft_ready", "done", "failed"].includes(body.meeting.status)) {
      return body.meeting;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("pipeline did not settle in time");
}

test("большая запись режется на параллельные ASR-чанки и сливается в один черновик", async () => {
  // Порог занижен искусственно (плоскогорье в 5 секунд/160 КБ вместо 30 минут
  // реального продакшена) — гонять реальные десятки МБ в тесте непрактично,
  // логика разрезания/слияния идентична, порог лишь конфигурация.
  await withServer(
    { parallelSplitThresholdBytes: 1000, chunkTargetSeconds: 1 },
    async (server) => {
      const project = await requestJson(server, "/api/projects", {
        method: "POST",
        body: JSON.stringify({ name: "Большая запись", members: [] })
      });

      const created = await requestJson(server, "/api/meetings", {
        method: "POST",
        body: JSON.stringify({
          projectId: project.body.project.id,
          date: "2026-07-14",
          participantIds: [],
          guests: [],
          fileName: "big.wav",
          contentType: "audio/wav"
        })
      });

      const wav = makeWav(5); // 5 сек / 1-сек чанки / порог 1000 байт → 5 чанков
      await fetch(`${server.baseUrl}${created.body.upload.uploadUrl}`, {
        method: "PUT",
        headers: { "content-type": "audio/wav" },
        body: wav
      });

      await requestJson(server, `/api/meetings/${created.body.meeting.id}/upload-complete`, {
        method: "POST",
        body: JSON.stringify({ sizeBytes: wav.length, durationSeconds: 5 })
      });

      const settled = await waitForDraft(server, created.body.meeting.id);

      assert.equal(settled.status, "draft_ready", settled.error?.message);
      assert.ok(settled.transcriptSegments.length > 0, "должны быть сегменты после слияния чанков");

      // Спикеры пронумерованы сквозным счётчиком по чанкам (не переиспользуются
      // между чанками) — при нескольких чанках их будет больше, чем спикеров
      // в одном отдельном моке (см. asr-merge.js)
      const speakerIds = new Set(settled.transcriptSegments.map((s) => s.speakerId));
      assert.ok(speakerIds.size >= 2, "минимум 2 спикера от слияния нескольких чанков");
    }
  );
});

test("запись меньше порога — один ASR-запрос, не режется", async () => {
  await withServer(
    { parallelSplitThresholdBytes: 10 * 1024 * 1024 }, // 10 MB — 5-сек WAV точно меньше
    async (server) => {
      const project = await requestJson(server, "/api/projects", {
        method: "POST",
        body: JSON.stringify({ name: "Короткая запись", members: [] })
      });

      const created = await requestJson(server, "/api/meetings", {
        method: "POST",
        body: JSON.stringify({
          projectId: project.body.project.id,
          date: "2026-07-14",
          participantIds: [],
          guests: [],
          fileName: "small.wav",
          contentType: "audio/wav"
        })
      });

      const wav = makeWav(5);
      await fetch(`${server.baseUrl}${created.body.upload.uploadUrl}`, {
        method: "PUT",
        headers: { "content-type": "audio/wav" },
        body: wav
      });

      await requestJson(server, `/api/meetings/${created.body.meeting.id}/upload-complete`, {
        method: "POST",
        body: JSON.stringify({ sizeBytes: wav.length, durationSeconds: 5 })
      });

      const settled = await waitForDraft(server, created.body.meeting.id);
      assert.equal(settled.status, "draft_ready", settled.error?.message);
    }
  );
});
