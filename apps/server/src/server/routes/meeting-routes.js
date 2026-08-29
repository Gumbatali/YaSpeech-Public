/**
 * Маршруты встреч: создание, загрузка, черновик, протокол, расшифровка, retry.
 */
import {
  checkTranscriptionQuota,
  incrementTranscriptionUsed
} from "../../../../../packages/core/src/domain/user.js";
import { badRequest, notFound, sendJson, sendText } from "../../shared/http.js";
import { logger } from "../../shared/logger.js";
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
    userRepository,
    artifactStorage,
    pipelineService,
    clock,
    sessionSecret,
    useCases,
    readBody
  } = deps;

  router.add("POST", "/api/meetings", async ({ request, response }) => {
    const payload = await readBody(request);

    requireId(payload.projectId, "Некорректный ID проекта.");
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
    // Проверяем квоту расшифровок для текущего пользователя (до чтения тела — как раньше)
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

    const payload = await readBody(request);
    const meeting = await useCases.markUploadCompleted.execute({
      meetingId: params.id,
      sizeBytes: payload.sizeBytes ?? 0,
      durationSeconds: payload.durationSeconds ?? null
    });
    pipelineService.enqueueProcessing(params.id);
    sendJson(response, 200, { meeting });
  });

  router.add("POST", "/api/meetings/:id/confirm-draft", async ({ request, response, params }) => {
    const payload = await readBody(request);
    const titleDraft = optionalString(payload.titleDraft, "titleDraft", { max: 300 });
    const speakerDrafts = requireArray(payload.speakerDrafts ?? [], "speakerDrafts", { max: 100 });

    const meeting = await pipelineService.confirmDraft(params.id, {
      titleDraft,
      speakerDrafts
    });
    sendJson(response, 200, { meeting });
  });

  router.add("GET", "/api/meetings/:id", async ({ response, params }) => {
    const meeting = await meetingRepository.getById(params.id);
    if (!meeting) {
      notFound(response);
      return;
    }
    sendJson(response, 200, { meeting });
  });

  router.add("POST", "/api/meetings/:id/retry", async ({ response, params }) => {
    const meeting = await pipelineService.retry(params.id);
    sendJson(response, 200, { meeting });
  });

  // POST /api/meetings/:id/transcript/refine — LLM-улучшение расшифровки.
  // Запускается автоматически (см. prepareDraftFromTranscript в
  // meeting-pipeline-service.js) и после правки текста; этот роут теперь
  // используется только для ручного повтора после сбоя (llmRefine.status
  // === "failed" в UI).
  router.add("POST", "/api/meetings/:id/transcript/refine", async ({ response, params }) => {
    const meeting = await meetingRepository.getById(params.id);
    if (!meeting) { notFound(response); return; }

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

  // PATCH /api/meetings/:id/transcript — сохранить отредактированный текст расшифровки
  router.add("PATCH", "/api/meetings/:id/transcript", async ({ request, response, params }) => {
    const meeting = await meetingRepository.getById(params.id);
    if (!meeting) { notFound(response); return; }

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
      llmTranscriptSegments: null,
      updatedAt: clock.now().toISOString()
    };
    await meetingRepository.save(updatedMeeting);

    // Пайплайн без ручных шагов: ручная правка инвалидирует прошлое
    // улучшение, но не оставляет его "зависшим" без кнопки — сразу
    // перезапускаем refine поверх нового текста.
    const refreshed = meeting.llmRefine ? await pipelineService.enqueueRefine(params.id) : updatedMeeting;

    sendJson(response, 200, { ok: true, meeting: refreshed });
  });

  // POST /api/meetings/:id/transcript/restore — вернуть исходную расшифровку из .raw.json
  router.add("POST", "/api/meetings/:id/transcript/restore", async ({ response, params }) => {
    const meeting = await meetingRepository.getById(params.id);
    if (!meeting) { notFound(response); return; }

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
      llmTranscriptSegments: null,
      gptContext: meeting.gptContext
        ? { ...meeting.gptContext, correctedText: original.rawText ?? null }
        : meeting.gptContext,
      updatedAt: clock.now().toISOString()
    };
    await meetingRepository.save(updated);

    // См. комментарий в PATCH /transcript — авто-перезапуск refine вместо
    // "зависшего" stale без кнопки.
    if (meeting.llmRefine) await pipelineService.enqueueRefine(params.id);

    sendJson(response, 200, { ok: true });
  });

  // PATCH /api/meetings/:id/protocol — сохранить отредактированный протокол
  router.add("PATCH", "/api/meetings/:id/protocol", async ({ request, response, params }) => {
    const meeting = await meetingRepository.getById(params.id);
    if (!meeting) { notFound(response); return; }

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
  router.add("POST", "/api/meetings/:id/regenerate-protocol", async ({ response, params }) => {
    const meeting = await meetingRepository.getById(params.id);
    if (!meeting) { notFound(response); return; }

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

  router.add("GET", "/api/meetings/:id/protocol.txt", async ({ response, params }) => {
    const meeting = await meetingRepository.getById(params.id);
    if (!meeting) {
      notFound(response);
      return;
    }

    const protocol = await artifactStorage.readText(meeting.artifacts.protocolTextKey);
    if (!protocol) {
      notFound(response);
      return;
    }
    sendText(response, 200, protocol);
  });

  router.add("GET", "/api/meetings/:id/transcript.txt", async ({ response, params }) => {
    const meeting = await meetingRepository.getById(params.id);
    if (!meeting) {
      notFound(response);
      return;
    }

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

  router.add("DELETE", "/api/meetings/:id", async ({ response, params }) => {
    await meetingRepository.delete(params.id);

    // jobId диаризации === meetingId (см. PyannoteDiarization.startJob) —
    // подчищаем сироту в S3, чтобы удалённая встреча не оставляла висящий
    // статус "pending"/"running" без хозяина в очереди диаризации.
    // Само сообщение в YMQ-очереди не удалить без receipt handle — но
    // подчистка S3-статуса убирает главный видимый симптом (реальный
    // инцидент 2026-08-29: осиротевшая джоба 46e16fd4).
    await Promise.all([
      artifactStorage.delete(`diarization-jobs/${params.id}/status.json`),
      artifactStorage.delete(`diarization-jobs/${params.id}/diarization.rttm`)
    ]).catch((e) => logger.warn("delete meeting: diarization job cleanup failed", { meetingId: params.id, error: e.message }));

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
