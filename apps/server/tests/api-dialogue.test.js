import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { createTestServer } from "../src/test-server.js";

async function withServer(options, run) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "yaspeech-dialogue-"));
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
  const body = await response.json();
  return { response, body };
}

/** Создаёт проект + встречу, доводит до draft_ready. Возвращает meetingId. */
async function prepareDraftMeeting(server) {
  const project = await requestJson(server, "/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Dialogue Test", members: [] })
  });

  const created = await requestJson(server, "/api/meetings", {
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

  await fetch(`${server.baseUrl}${created.body.upload.uploadUrl}`, {
    method: "PUT",
    headers: { "content-type": "audio/mp4" },
    body: Buffer.from("fake-audio")
  });

  await requestJson(server, `/api/meetings/${created.body.meeting.id}/upload-complete`, {
    method: "POST",
    body: JSON.stringify({ sizeBytes: 10 })
  });

  await server.waitForIdle();
  return created.body.meeting.id;
}

test("диалог недоступен, пока refine не завершён", async () => {
  await withServer({}, async (server) => {
    const meetingId = await prepareDraftMeeting(server);

    const res = await requestJson(server, `/api/meetings/${meetingId}/transcript/dialogue`, {
      method: "POST",
      body: JSON.stringify({})
    });
    assert.equal(res.response.status, 400);
    assert.match(res.body.error.message, /Улучшить с помощью ИИ/);
  });
});

test("dialogue-флоу: refine → диалог → llmDialogueSegments + повторный запуск блокируется", async () => {
  await withServer({}, async (server) => {
    const meetingId = await prepareDraftMeeting(server);

    await requestJson(server, `/api/meetings/${meetingId}/transcript/refine`, {
      method: "POST",
      body: JSON.stringify({})
    });
    await server.waitForIdle();

    const started = await requestJson(server, `/api/meetings/${meetingId}/transcript/dialogue`, {
      method: "POST",
      body: JSON.stringify({})
    });
    assert.equal(started.response.status, 202);
    assert.equal(started.body.meeting.llmDialogue.status, "queued");

    await server.waitForIdle();

    const { body } = await requestJson(server, `/api/meetings/${meetingId}`);
    assert.equal(body.meeting.llmDialogue.status, "done");
    assert.ok(body.meeting.llmDialogue.total >= 1);
    assert.equal(body.meeting.llmDialogue.done, body.meeting.llmDialogue.total);

    const segments = body.meeting.llmDialogueSegments;
    assert.ok(segments.length > 0);
    // mock-gateway убирает филлеры — по крайней мере одна реплика должна отличаться
    assert.ok(segments.some((s) => s.refined), "должны быть переписанные реплики");

    // Повторный запуск при done → 409
    const again = await requestJson(server, `/api/meetings/${meetingId}/transcript/dialogue`, {
      method: "POST",
      body: JSON.stringify({})
    });
    assert.equal(again.response.status, 409);
  });
});

test("повторный refine делает готовый диалог устаревшим (stale)", async () => {
  await withServer({}, async (server) => {
    const meetingId = await prepareDraftMeeting(server);

    await requestJson(server, `/api/meetings/${meetingId}/transcript/refine`, {
      method: "POST",
      body: JSON.stringify({})
    });
    await server.waitForIdle();

    await requestJson(server, `/api/meetings/${meetingId}/transcript/dialogue`, {
      method: "POST",
      body: JSON.stringify({})
    });
    await server.waitForIdle();

    let { body } = await requestJson(server, `/api/meetings/${meetingId}`);
    assert.equal(body.meeting.llmDialogue.status, "done");

    // Правим текст руками — инвалидирует и refine, и диалог
    const patched = await requestJson(server, `/api/meetings/${meetingId}/transcript`, {
      method: "PATCH",
      body: JSON.stringify({ rawText: "Спикер 1: исправленный вручную текст" })
    });
    assert.equal(patched.body.meeting.llmRefine.status, "stale");
    assert.equal(patched.body.meeting.llmDialogue.status, "stale");
    assert.equal(patched.body.meeting.llmDialogueSegments, null);

    // Диалог по-прежнему заблокирован, пока refine не перезапущен и не завершён
    const blocked = await requestJson(server, `/api/meetings/${meetingId}/transcript/dialogue`, {
      method: "POST",
      body: JSON.stringify({})
    });
    assert.equal(blocked.response.status, 400);

    await requestJson(server, `/api/meetings/${meetingId}/transcript/refine`, {
      method: "POST",
      body: JSON.stringify({})
    });
    await server.waitForIdle();

    ({ body } = await requestJson(server, `/api/meetings/${meetingId}`));
    assert.equal(body.meeting.llmRefine.status, "done");
    // Новый refine пометил старый диалог устаревшим — тоже проверяем явно
    assert.equal(body.meeting.llmDialogue.status, "stale");
  });
});
