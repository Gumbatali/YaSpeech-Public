/**
 * Smoke-тесты извлечённых экранов: рендерим каждый в Node со стабами React.
 *
 * Ловят класс ошибок «free variable» (как недавний баг startEditSummary):
 * вычисление html`...` выполняет все интерполяции, и обращение к
 * несуществующему идентификатору падает ReferenceError прямо здесь,
 * без браузера.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const libDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../lib");

// htm — настоящий UMD. require() здесь нельзя: из-за "type": "module"
// в корневом package.json Node загрузил бы его как ESM. Исполняем как CJS вручную.
const htmSource = readFileSync(path.join(libDir, "htm.umd.js"), "utf8");
const htmModule = { exports: {} };
new Function("module", "exports", htmSource).call(htmModule.exports, htmModule, htmModule.exports);
const htm = htmModule.exports;

const ReactStub = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children };
  },
  useState(initial) {
    return [typeof initial === "function" ? initial() : initial, () => {}];
  },
  useEffect() {},
  useRef(initial = null) {
    return { current: initial };
  }
};

globalThis.window = { React: ReactStub, htm };

// Импортируем ПОСЛЕ установки window — модули читают window.React при загрузке
const { LoginScreen } = await import("../app/screens/login-screen.js");
const { AdminScreen } = await import("../app/screens/admin-screen.js");
const { SummaryTab } = await import("../app/screens/summary-tab.js");
const { TranscriptTab } = await import("../app/screens/transcript-tab.js");

const apiStub = new Proxy({}, { get: () => async () => ({}) });
const noop = () => {};

const protocolFixture = {
  summary: { title: "Тестовая встреча", overview: "Обзор" },
  participants: ["Иванов", "Петров"],
  decisions: ["Решение раз"],
  actionItems: [{ owner: "Иванов", task: "Сделать", deadline: "2026-07-01" }],
  transcriptHighlights: [{ speaker: "Иванов", quote: "Цитата" }]
};

const meetingFixture = {
  id: "m-1",
  projectId: "p-1",
  date: "2026-06-01",
  status: "done",
  protocol: protocolFixture,
  transcriptSegments: [
    { speakerId: "s1", speakerLabel: "Спикер 1", guessedName: "Иванов", text: "Привет", startTimeMs: 0 },
    { speakerId: "s2", speakerLabel: "Спикер 2", guessedName: null, text: "Здравствуйте", startTimeMs: 5000 }
  ],
  rawTranscriptSegments: [
    { speakerId: "s1", speakerLabel: "Спикер 1", guessedName: "Иванов", text: "Привет", startTimeMs: 0 }
  ],
  speakerDrafts: [
    { id: "s1", label: "Спикер 1", guessedName: "Иванов", guessedRole: "ПМ", confidence: "high" }
  ],
  gptContext: { correctedText: "Иванов: Привет\nПетров: Здравствуйте" }
};

test("LoginScreen рендерится без ReferenceError", () => {
  const tree = LoginScreen({ api: apiStub, onAuth: noop });
  assert.ok(tree, "дерево вернулось");
});

test("AdminScreen: пустой список и таблица с пользователями", () => {
  const base = {
    api: apiStub,
    authUser: { id: "u1", login: "boss", role: "admin" },
    adminLoading: false,
    adminBusyId: null,
    runAdminAction: noop,
    loadAdminUsers: noop,
    openProjectHome: noop,
    handleLogout: noop,
    setError: noop,
    noticeArea: null
  };

  assert.ok(AdminScreen({ ...base, adminUsers: [] }));
  assert.ok(AdminScreen({
    ...base,
    adminUsers: [
      { id: "u1", login: "boss", role: "admin", status: "active", transcriptionQuota: null, transcriptionUsed: 2 },
      { id: "u2", login: "worker", role: "member", status: "banned", transcriptionQuota: 5, transcriptionUsed: 5 }
    ]
  }));
});

test("SummaryTab: режим просмотра и режим редактирования", () => {
  const base = {
    api: apiStub,
    protocol: protocolFixture,
    activeMeeting: meetingFixture,
    setActiveMeeting: noop,
    setSummaryDraft: noop,
    setEditingSummary: noop,
    savingSummary: false,
    setSavingSummary: noop,
    setNotice: noop,
    setError: noop,
    onStartEdit: noop
  };

  // просмотр
  assert.ok(SummaryTab({ ...base, editingSummary: false, summaryDraft: null }));

  // редактирование
  assert.ok(SummaryTab({
    ...base,
    editingSummary: true,
    summaryDraft: {
      overview: "Обзор",
      participants: ["Иванов", ""],
      decisions: ["Решение"],
      actionItems: [{ owner: "Иванов", task: "Сделать", deadline: null }]
    }
  }));

  // пустой протокол не падает
  assert.ok(SummaryTab({
    ...base,
    protocol: { summary: {} },
    editingSummary: false,
    summaryDraft: null
  }));
});

test("TranscriptTab: raw/llm/редактор", () => {
  const base = {
    api: apiStub,
    activeMeeting: meetingFixture,
    setActiveMeeting: noop,
    setTranscriptVersion: noop,
    editingTranscript: false,
    setEditingTranscript: noop,
    transcriptEditText: "",
    setTranscriptEditText: noop,
    savingTranscript: false,
    setSavingTranscript: noop,
    regenerating: false,
    setRegenerating: noop,
    restoringTranscript: false,
    setRestoringTranscript: noop,
    setNotice: noop,
    setError: noop
  };

  assert.ok(TranscriptTab({ ...base, transcriptVersion: "raw" }));
  assert.ok(TranscriptTab({ ...base, transcriptVersion: "llm" }));
  assert.ok(TranscriptTab({ ...base, editingTranscript: true, transcriptEditText: "Иванов: текст" }));

  // встреча без расшифровки не падает
  assert.ok(TranscriptTab({
    ...base,
    transcriptVersion: "raw",
    activeMeeting: { id: "m-2", gptContext: null }
  }));
});
