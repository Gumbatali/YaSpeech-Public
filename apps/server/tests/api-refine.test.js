import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { createTestServer } from "../src/test-server.js";

async function withServer(options, run) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "yaspeech-refine-"));
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

/** Создаёт проект + встречу, доводит до draft_ready. Refine НЕ запускается —
 * это опциональный переключатель, а не автоматика. Возвращает meetingId. */
async function prepareDraftMeeting(server) {
  const project = await requestJson(server, "/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Refine Test", members: [] })
  });

  const created = await requestJson(server, "/api/meetings", {
    method: "POST",
    body: JSON.stringify({
      projectId: project.body.project.id,
      date: "2026-06-10",
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

test("черновик собирается без вызова LLM — refine остаётся выключенным, пока его не включат", async () => {
  await withServer({}, async (server) => {
    const meetingId = await prepareDraftMeeting(server);
    const { body } = await requestJson(server, `/api/meetings/${meetingId}`);

    // Черновик — из ASR, без ручных шагов
    assert.equal(body.meeting.status, "draft_ready");
    assert.match(body.meeting.titleDraft, /Refine Test/);
    assert.ok(body.meeting.speakerDrafts.length > 0);

    // Переключатель ещё не включали — refine не запускался сам
    assert.ok(!body.meeting.llmRefine?.status);
    assert.ok(!body.meeting.llmTranscriptSegments?.length);
  });
});

test("включение переключателя запускает refine и он завершается", async () => {
  await withServer({}, async (server) => {
    const meetingId = await prepareDraftMeeting(server);

    const started = await requestJson(server, `/api/meetings/${meetingId}/transcript/refine`, {
      method: "POST",
      body: JSON.stringify({})
    });
    assert.equal(started.response.status, 202);
    assert.equal(started.body.meeting.llmRefine.status, "queued");

    await server.waitForIdle();

    const { body } = await requestJson(server, `/api/meetings/${meetingId}`);
    assert.equal(body.meeting.llmRefine.status, "done");
    assert.ok(body.meeting.llmRefine.total >= 1);
    assert.equal(body.meeting.llmRefine.done, body.meeting.llmRefine.total);

    const segments = body.meeting.llmTranscriptSegments;
    assert.ok(segments.length > 0);
    const refined = segments.filter((s) => s.refined);
    assert.ok(refined.length > 0, "должны быть исправленные сегменты");
    assert.match(refined[0].text, /\.$/);
  });
});

test("повторный ручной запуск refine при уже done блокируется", async () => {
  await withServer({}, async (server) => {
    const meetingId = await prepareDraftMeeting(server);

    await requestJson(server, `/api/meetings/${meetingId}/transcript/refine`, {
      method: "POST",
      body: JSON.stringify({})
    });
    await server.waitForIdle();

    const again = await requestJson(server, `/api/meetings/${meetingId}/transcript/refine`, {
      method: "POST",
      body: JSON.stringify({})
    });
    assert.equal(again.response.status, 409);
  });
});

test("ручная правка расшифровки ДО первого включения refine не запускает его сама", async () => {
  await withServer({}, async (server) => {
    const meetingId = await prepareDraftMeeting(server);

    // Переключатель ни разу не включали — правка просто сохраняет текст,
    // не заводя refine за пользователя
    const patched = await requestJson(server, `/api/meetings/${meetingId}/transcript`, {
      method: "PATCH",
      body: JSON.stringify({ rawText: "Спикер 1: исправленный вручную текст" })
    });
    assert.ok(!patched.body.meeting.llmRefine?.status);
  });
});

test("ручная правка расшифровки ПОСЛЕ включения refine перезапускает его снова", async () => {
  await withServer({}, async (server) => {
    const meetingId = await prepareDraftMeeting(server);

    await requestJson(server, `/api/meetings/${meetingId}/transcript/refine`, {
      method: "POST",
      body: JSON.stringify({})
    });
    await server.waitForIdle();

    // Переключатель уже был включён — правка сама перезапускает refine
    const patched = await requestJson(server, `/api/meetings/${meetingId}/transcript`, {
      method: "PATCH",
      body: JSON.stringify({ rawText: "Спикер 1: исправленный вручную текст" })
    });
    assert.equal(patched.body.meeting.llmRefine.status, "queued");
    assert.equal(patched.body.meeting.llmTranscriptSegments, null);

    await server.waitForIdle();

    const { body } = await requestJson(server, `/api/meetings/${meetingId}`);
    assert.equal(body.meeting.llmRefine.status, "done");
  });
});

test("протокол собирается сразу по сырому черновику, если refine не включали", async () => {
  await withServer({}, async (server) => {
    const meetingId = await prepareDraftMeeting(server);

    const confirmed = await requestJson(server, `/api/meetings/${meetingId}/confirm-draft`, {
      method: "POST",
      body: JSON.stringify({ titleDraft: "Тест без refine", speakerDrafts: [] })
    });
    assert.equal(confirmed.body.meeting.status, "protocol_generating");
    await server.waitForIdle();

    const { body } = await requestJson(server, `/api/meetings/${meetingId}`);
    assert.equal(body.meeting.status, "done");
    assert.ok(body.meeting.protocol, "протокол собран без refine");
    assert.ok(!body.meeting.llmRefine?.status, "refine так и не запускался");
  });
});

test("цикл черновика: включаем refine → правка учитывается → повторная правка → протокол по финальной версии", async () => {
  await withServer({}, async (server) => {
    const meetingId = await prepareDraftMeeting(server);

    // 1. Включаем переключатель первый раз
    await requestJson(server, `/api/meetings/${meetingId}/transcript/refine`, {
      method: "POST",
      body: JSON.stringify({})
    });
    await server.waitForIdle();

    // 2. Правим расшифровку — refine перезапускается сам (уже был включён)
    const patched = await requestJson(server, `/api/meetings/${meetingId}/transcript`, {
      method: "PATCH",
      body: JSON.stringify({ rawText: "Спикер 1: обсудили монтаж фасада на объекте" })
    });
    assert.equal(patched.body.meeting.llmRefine.status, "queued");
    await server.waitForIdle();

    let { body } = await requestJson(server, `/api/meetings/${meetingId}`);
    assert.equal(body.meeting.llmRefine.status, "done");
    const refinedSeg = body.meeting.llmTranscriptSegments[0];
    assert.match(refinedSeg.text, /монтаж фасада/, "refine должен исходить из правленого текста");

    // 3. Правим ещё раз ПОСЛЕ улучшения — refine снова автоматически перезапускается
    const patchedAgain = await requestJson(server, `/api/meetings/${meetingId}/transcript`, {
      method: "PATCH",
      body: JSON.stringify({ rawText: "Спикер 1: финальная версия от руки" })
    });
    assert.equal(patchedAgain.body.meeting.llmRefine.status, "queued");

    // 4. Подтверждаем черновик, НЕ дожидаясь завершения refine вручную —
    // пайплайн должен сам дождаться refine перед сборкой протокола.
    const confirmed = await requestJson(server, `/api/meetings/${meetingId}/confirm-draft`, {
      method: "POST",
      body: JSON.stringify({ titleDraft: "Тест цикла", speakerDrafts: [] })
    });
    assert.equal(confirmed.body.meeting.status, "protocol_generating");
    await server.waitForIdle();

    ({ body } = await requestJson(server, `/api/meetings/${meetingId}`));
    assert.equal(body.meeting.status, "done");
    assert.ok(body.meeting.protocol, "протокол собран");
    assert.equal(body.meeting.llmRefine.status, "done", "refine должен был успеть завершиться до сборки протокола");
  });
});

test("refine недоступен пока расшифровка не готова", async () => {
  await withServer({}, async (server) => {
    const project = await requestJson(server, "/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Not Ready", members: [] })
    });
    const created = await requestJson(server, "/api/meetings", {
      method: "POST",
      body: JSON.stringify({
        projectId: project.body.project.id,
        participantIds: [],
        guests: [],
        fileName: "x.mp3",
        contentType: "audio/mpeg"
      })
    });

    const res = await requestJson(
      server,
      `/api/meetings/${created.body.meeting.id}/transcript/refine`,
      { method: "POST", body: JSON.stringify({}) }
    );
    assert.equal(res.response.status, 400);
  });
});
