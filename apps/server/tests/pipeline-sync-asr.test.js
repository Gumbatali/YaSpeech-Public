import { test } from "node:test";
import assert from "node:assert/strict";

import { MeetingPipelineService } from "../src/application/meeting-pipeline-service.js";

/**
 * Регрессия, пойманная на staging 2026-08-06: при ASR_PROVIDER=smart
 * первая же встреча падала с
 *   SPEECHKIT_ERROR: this.speechKitGateway.startRecognition is not a function
 *
 * Причина — два разных контракта ASR-гейтвеев:
 *   • YcSpeechKitGateway  — двухфазный: startRecognition() + pollRecognitionOnce(),
 *     потому что распознавание идёт дольше таймаута функции и воркер обязан
 *     выйти и вернуться по очереди.
 *   • SmartAsrGateway / GroqWhisperGateway — синхронные: processMeeting()
 *     скачивает аудио, транскрибирует и диаризует за одну инвокацию
 *     (под это deploy.sh поднимает WORKER_TIMEOUT до 600s).
 *
 * Pipeline знал только про первый контракт. Тесты гейтвеев этого не ловили:
 * они дёргают processMeeting() напрямую, минуя pipeline.
 */

// Длина неслучайна: prepareDraftFromTranscript отклоняет транскрипты короче
// 20 слов кодом POOR_TRANSCRIPT, так что фикстура должна быть похожа на живую
// расшифровку, иначе тест упрётся в валидатор вместо проверяемого поведения.
const FIRST_LINE = "Добрый день коллеги начнём планёрку с обсуждения текущих объектов и сроков";
const SECOND_LINE = "Здравствуйте по Рыбинску заключение готово отчёт отправлен заказчику на согласование";

const TRANSCRIPT = {
  rawText: `Спикер 1: ${FIRST_LINE}\nСпикер 2: ${SECOND_LINE}`,
  phrases: [
    { speakerId: "speaker-1", speakerLabel: "Спикер 1", startTimeMs: 0, endTimeMs: 6000, text: FIRST_LINE },
    { speakerId: "speaker-2", speakerLabel: "Спикер 2", startTimeMs: 6500, endTimeMs: 12000, text: SECOND_LINE },
  ],
};

const MEETING = {
  id: "m-1",
  projectId: "p-1",
  status: "uploaded",
  artifacts: {
    audioOriginalKey: "audio.wav",
    transcriptKey: "transcript.json",
    protocolJsonKey: "protocol.json",
    protocolTextKey: "protocol.txt",
  },
};

/** Синхронный гейтвей: только processMeeting, как у Smart/Groq. */
function makeSyncGateway() {
  return {
    calls: 0,
    async processMeeting() {
      this.calls++;
      return { jobId: "smart-1", transcript: structuredClone(TRANSCRIPT) };
    },
  };
}

/** Двухфазный гейтвей: start + poll, как у SpeechKit. */
function makeTwoPhaseGateway({ readyOnPoll = true } = {}) {
  return {
    startCalls: 0,
    pollCalls: 0,
    async startRecognition() {
      this.startCalls++;
      return { operationId: "op-1" };
    },
    async pollRecognitionOnce() {
      this.pollCalls++;
      if (!readyOnPoll) return { done: false };
      return { done: true, jobId: "op-1", transcript: structuredClone(TRANSCRIPT) };
    },
  };
}

function makeHarness(speechKitGateway) {
  const saved = [];
  const enqueued = [];
  let current = { ...MEETING };

  const service = new MeetingPipelineService({
    meetingRepository: {
      async getById() { return { ...current }; },
      async save(meeting) { current = { ...meeting }; saved.push(meeting); return meeting; },
    },
    projectRepository: {
      async getById() { return { id: "p-1", name: "Проект", team: [] }; },
      async getGlossary() { return null; },
    },
    artifactStorage: {
      async writeJson() {},
      async writeText() {},
    },
    speechKitGateway,
    yandexGptGateway: {
      async buildContext() { return { domain: "общий", mentionedEntities: { people: [] } }; },
      async diarizeTranscript(transcript) { return { ...transcript, diarizedByGpt: false }; },
      async extractGlossary() { return null; },
    },
    queueRunner: {
      async enqueue(taskId, _fn, options = {}) { enqueued.push({ taskId, ...options }); },
    },
    clock: { now: () => new Date("2026-08-07T12:00:00Z") },
  });

  return { service, saved, enqueued, getCurrent: () => current };
}

test("синхронный ASR-гейтвей не роняет pipeline на старте", async () => {
  // Именно этот сценарий падал на staging: без processMeeting-ветки
  // pipeline звал несуществующий startRecognition и встреча уходила в failed.
  const gateway = makeSyncGateway();
  const { service, getCurrent } = makeHarness(gateway);

  await service.processMeeting("m-1");

  assert.equal(gateway.calls, 1, "должен быть вызван processMeeting синхронного гейтвея");
  assert.notEqual(
    getCurrent().status,
    "failed",
    `встреча не должна падать, ошибка: ${JSON.stringify(getCurrent().error ?? null)}`
  );
});

test("синхронный ASR доводит встречу до черновика за одну инвокацию", async () => {
  // У синхронного пути нет фазы poll-asr: транскрипт готов сразу,
  // поэтому встреча обязана уйти дальше по конвейеру, а не залипнуть
  // в speechkit_processing навсегда (там её потом добьёт watchdog).
  const gateway = makeSyncGateway();
  const { service, getCurrent, enqueued } = makeHarness(gateway);

  await service.processMeeting("m-1");

  // Проверка именно позитивная: «не speechkit_processing» прошло бы и на
  // упавшей встрече (failed тоже не равен speechkit_processing), то есть
  // стерегло бы ровно ничего.
  // draft_ready, а не protocol_generating: с 2026-06-10 черновик собирается
  // из сырого ASR без LLM, а протокол генерируется отдельно по кнопке.
  assert.equal(
    getCurrent().status,
    "draft_ready",
    `встреча должна дойти до черновика, а не остаться в ASR-фазе; ` +
    `ошибка: ${JSON.stringify(getCurrent().error ?? null)}`
  );
  assert.equal(
    enqueued.filter((e) => e.phase === "poll-asr").length,
    0,
    "для синхронного гейтвея poll-asr не нужен"
  );
});

test("двухфазный SpeechKit продолжает работать как раньше", async () => {
  // Страховка от регрессии: правка не должна ломать основной прод-путь.
  const gateway = makeTwoPhaseGateway();
  const { service, enqueued } = makeHarness(gateway);

  await service.processMeeting("m-1");

  assert.equal(gateway.startCalls, 1, "SpeechKit должен стартовать через startRecognition");
  assert.equal(
    enqueued.filter((e) => e.phase === "poll-asr").length,
    1,
    "двухфазный путь обязан поставить poll-asr в очередь"
  );
});
