/**
 * Маршруты встреч: создание, загрузка, черновик, протокол, расшифровка, retry.
 */
import {
  checkTranscriptionQuota,
  incrementTranscriptionUsed
} from "../../../../../packages/core/src/domain/user.js";
import {
  isUploadStalled,
  isProcessingStalled,
  markUploadStalled,
  markProcessingStalled,
  reopenMeetingUpload,
  touchUploadHeartbeat
} from "../../../../../packages/core/src/domain/meeting.js";
import { badRequest, notFound, sendJson, sendText } from "../../shared/http.js";
import { canAccessProject } from "../../shared/authorize.js";
import {
  optionalIsoDate,
  optionalString,
  requireArray,
  requireId
} from "../../shared/validate.js";

const ALLOWED_CONTENT_TYPES = [
  "audio/mpeg", "audio/mp3", "audio/mp4", "audio/m4a",
  "audio/x-m4a", "audio/wav", "audio/wave", "audio/ogg",
  "audio/webm", "audio/aac", "audio/flac", "audio/x-flac",
  "audio/opus", "application/octet-stream"
];
const AUDIO_EXT = /\.(mp3|m4a|mp4|wav|ogg|webm|aac|flac|opus)$/i;
const MAX_FILE_NAME_LEN = 255;

export function registerMeetingRoutes(router, deps) {
  const {
    meetingRepository,
    projectRepository,
    userRepository,
    artifactStorage,
    pipelineService,
    clock,
    sessionSecret,
    useCases,
    readBody
  } = deps;

  // Загружает встречу и проверяет, что currentUser владеет её проектом
  // (или проект общий/легаси без owner, или пользователь — админ).
  // Возвращает null и уже отправляет 404 при отсутствии доступа —
  // 404, а не 403, чтобы не подтверждать существование чужой встречи.
  //
  // project === null считаем доступным (не запрещаем), а не отказом:
  // старые проекты (до появления team.json/ownerId) не имеют манифеста
  // вовсе, но их встречи должны продолжать открываться, как раньше.
  async function getAuthorizedMeeting(meetingId, currentUser, response) {
    const meeting = await meetingRepository.getById(meetingId);
    if (!meeting) {
      notFound(response);
      return null;
    }
    const project = await projectRepository.getById(meeting.projectId);
    if (project && !canAccessProject(project, currentUser)) {
      notFound(response);
      return null;
    }
    return meeting;
  }

  router.add("POST", "/api/meetings", async ({ request, response, currentUser }) => {
    const payload = await readBody(request);

    requireId(payload.projectId, "Некорректный ID проекта.");
    const project = await projectRepository.getById(payload.projectId);
    if (!canAccessProject(project, currentUser)) {
      notFound(response);
      return;
    }
    const date = optionalIsoDate(payload.date, "date");
    const participantIds = requireArray(payload.participantIds ?? [], "participantIds", { max: 200 });
    const guests = requireArray(payload.guests ?? [], "guests", { max: 200 });

    const ct = (payload.contentType || "").toLowerCase().split(";")[0].trim();
    const fn = payload.fileName || "";

    if (!ALLOWED_CONTENT_TYPES.includes(ct) && !AUDIO_EXT.test(fn)) {
      badRequest(response, "Неподдерживаемый формат файла. Допустимы только аудиофайлы (MP3, M4A, WAV, OGG, FLAC, AAC).");
      return;
    }

    if (!fn || fn.length > MAX_FILE_NAME_LEN) {
      badRequest(response, "Некорректное имя файла.");
      return;
    }

    const result = await useCases.createMeeting.execute({
      projectId: payload.projectId,
      date,
      startTime: payload.startTime ?? null,
      endTime: payload.endTime ?? null,
      participantIds,
      guests,
      fileName: payload.fileName,
      contentType: payload.contentType
    });
    sendJson(response, 201, result);
  });

  router.add("POST", "/api/meetings/:id/upload-complete", async ({ request, response, params, currentUser }) => {
    if (!(await getAuthorizedMeeting(params.id, currentUser, response))) return;

    const payload = await readBody(request);
    const durationSeconds = payload.durationSeconds ?? null;

    // Проверяем квоту расшифровок для текущего пользователя
    if (currentUser && sessionSecret) {
      const freshUser = await userRepository.findById(currentUser.id);
      if (freshUser) {
        const quotaCheck = checkTranscriptionQuota(freshUser);
        if (!quotaCheck.allowed) {
          sendJson(response, 402, { error: quotaCheck.reason });
          return;
        }
        // Инкрементируем счётчик сразу при постановке в обработку
        const withUsed = incrementTranscriptionUsed(freshUser, clock.now().toISOString());
        await userRepository.save(withUsed);
      }
    }

    const meeting = await useCases.markUploadCompleted.execute({
      meetingId: params.id,
      sizeBytes: payload.sizeBytes ?? 0,
      durationSeconds
    });
    // await обязателен: если постановка в очередь упала (права, YMQ),
    // пользователь должен увидеть ошибку, а не «успех» с вечно зависшей встречей
    await pipelineService.enqueueProcessing(params.id);
    sendJson(response, 200, { meeting });
  });

  router.add("POST", "/api/meetings/:id/confirm-draft", async ({ request, response, params, currentUser }) => {
    if (!(await getAuthorizedMeeting(params.id, currentUser, response))) return;

    const payload = await readBody(request);
    const titleDraft = optionalString(payload.titleDraft, "titleDraft", { max: 300 });
    const speakerDrafts = requireArray(payload.speakerDrafts ?? [], "speakerDrafts", { max: 100 });

    const meeting = await pipelineService.confirmDraft(params.id, {
      titleDraft,
      speakerDrafts
    });
    sendJson(response, 200, { meeting });
  });

  // Зависания лечим на чтении (у serverless нет фонового процесса для этого):
  // — uploading без heartbeat'ов = браузер бросил загрузку;
  // — uploaded/speechkit_processing/protocol_generating без обновлений =
  //   очередь/триггер мертвы или worker упал.
  // В обоих случаях встреча становится failed с понятной ошибкой вместо
  // вечного «Загружаем…»/«Готовим текст…».
  async function healIfStalled(meeting) {
    const nowIso = clock.now().toISOString();

    let healed = meeting;
    if (isUploadStalled(meeting, nowIso)) {
      healed = markUploadStalled(meeting, nowIso);
    } else if (isProcessingStalled(meeting, nowIso)) {
      healed = markProcessingStalled(meeting, nowIso);
    }

    if (healed !== meeting) {
      await meetingRepository.save(healed);
    }
    return healed;
  }

  router.add("GET", "/api/meetings/:id", async ({ response, params, currentUser }) => {
    const meeting = await getAuthorizedMeeting(params.id, currentUser, response);
    if (!meeting) return;
    sendJson(response, 200, { meeting: await healIfStalled(meeting) });
  });

  // POST /api/meetings/:id/upload-heartbeat — браузер пингует во время загрузки
  // файла, чтобы сервер отличал живую медленную загрузку от брошенной.
  router.add("POST", "/api/meetings/:id/upload-heartbeat", async ({ request, response, params, currentUser }) => {
    const meeting = await getAuthorizedMeeting(params.id, currentUser, response);
    if (!meeting) return;
    if (meeting.status !== "uploading") {
      sendJson(response, 409, { error: "Встреча не в состоянии загрузки.", meeting });
      return;
    }

    const payload = await readBody(request);
    const touched = touchUploadHeartbeat(meeting, payload.progressPct, clock.now().toISOString());
    await meetingRepository.save(touched);
    sendJson(response, 200, { meeting: touched });
  });

  // POST /api/meetings/:id/reupload — новый upload-URL для повторной загрузки
  // после обрыва (UPLOAD_STALLED), без пересоздания встречи.
  router.add("POST", "/api/meetings/:id/reupload", async ({ response, params, currentUser }) => {
    const meeting = await getAuthorizedMeeting(params.id, currentUser, response);
    if (!meeting) return;

    const isStalledFailure = meeting.status === "failed" && meeting.error?.code === "UPLOAD_STALLED";
    if (meeting.status !== "uploading" && !isStalledFailure) {
      badRequest(response, "Повторная загрузка доступна только для прерванной загрузки.");
      return;
    }

    const reopened = reopenMeetingUpload(meeting, clock.now().toISOString());
    const upload = await artifactStorage.issueMeetingUpload(reopened);
    const saved = { ...reopened, upload };
    await meetingRepository.save(saved);
    sendJson(response, 200, { meeting: saved, upload });
  });

  router.add("POST", "/api/meetings/:id/retry", async ({ response, params, currentUser }) => {
    if (!(await getAuthorizedMeeting(params.id, currentUser, response))) return;

    const meeting = await pipelineService.retry(params.id);
    sendJson(response, 200, { meeting });
  });

  // POST /api/meetings/:id/transcript/refine — LLM-улучшение расшифровки.
  // ЕДИНСТВЕННАЯ точка запуска LLM-коррекции (автоматических вызовов нет).
  router.add("POST", "/api/meetings/:id/transcript/refine", async ({ response, params, currentUser }) => {
    const meeting = await getAuthorizedMeeting(params.id, currentUser, response);
    if (!meeting) return;

    if (!["draft_ready", "done", "failed"].includes(meeting.status)) {
      badRequest(response, "Улучшение доступно после готовности расшифровки.");
      return;
    }

    const refineStatus = meeting.llmRefine?.status;
    if (refineStatus === "queued" || refineStatus === "processing") {
      sendJson(response, 409, { error: "Улучшение уже выполняется." });
      return;
    }
    if (refineStatus === "done") {
      sendJson(response, 409, {
        error: "Расшифровка уже улучшена. Повторное улучшение доступно после редактирования текста."
      });
      return;
    }

    const updated = await pipelineService.enqueueRefine(params.id);
    sendJson(response, 202, { meeting: updated });
  });

  // POST /api/meetings/:id/transcript/dialogue — литературная запись диалога.
  // Строится поверх уже завершённого refine (требование), поэтому доступна
  // только после llmRefine.status==="done".
  router.add("POST", "/api/meetings/:id/transcript/dialogue", async ({ response, params, currentUser }) => {
    const meeting = await getAuthorizedMeeting(params.id, currentUser, response);
    if (!meeting) return;

    if (!["draft_ready", "done", "failed"].includes(meeting.status)) {
      badRequest(response, "Диалог доступен после готовности расшифровки.");
      return;
    }
    if (meeting.llmRefine?.status !== "done") {
      badRequest(response, "Сначала нажмите «Улучшить с помощью ИИ» — диалог строится поверх улучшенной расшифровки.");
      return;
    }

    const dialogueStatus = meeting.llmDialogue?.status;
    if (dialogueStatus === "queued" || dialogueStatus === "processing") {
      sendJson(response, 409, { error: "Сборка диалога уже выполняется." });
      return;
    }
    if (dialogueStatus === "done") {
      sendJson(response, 409, {
        error: "Диалог уже собран. Повторная сборка доступна после редактирования расшифровки."
      });
      return;
    }

    const updated = await pipelineService.enqueueDialogue(params.id);
    sendJson(response, 202, { meeting: updated });
  });

  // PATCH /api/meetings/:id/transcript — сохранить отредактированный текст расшифровки
  router.add("PATCH", "/api/meetings/:id/transcript", async ({ request, response, params, currentUser }) => {
    const meeting = await getAuthorizedMeeting(params.id, currentUser, response);
    if (!meeting) return;

    const { rawText } = await readBody(request);
    if (typeof rawText !== "string" || !rawText.trim()) {
      badRequest(response, "rawText обязателен.");
      return;
    }

    // Парсим строки вида "Спикер 1: текст" обратно в phrases
    const phrases = rawText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const m = line.match(/^(.{1,50}):\s*(.+)$/);
        if (m) return { speakerLabel: m[1], speakerId: m[1].toLowerCase().replace(/\s+/g, "-"), text: m[2] };
        return { speakerLabel: "", speakerId: "speaker-1", text: line };
      });

    const existing = await artifactStorage.readJson(meeting.artifacts.transcriptKey) ?? {};
    await artifactStorage.writeJson(meeting.artifacts.transcriptKey, {
      ...existing,
      rawText: rawText.trim(),
      phrases,
      editedByUser: true,
      editedAt: clock.now().toISOString()
    });

    // ВАЖНО: UI читает сегменты из объекта встречи, а не из transcript.json.
    // Обновляем segments + correctedText, иначе правка не видна.
    const segments = phrases.map((p) => ({
      speakerId: p.speakerId,
      speakerLabel: p.speakerLabel,
      guessedName: null,
      text: p.text,
      startTimeMs: null,
      endTimeMs: null
    }));
    const updatedMeeting = {
      ...meeting,
      transcriptSegments: segments,
      rawTranscriptSegments: segments,
      gptContext: {
        ...(meeting.gptContext ?? {}),
        correctedText: rawText.trim()
      },
      // Ручная правка инвалидирует LLM-улучшение: кнопка снова доступна,
      // протокол собирается по отредактированному тексту. Диалог построен
      // поверх старого refine-текста — тоже устарел.
      ...(meeting.llmRefine ? { llmRefine: { status: "stale" } } : {}),
      ...(meeting.llmDialogue ? { llmDialogue: { status: "stale" } } : {}),
      llmTranscriptSegments: null,
      llmDialogueSegments: null,
      updatedAt: clock.now().toISOString()
    };
    await meetingRepository.save(updatedMeeting);

    sendJson(response, 200, { ok: true, meeting: updatedMeeting });
  });

  // POST /api/meetings/:id/transcript/restore — вернуть исходную расшифровку из .raw.json
  router.add("POST", "/api/meetings/:id/transcript/restore", async ({ response, params, currentUser }) => {
    const meeting = await getAuthorizedMeeting(params.id, currentUser, response);
    if (!meeting) return;

    const rawKey = meeting.artifacts.transcriptKey.replace(/\.json$/, ".raw.json");
    const original = await artifactStorage.readJson(rawKey);
    if (!original) {
      badRequest(response, "Исходная расшифровка недоступна для этой встречи.");
      return;
    }

    await artifactStorage.writeJson(meeting.artifacts.transcriptKey, {
      ...original,
      restoredFromOriginal: true,
      restoredAt: clock.now().toISOString()
    });

    // Сбрасываем сегменты на исходные, чтобы UI показал оригинал
    const segments = (original.phrases ?? []).map((p) => ({
      speakerId: p.speakerId,
      speakerLabel: p.speakerLabel,
      guessedName: p.detectedName ?? null,
      text: p.text,
      startTimeMs: p.startTimeMs ?? null,
      endTimeMs: p.endTimeMs ?? null
    }));
    const updated = {
      ...meeting,
      rawTranscriptSegments: segments,
      transcriptSegments: segments,
      // Восстановление оригинала инвалидирует LLM-улучшение и устаревший
      // correctedText — протокол соберётся по фактическому (исходному) тексту
      ...(meeting.llmRefine ? { llmRefine: { status: "stale" } } : {}),
      ...(meeting.llmDialogue ? { llmDialogue: { status: "stale" } } : {}),
      llmTranscriptSegments: null,
      llmDialogueSegments: null,
      gptContext: meeting.gptContext
        ? { ...meeting.gptContext, correctedText: original.rawText ?? null }
        : meeting.gptContext,
      updatedAt: clock.now().toISOString()
    };
    await meetingRepository.save(updated);
    sendJson(response, 200, { ok: true });
  });

  // PATCH /api/meetings/:id/protocol — сохранить отредактированный протокол
  router.add("PATCH", "/api/meetings/:id/protocol", async ({ request, response, params, currentUser }) => {
    const meeting = await getAuthorizedMeeting(params.id, currentUser, response);
    if (!meeting) return;

    const { protocol } = await readBody(request);
    if (!protocol || typeof protocol !== "object" || Array.isArray(protocol)) {
      badRequest(response, "protocol обязателен.");
      return;
    }

    await artifactStorage.writeJson(meeting.artifacts.protocolJsonKey, protocol);

    const updated = { ...meeting, protocol, updatedAt: clock.now().toISOString() };
    await meetingRepository.save(updated);
    sendJson(response, 200, { ok: true });
  });

  // POST /api/meetings/:id/regenerate-protocol — пересобрать протокол из сохранённой расшифровки
  router.add("POST", "/api/meetings/:id/regenerate-protocol", async ({ response, params, currentUser }) => {
    const meeting = await getAuthorizedMeeting(params.id, currentUser, response);
    if (!meeting) return;

    if (!["done", "failed"].includes(meeting.status)) {
      badRequest(response, "Пересборка доступна только для завершённых или упавших встреч.");
      return;
    }

    const updated = {
      ...meeting,
      status: "protocol_generating",
      currentStage: "protocol_generating",
      updatedAt: clock.now().toISOString(),
      error: undefined
    };
    await meetingRepository.save(updated);
    pipelineService.enqueueProcessing(params.id);
    sendJson(response, 200, { meeting: updated });
  });

  router.add("GET", "/api/meetings/:id/protocol.txt", async ({ response, params, currentUser }) => {
    const meeting = await getAuthorizedMeeting(params.id, currentUser, response);
    if (!meeting) return;

    const protocol = await artifactStorage.readText(meeting.artifacts.protocolTextKey);
    if (!protocol) {
      notFound(response);
      return;
    }
    sendText(response, 200, protocol);
  });

  router.add("GET", "/api/meetings/:id/transcript.txt", async ({ response, params, currentUser }) => {
    const meeting = await getAuthorizedMeeting(params.id, currentUser, response);
    if (!meeting) return;

    const transcript = await artifactStorage.readJson(meeting.artifacts.transcriptKey);
    if (!transcript) {
      notFound(response);
      return;
    }

    // rawText содержит реплики вида "Спикер N: текст"; если его нет —
    // собираем из phrases. Для отдачи нужен человекочитаемый текст.
    const text = transcript.rawText
      ?? (transcript.phrases ?? [])
        .map((p) => `${p.speakerLabel ? `${p.speakerLabel}: ` : ""}${p.text}`)
        .join("\n");

    sendText(response, 200, text);
  });

  router.add("DELETE", "/api/meetings/:id", async ({ response, params, currentUser }) => {
    if (!(await getAuthorizedMeeting(params.id, currentUser, response))) return;

    await meetingRepository.delete(params.id);
    sendJson(response, 200, { ok: true });
  });

  // PUT /local-upload/:id — локальный приём файла (dev-режим, без auth)
  router.add("PUT", "/local-upload/:id", async ({ request, response, params, url }) => {
    const token = url.searchParams.get("token");
    if (!params.id || !token) {
      badRequest(response, "Missing upload token.");
      return;
    }
    await artifactStorage.writeUpload(params.id, token, request);
    sendJson(response, 200, { ok: true });
  });
}
