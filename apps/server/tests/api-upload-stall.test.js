import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createTestServer } from "../src/test-server.js";

class FakeClock {
  constructor(startIso = "2026-07-14T10:00:00.000Z") {
    this.current = new Date(startIso);
  }

  now() {
    return new Date(this.current);
  }

  advanceMinutes(minutes) {
    this.current = new Date(this.current.getTime() + minutes * 60 * 1000);
  }
}

async function withServer(run) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "yaspeech-stall-"));
  const clock = new FakeClock();
  const server = await createTestServer({ dataDir, clock });

  try {
    await server.start();
    await run(server, clock, dataDir);
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

// После upload-complete мок-пайплайн работает асинхронно — дожидаемся его
// финального статуса, иначе cleanup tmp-каталога гонится с записью артефактов.
async function waitForPipelineSettled(server, meetingId, attempts = 50) {
  for (let i = 0; i < attempts; i++) {
    const { body } = await requestJson(server, `/api/meetings/${meetingId}`);
    if (["draft_ready", "done", "failed"].includes(body.meeting.status)) {
      return body.meeting;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("pipeline did not settle in time");
}

async function createUploadingMeeting(server) {
  const project = await requestJson(server, "/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Стройка", members: [] })
  });
  const meeting = await requestJson(server, "/api/meetings", {
    method: "POST",
    body: JSON.stringify({
      projectId: project.body.project.id,
      date: "2026-07-14",
      participantIds: [],
      guests: [],
      fileName: "meeting.m4a",
      contentType: "audio/mp4"
    })
  });
  assert.equal(meeting.body.meeting.status, "uploading");
  return meeting.body;
}

test("heartbeat обновляет прогресс, без heartbeat встреча падает в UPLOAD_STALLED", async () => {
  await withServer(async (server, clock) => {
    const { meeting } = await createUploadingMeeting(server);

    // Heartbeat принимается и виден в meeting
    const beat = await requestJson(server, `/api/meetings/${meeting.id}/upload-heartbeat`, {
      method: "POST",
      body: JSON.stringify({ progressPct: 37 })
    });
    assert.equal(beat.response.status, 200);
    assert.equal(beat.body.meeting.uploadProgress, 37);

    // Через 5 минут после heartbeat — всё ещё живая загрузка
    clock.advanceMinutes(5);
    const alive = await requestJson(server, `/api/meetings/${meeting.id}`);
    assert.equal(alive.body.meeting.status, "uploading");

    // Ещё через 11 минут тишины — сервер сам помечает загрузку брошенной
    clock.advanceMinutes(11);
    const stalled = await requestJson(server, `/api/meetings/${meeting.id}`);
    assert.equal(stalled.body.meeting.status, "failed");
    assert.equal(stalled.body.meeting.error.code, "UPLOAD_STALLED");
  });
});

test("зависшая загрузка лечится и в списке встреч проекта", async () => {
  await withServer(async (server, clock) => {
    const { meeting } = await createUploadingMeeting(server);

    clock.advanceMinutes(15);
    const list = await requestJson(server, `/api/projects/${meeting.projectId}/meetings`);
    const entry = list.body.meetings.find((m) => m.id === meeting.id);
    assert.equal(entry.status, "failed");
  });
});

test("reupload выдаёт новый upload-URL, после дозаливки пайплайн доходит до черновика", async () => {
  await withServer(async (server, clock) => {
    const { meeting } = await createUploadingMeeting(server);

    // reupload до обрыва — отклоняется только для «здоровых» не-uploading статусов,
    // для uploading разрешён (пере-запрос URL при живой встрече)
    clock.advanceMinutes(15);
    await requestJson(server, `/api/meetings/${meeting.id}`); // heal → failed

    const reissued = await requestJson(server, `/api/meetings/${meeting.id}/reupload`, {
      method: "POST",
      body: JSON.stringify({})
    });
    assert.equal(reissued.response.status, 200);
    assert.equal(reissued.body.meeting.status, "uploading");
    assert.ok(reissued.body.upload.uploadUrl);

    // Дозаливаем файл по новому URL и завершаем
    const uploadResponse = await fetch(`${server.baseUrl}${reissued.body.upload.uploadUrl}`, {
      method: reissued.body.upload.method,
      body: Buffer.from("fake-audio-bytes-".repeat(10))
    });
    assert.equal(uploadResponse.status, 200);

    const completed = await requestJson(server, `/api/meetings/${meeting.id}/upload-complete`, {
      method: "POST",
      body: JSON.stringify({ sizeBytes: 170 })
    });
    assert.equal(completed.response.status, 200);
    assert.equal(completed.body.meeting.status, "uploaded");

    const settled = await waitForPipelineSettled(server, meeting.id);
    assert.equal(settled.status, "draft_ready");
  });
});

test("reupload отклоняется для встреч, у которых загрузка не прерывалась", async () => {
  await withServer(async (server) => {
    const { meeting } = await createUploadingMeeting(server);

    // Завершаем загрузку штатно
    const upload = meeting.upload;
    await fetch(`${server.baseUrl}${upload.uploadUrl}`, {
      method: upload.method,
      body: Buffer.from("fake-audio-bytes-".repeat(10))
    });
    await requestJson(server, `/api/meetings/${meeting.id}/upload-complete`, {
      method: "POST",
      body: JSON.stringify({ sizeBytes: 170 })
    });
    await waitForPipelineSettled(server, meeting.id);

    const rejected = await requestJson(server, `/api/meetings/${meeting.id}/reupload`, {
      method: "POST",
      body: JSON.stringify({})
    });
    assert.equal(rejected.response.status, 400);
  });
});

test("зависшая обработка (умерший worker) лечится в failed/PROCESSING_STALLED", async () => {
  await withServer(async (server, clock, dataDir) => {
    const { meeting } = await createUploadingMeeting(server);

    await fetch(`${server.baseUrl}${meeting.upload.uploadUrl}`, {
      method: meeting.upload.method,
      body: Buffer.from("fake-audio-bytes-".repeat(10))
    });
    await requestJson(server, `/api/meetings/${meeting.id}/upload-complete`, {
      method: "POST",
      body: JSON.stringify({ sizeBytes: 170 })
    });
    await waitForPipelineSettled(server, meeting.id);

    // Имитируем смерть worker посреди генерации протокола: откатываем статус
    // напрямую в хранилище (обновлений от worker больше не будет)
    const manifestPath = path.join(
      dataDir, "projects", meeting.projectId, "meetings", meeting.id, "meeting.json"
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    await writeFile(manifestPath, JSON.stringify({
      ...manifest,
      status: "protocol_generating",
      currentStage: "protocol_generating"
    }));

    // 29 минут — ещё «работает», 31 минута — уже зависание
    clock.advanceMinutes(29);
    const alive = await requestJson(server, `/api/meetings/${meeting.id}`);
    assert.equal(alive.body.meeting.status, "protocol_generating");

    clock.advanceMinutes(2);
    const stalled = await requestJson(server, `/api/meetings/${meeting.id}`);
    assert.equal(stalled.body.meeting.status, "failed");
    assert.equal(stalled.body.meeting.error.code, "PROCESSING_STALLED");
    // retry сможет продолжить с этапа протокола, не перегоняя ASR
    assert.equal(stalled.body.meeting.currentStage, "protocol_generating");
  });
});
