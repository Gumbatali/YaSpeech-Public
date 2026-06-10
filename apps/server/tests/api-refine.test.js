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

/** Создаёт проект + встречу, доводит до draft_ready. Возвращает meetingId. */
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

test("draft готовится БЕЗ LLM: спикеры из ASR, заголовок из проекта и даты", async () => {
  await withServer({}, async (server) => {
    const meetingId = await prepareDraftMeeting(server);
    const { body } = await requestJson(server, `/api/meetings/${meetingId}`);

    assert.equal(body.meeting.status, "draft_ready");
    // Заголовок без LLM — проект + дата
    assert.match(body.meeting.titleDraft, /Refine Test/);
    // Спикеры — сырые метки, без LLM-имён
    assert.ok(body.meeting.speakerDrafts.length > 0);
    // gptContext не создаётся в авто-фазе
    assert.equal(body.meeting.gptContext, undefined);
    // llmRefine ещё не запускался
    assert.equal(body.meeting.llmRefine, undefined);
  });
});

test("refine-флоу: кнопка → джоба → llmTranscriptSegments + повторный запуск блокируется", async () => {
  await withServer({}, async (server) => {
    const meetingId = await prepareDraftMeeting(server);

    // Запуск улучшения
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

    // Сегменты улучшенной версии: mock капитализирует и ставит точку
    const segments = body.meeting.llmTranscriptSegments;
    assert.ok(segments.length > 0);
    const refined = segments.filter((s) => s.refined);
    assert.ok(refined.length > 0, "должны быть исправленные сегменты");
    assert.ok(refined[0].originalText, "у исправленного сегмента есть оригинал");
    assert.match(refined[0].text, /\.$/);

    // Имена спикеров подтянулись из identifySpeakers
    const named = body.meeting.speakerDrafts.filter((s) => s.guessedName);
    assert.ok(named.length > 0);

    // Повторный запуск при done → 409
    const again = await requestJson(server, `/api/meetings/${meetingId}/transcript/refine`, {
      method: "POST",
      body: JSON.stringify({})
    });
    assert.equal(again.response.status, 409);
  });
});

test("ручная правка расшифровки инвалидирует refine и снова открывает кнопку", async () => {
  await withServer({}, async (server) => {
    const meetingId = await prepareDraftMeeting(server);

    await requestJson(server, `/api/meetings/${meetingId}/transcript/refine`, {
      method: "POST",
      body: JSON.stringify({})
    });
    await server.waitForIdle();

    // Правим текст руками
    const patched = await requestJson(server, `/api/meetings/${meetingId}/transcript`, {
      method: "PATCH",
      body: JSON.stringify({ rawText: "Спикер 1: исправленный вручную текст" })
    });
    assert.equal(patched.body.meeting.llmRefine.status, "stale");
    assert.equal(patched.body.meeting.llmTranscriptSegments, null);

    // stale → можно запустить заново
    const reRefine = await requestJson(server, `/api/meetings/${meetingId}/transcript/refine`, {
      method: "POST",
      body: JSON.stringify({})
    });
    assert.equal(reRefine.response.status, 202);

    // Дожидаемся фоновой джобы — иначе cleanup гоняется с записью артефактов
    await server.waitForIdle();
  });
});

test("цикл черновика: правка → refine учитывает правку → повторная правка → протокол по ней", async () => {
  await withServer({}, async (server) => {
    const meetingId = await prepareDraftMeeting(server);

    // 1. Правим расшифровку прямо в черновике
    await requestJson(server, `/api/meetings/${meetingId}/transcript`, {
      method: "PATCH",
      body: JSON.stringify({ rawText: "Спикер 1: обсудили монтаж фасада на объекте" })
    });

    // 2. Улучшение работает по ОТРЕДАКТИРОВАННОМУ тексту
    await requestJson(server, `/api/meetings/${meetingId}/transcript/refine`, {
      method: "POST",
      body: JSON.stringify({})
    });
    await server.waitForIdle();

    let { body } = await requestJson(server, `/api/meetings/${meetingId}`);
    assert.equal(body.meeting.llmRefine.status, "done");
    const refinedSeg = body.meeting.llmTranscriptSegments[0];
    assert.match(refinedSeg.text, /монтаж фасада/, "refine должен исходить из правленого текста");

    // 3. Правим ещё раз ПОСЛЕ улучшения — refine инвалидирован
    await requestJson(server, `/api/meetings/${meetingId}/transcript`, {
      method: "PATCH",
      body: JSON.stringify({ rawText: "Спикер 1: финальная версия от руки" })
    });
    ({ body } = await requestJson(server, `/api/meetings/${meetingId}`));
    assert.equal(body.meeting.llmRefine.status, "stale");

    // 4. Сборка протокола идёт по последней (ручной) версии
    const confirmed = await requestJson(server, `/api/meetings/${meetingId}/confirm-draft`, {
      method: "POST",
      body: JSON.stringify({ titleDraft: "Тест цикла", speakerDrafts: [] })
    });
    assert.equal(confirmed.body.meeting.status, "protocol_generating");
    await server.waitForIdle();

    ({ body } = await requestJson(server, `/api/meetings/${meetingId}`));
    assert.equal(body.meeting.status, "done");
    assert.ok(body.meeting.protocol, "протокол собран");
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
