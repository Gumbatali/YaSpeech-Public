/**
 * Тесты валидации входа на границе API.
 * Раньше мусорный вход давал 500 (TypeError внутри use-case), теперь — чистый 400.
 */
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { createTestServer } from "../src/test-server.js";

async function withServer(run) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "yaspeech-val-"));
  const server = await createTestServer({ dataDir });
  try {
    await server.start();
    await run(server);
  } finally {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function post(server, pathname, body) {
  const response = await fetch(`${server.baseUrl}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
  let json = null;
  try { json = await response.json(); } catch {}
  return { response, body: json };
}

test("POST /api/projects: пустое/отсутствующее/не-строковое имя → 400, не 500", async () => {
  await withServer(async (server) => {
    for (const payload of [{}, { name: "" }, { name: "   " }, { name: 42 }, { name: "x".repeat(201) }]) {
      const { response } = await post(server, "/api/projects", payload);
      assert.equal(response.status, 400, `payload ${JSON.stringify(payload)} должен дать 400`);
    }

    const ok = await post(server, "/api/projects", { name: "Нормальный проект" });
    assert.equal(ok.response.status, 201);
  });
});

test("POST /api/meetings: мусорная дата и не-массивы → 400", async () => {
  await withServer(async (server) => {
    await post(server, "/api/projects", { name: "Проект" });

    const base = {
      projectId: "proekt",
      fileName: "rec.mp3",
      contentType: "audio/mpeg"
    };

    const badDate = await post(server, "/api/meetings", { ...base, date: "10.05.2026" });
    assert.equal(badDate.response.status, 400, "дата не в ISO-формате");

    const badParticipants = await post(server, "/api/meetings", {
      ...base, date: "2026-05-10", participantIds: "not-an-array"
    });
    assert.equal(badParticipants.response.status, 400);

    // Пустая дата допустима (домен подставит фолбэк) — поведение сохранено
    const emptyDate = await post(server, "/api/meetings", { ...base, date: "" });
    assert.equal(emptyDate.response.status, 201);

    const ok = await post(server, "/api/meetings", { ...base, date: "2026-05-10" });
    assert.equal(ok.response.status, 201);
  });
});

test("малформленный JSON в теле → 400 с понятным сообщением, не 500", async () => {
  await withServer(async (server) => {
    const { response, body } = await post(server, "/api/projects", "{broken json!!");
    assert.equal(response.status, 400);
    assert.match(body.error.message, /JSON/);
  });
});

test("PUT team: members обязан быть массивом", async () => {
  await withServer(async (server) => {
    const created = await post(server, "/api/projects", { name: "Команда" });
    const projectId = created.body.project.id;

    const bad = await fetch(`${server.baseUrl}/api/projects/${projectId}/team`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ members: { not: "array" } })
    });
    assert.equal(bad.status, 400);
  });
});
