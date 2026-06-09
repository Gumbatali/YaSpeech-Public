/**
 * Unit tests for YcMeetingRepository.
 *
 * Covers three index layouts:
 *   1. Legacy: нет глобального meetings/index.json — только project-level
 *   2. Переходный: запись в глобальном индексе есть, но без baseKey
 *   3. Новый: запись в глобальном индексе с baseKey
 *
 * Используем InMemoryStorage вместо реального S3 чтобы тесты работали без сети.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { YcMeetingRepository } from "../src/infrastructure/yc-meeting-repository.js";

// ── In-memory storage (имитирует YcArtifactStorage read/write) ─────────────

class InMemoryStorage {
  constructor(initial = {}) {
    this._data = { ...initial };
  }

  async readJson(key) {
    return this._data[key] ?? null;
  }

  async writeJson(key, value) {
    this._data[key] = value;
  }

  async writeText(key, value) {
    this._data[key] = value;
  }

  /** Snapshot — для проверки что записалось */
  get(key) {
    return this._data[key] ?? null;
  }
}

// ── Фабрики тестовых данных ──────────────────────────────────────────────────

/** Встреча в СТАРОМ формате: нет поля artifacts.baseKey */
function legacyMeeting(projectId, meetingId, status = "done") {
  return {
    id: meetingId,
    projectId,
    projectName: "Тест проект",
    date: "2025-01-15",
    status,
    currentStage: status,
    updatedAt: "2025-01-15T10:00:00.000Z",
    artifacts: {
      audioOriginalKey: `projects/${projectId}/meetings/${meetingId}/audio-original.mp3`,
      transcriptKey:    `projects/${projectId}/meetings/${meetingId}/transcript.json`,
      protocolJsonKey:  `projects/${projectId}/meetings/${meetingId}/protocol.json`,
      protocolTextKey:  `projects/${projectId}/meetings/${meetingId}/protocol.txt`,
      manifestKey:      `projects/${projectId}/meetings/${meetingId}/meeting.json`,
      // baseKey отсутствует — это и есть legacy-формат
    }
  };
}

/** Встреча в НОВОМ формате: есть artifacts.baseKey */
function newMeeting(projectId, meetingId, date = "2026-05-10") {
  const baseKey = `projects/${projectId}/${date}_${meetingId}`;
  return {
    id: meetingId,
    projectId,
    projectName: "Тест проект",
    date,
    status: "done",
    currentStage: "done",
    updatedAt: `${date}T10:00:00.000Z`,
    artifacts: {
      audioOriginalKey: `${baseKey}/audio.mp3`,
      transcriptKey:    `${baseKey}/transcript.json`,
      protocolJsonKey:  `${baseKey}/protocol.json`,
      protocolTextKey:  `${baseKey}/protocol.txt`,
      manifestKey:      `${baseKey}/meeting.json`,
      baseKey,
    }
  };
}

// ── Тесты: getById ───────────────────────────────────────────────────────────

test("getById: находит СТАРУЮ встречу (нет глобального индекса) через project-level fallback", async () => {
  const projectId = "alpha";
  const meetingId = "old-111";
  const meeting = legacyMeeting(projectId, meetingId);

  const storage = new InMemoryStorage({
    // meetings/index.json ОТСУТСТВУЕТ
    "projects/index.json": [{ id: projectId, name: "Alpha" }],
    [`projects/${projectId}/meetings/index.json`]: [
      { id: meetingId, projectId, date: "2025-01-15", status: "done" }
    ],
    [`projects/${projectId}/meetings/${meetingId}/meeting.json`]: meeting,
  });

  const repo = new YcMeetingRepository(storage);
  const found = await repo.getById(meetingId);

  assert.ok(found, "встреча должна найтись через проектный индекс");
  assert.equal(found.id, meetingId);
  assert.equal(found.status, "done");
});

test("getById: находит НОВУЮ встречу через глобальный индекс (с baseKey)", async () => {
  const projectId = "beta";
  const meetingId = "new-222";
  const date = "2026-05-10";
  const meeting = newMeeting(projectId, meetingId, date);
  const baseKey = `projects/${projectId}/${date}_${meetingId}`;

  const storage = new InMemoryStorage({
    "meetings/index.json": [{ id: meetingId, projectId, baseKey }],
    [`${baseKey}/meeting.json`]: meeting,
  });

  const repo = new YcMeetingRepository(storage);
  const found = await repo.getById(meetingId);

  assert.ok(found, "встреча должна найтись через глобальный индекс");
  assert.equal(found.id, meetingId);
  assert.equal(found.artifacts.baseKey, baseKey);
});

test("getById: находит встречу в глобальном индексе БЕЗ baseKey (переходный формат)", async () => {
  const projectId = "gamma";
  const meetingId = "trans-333";
  const meeting = legacyMeeting(projectId, meetingId);

  const storage = new InMemoryStorage({
    // Глобальный индекс есть, но запись без baseKey
    "meetings/index.json": [{ id: meetingId, projectId /* нет baseKey */ }],
    [`projects/${projectId}/meetings/${meetingId}/meeting.json`]: meeting,
  });

  const repo = new YcMeetingRepository(storage);
  const found = await repo.getById(meetingId);

  assert.ok(found, "встреча должна найтись через глобальный индекс без baseKey");
  assert.equal(found.id, meetingId);
});

test("getById: возвращает null если встречи нет нигде", async () => {
  const storage = new InMemoryStorage({
    "projects/index.json": [{ id: "empty-project", name: "Пустой" }],
    "projects/empty-project/meetings/index.json": [],
  });

  const repo = new YcMeetingRepository(storage);
  const found = await repo.getById("non-existent-uuid");

  assert.equal(found, null);
});

test("getById: возвращает null если нет ни одного индекса", async () => {
  const storage = new InMemoryStorage({});

  const repo = new YcMeetingRepository(storage);
  const found = await repo.getById("whatever");

  assert.equal(found, null);
});

test("getById: работает когда несколько проектов и встреча в последнем", async () => {
  const storage = new InMemoryStorage({
    "projects/index.json": [
      { id: "proj-a", name: "A" },
      { id: "proj-b", name: "B" },
      { id: "proj-c", name: "C" },
    ],
    "projects/proj-a/meetings/index.json": [{ id: "m-a", projectId: "proj-a" }],
    "projects/proj-b/meetings/index.json": [{ id: "m-b", projectId: "proj-b" }],
    "projects/proj-c/meetings/index.json": [{ id: "m-c", projectId: "proj-c" }],
    "projects/proj-c/meetings/m-c/meeting.json": legacyMeeting("proj-c", "m-c"),
  });

  const repo = new YcMeetingRepository(storage);
  const found = await repo.getById("m-c");

  assert.ok(found);
  assert.equal(found.projectId, "proj-c");
});

// ── Тесты: save ─────────────────────────────────────────────────────────────

test("save: записывает по baseKey-пути и обновляет оба индекса", async () => {
  const projectId = "delta";
  const meetingId = "save-444";
  const date = "2026-06-01";
  const meeting = newMeeting(projectId, meetingId, date);

  const storage = new InMemoryStorage({
    "projects/index.json": [{ id: projectId, name: "Delta" }],
  });

  const repo = new YcMeetingRepository(storage);
  await repo.save(meeting);

  const baseKey = `projects/${projectId}/${date}_${meetingId}`;

  // Файл meeting.json по baseKey
  const saved = storage.get(`${baseKey}/meeting.json`);
  assert.ok(saved, "meeting.json должен сохраниться по baseKey-пути");
  assert.equal(saved.id, meetingId);

  // Глобальный индекс
  const global = storage.get("meetings/index.json");
  assert.ok(Array.isArray(global));
  const globalEntry = global.find((m) => m.id === meetingId);
  assert.ok(globalEntry, "запись должна появиться в глобальном индексе");
  assert.equal(globalEntry.baseKey, baseKey);

  // Проектный индекс
  const projectIdx = storage.get(`projects/${projectId}/meetings/index.json`);
  assert.ok(Array.isArray(projectIdx));
  const projectEntry = projectIdx.find((m) => m.id === meetingId);
  assert.ok(projectEntry, "запись должна появиться в проектном индексе");
});

test("save: обновляет summaryTitle из protocol.summary.title", async () => {
  const projectId = "epsilon";
  const meetingId = "save-555";
  const meeting = {
    ...newMeeting(projectId, meetingId),
    protocol: { summary: { title: "Еженедельный стендап" } }
  };

  const storage = new InMemoryStorage({
    "projects/index.json": [{ id: projectId, name: "Epsilon" }],
  });

  const repo = new YcMeetingRepository(storage);
  await repo.save(meeting);

  const projectIdx = storage.get(`projects/${projectId}/meetings/index.json`);
  const entry = projectIdx.find((m) => m.id === meetingId);
  assert.equal(entry.summaryTitle, "Еженедельный стендап");
});

// ── Тесты: delete ────────────────────────────────────────────────────────────

test("delete: удаляет встречу из глобального и проектного индексов", async () => {
  const projectId = "zeta";
  const meetingId = "del-666";
  const date = "2026-06-01";
  const baseKey = `projects/${projectId}/${date}_${meetingId}`;

  const storage = new InMemoryStorage({
    "meetings/index.json": [
      { id: meetingId, projectId, baseKey },
      { id: "other-meeting", projectId: "other", baseKey: "other/key" }
    ],
    [`projects/${projectId}/meetings/index.json`]: [
      { id: meetingId, projectId },
      { id: "sibling", projectId }
    ],
  });

  const repo = new YcMeetingRepository(storage);
  await repo.delete(meetingId);

  const global = storage.get("meetings/index.json");
  assert.ok(!global.some((m) => m.id === meetingId), "удалена из глобального индекса");
  assert.equal(global.length, 1, "другие записи не тронуты");

  const projectIdx = storage.get(`projects/${projectId}/meetings/index.json`);
  assert.ok(!projectIdx.some((m) => m.id === meetingId), "удалена из проектного индекса");
  assert.equal(projectIdx.length, 1, "sibling-запись не тронута");
});

test("delete: удаляет СТАРУЮ встречу (нет в глобальном индексе) через project fallback", async () => {
  const projectId = "eta";
  const meetingId = "del-old-777";

  const storage = new InMemoryStorage({
    // meetings/index.json НЕ содержит эту встречу
    "meetings/index.json": [],
    "projects/index.json": [{ id: projectId, name: "Eta" }],
    [`projects/${projectId}/meetings/index.json`]: [
      { id: meetingId, projectId },
      { id: "keep-me", projectId }
    ],
  });

  const repo = new YcMeetingRepository(storage);
  await repo.delete(meetingId);

  const projectIdx = storage.get(`projects/${projectId}/meetings/index.json`);
  assert.ok(!projectIdx.some((m) => m.id === meetingId), "удалена из проектного индекса");
  assert.equal(projectIdx.length, 1, "keep-me не тронута");
});

// ── Тесты: listByProject ─────────────────────────────────────────────────────

test("listByProject: возвращает встречи из проектного индекса", async () => {
  const projectId = "theta";

  const storage = new InMemoryStorage({
    [`projects/${projectId}/meetings/index.json`]: [
      { id: "m-1", projectId, date: "2026-01-01", status: "done" },
      { id: "m-2", projectId, date: "2026-02-01", status: "uploaded" },
    ],
  });

  const repo = new YcMeetingRepository(storage);
  const list = await repo.listByProject(projectId);

  assert.equal(list.length, 2);
  assert.ok(list.some((m) => m.id === "m-1"));
  assert.ok(list.some((m) => m.id === "m-2"));
});

test("listByProject: возвращает [] если индекса нет", async () => {
  const storage = new InMemoryStorage({});

  const repo = new YcMeetingRepository(storage);
  const list = await repo.listByProject("non-existent-project");

  assert.deepEqual(list, []);
});
