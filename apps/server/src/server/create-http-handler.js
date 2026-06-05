import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  CreateMeetingUseCase,
  CreateProjectUseCase,
  MarkUploadCompletedUseCase,
  UpdateProjectTeamUseCase,
  RegisterUserUseCase,
  LoginUserUseCase,
  publicUser
} from "../../../../packages/core/src/index.js";
import {
  banUser,
  unbanUser,
  setRole,
  checkTranscriptionQuota,
  incrementTranscriptionUsed,
  setTranscriptionQuota,
  resetTranscriptionUsed
} from "../../../../packages/core/src/domain/user.js";
import {
  badRequest,
  notFound,
  readJsonRequestBody,
  sendJson,
  sendText,
  serverError,
  UserError
} from "../shared/http.js";
import {
  verifySessionToken,
  parseCookies,
  createSessionToken,
  setSessionCookie,
  clearSessionCookie
} from "../shared/session.js";

function splitPathname(pathname) {
  return pathname.split("/").filter(Boolean);
}

function getContentType(filePath) {
  const extension = path.extname(filePath);

  if (extension === ".js") {
    return "application/javascript; charset=utf-8";
  }

  if (extension === ".css") {
    return "text/css; charset=utf-8";
  }

  if (extension === ".html") {
    return "text/html; charset=utf-8";
  }

  if (extension === ".svg") {
    return "image/svg+xml; charset=utf-8";
  }

  return "application/octet-stream";
}

export function createHttpHandler({
  projectRepository,
  meetingRepository,
  userRepository,
  artifactStorage,
  pipelineService,
  clock,
  idGenerator,
  webRootDirectory,
  sessionSecret,
  adminLogin,
  passwordHasher,
  passwordVerifier
}) {
  const createProject = new CreateProjectUseCase(
    projectRepository,
    clock,
    idGenerator
  );
  const updateProjectTeam = new UpdateProjectTeamUseCase(projectRepository, clock);
  const createMeeting = new CreateMeetingUseCase(
    projectRepository,
    meetingRepository,
    artifactStorage,
    clock,
    idGenerator
  );
  const markUploadCompleted = new MarkUploadCompletedUseCase(meetingRepository, clock);

  /**
   * Читает сессионную cookie и возвращает текущего пользователя или null.
   * Если SESSION_SECRET не задан → auth отключён (local dev).
   */
  async function resolveCurrentUser(request) {
    if (!sessionSecret) return null;
    const cookies = parseCookies(request.headers.cookie ?? "");
    const token = cookies.session;
    if (!token) return null;
    const userId = verifySessionToken(token, sessionSecret);
    if (!userId) return null;
    const user = await userRepository.findById(userId);
    if (!user || user.status === "banned") return null;
    return user;
  }

  return async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const parts = splitPathname(url.pathname);

    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-headers", "content-type");
    response.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    try {
      // ── Auth routes (без проверки сессии) ────────────────────────────────────

      if (parts[0] === "api" && parts[1] === "auth" && parts[2] === "register"
          && request.method === "POST") {
        const payload = await readJsonRequestBody(request);
        const registerUseCase = new RegisterUserUseCase(
          userRepository, passwordHasher, clock, idGenerator, adminLogin
        );
        let regUser;
        try {
          regUser = await registerUseCase.execute({
            login: payload.login ?? "",
            password: payload.password ?? ""
          });
        } catch (e) {
          badRequest(response, e.message);
          return;
        }
        if (sessionSecret) {
          const token = createSessionToken(regUser.id, sessionSecret);
          setSessionCookie(response, token);
        }
        sendJson(response, 201, { user: regUser });
        return;
      }

      if (parts[0] === "api" && parts[1] === "auth" && parts[2] === "login"
          && request.method === "POST") {
        const payload = await readJsonRequestBody(request);
        const loginUseCase = new LoginUserUseCase(userRepository, passwordVerifier);
        let loginUser;
        try {
          loginUser = await loginUseCase.execute({
            login: payload.login ?? "",
            password: payload.password ?? ""
          });
        } catch (e) {
          // 401 для неверных данных, 403 для бана
          const status = e.message.includes("заблокирован") ? 403 : 401;
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: e.message }));
          return;
        }
        if (sessionSecret) {
          const token = createSessionToken(loginUser.id, sessionSecret);
          setSessionCookie(response, token);
        }
        sendJson(response, 200, { user: loginUser });
        return;
      }

      if (parts[0] === "api" && parts[1] === "auth" && parts[2] === "logout"
          && request.method === "POST") {
        clearSessionCookie(response);
        sendJson(response, 200, { ok: true });
        return;
      }

      if (parts[0] === "api" && parts[1] === "auth" && parts[2] === "me"
          && request.method === "GET") {
        const currentUser = await resolveCurrentUser(request);
        if (!currentUser) {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "Не авторизован." }));
          return;
        }
        sendJson(response, 200, { user: publicUser(currentUser) });
        return;
      }

      // ── Session middleware для всех /api/* кроме /api/auth/* ─────────────────
      let currentUser = null;
      if (parts[0] === "api" && parts[1] !== "auth") {
        if (sessionSecret) {
          currentUser = await resolveCurrentUser(request);
          if (!currentUser) {
            response.writeHead(401, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: "Требуется авторизация." }));
            return;
          }
        }
      }

      // ── Admin routes ──────────────────────────────────────────────────────────

      if (parts[0] === "api" && parts[1] === "admin") {
        if (!currentUser || currentUser.role !== "admin") {
          response.writeHead(403, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "Доступ запрещён." }));
          return;
        }

        // GET /api/admin/users
        if (parts[2] === "users" && parts.length === 3 && request.method === "GET") {
          const users = (await userRepository.list()).map(publicUser);
          sendJson(response, 200, { users });
          return;
        }

        // POST /api/admin/users/:id/ban
        if (parts[2] === "users" && parts[4] === "ban" && request.method === "POST") {
          const targetUser = await userRepository.findById(parts[3]);
          if (!targetUser) { notFound(response); return; }
          if (targetUser.id === currentUser.id) {
            badRequest(response, "Нельзя заблокировать самого себя.");
            return;
          }
          const banned = banUser(targetUser, clock.now().toISOString());
          await userRepository.save(banned);
          sendJson(response, 200, { user: publicUser(banned) });
          return;
        }

        // POST /api/admin/users/:id/unban
        if (parts[2] === "users" && parts[4] === "unban" && request.method === "POST") {
          const targetUser = await userRepository.findById(parts[3]);
          if (!targetUser) { notFound(response); return; }
          const unbanned = unbanUser(targetUser, clock.now().toISOString());
          await userRepository.save(unbanned);
          sendJson(response, 200, { user: publicUser(unbanned) });
          return;
        }

        // PATCH /api/admin/users/:id/role
        if (parts[2] === "users" && parts[4] === "role" && request.method === "PATCH") {
          const targetUser = await userRepository.findById(parts[3]);
          if (!targetUser) { notFound(response); return; }
          const payload = await readJsonRequestBody(request);
          const newRole = payload.role;

          // Защита: нельзя разжаловать последнего админа
          if (targetUser.role === "admin" && newRole === "member") {
            const adminCount = await userRepository.countByRole("admin");
            if (adminCount <= 1) {
              badRequest(response, "Нельзя разжаловать последнего администратора.");
              return;
            }
          }

          const updated = setRole(targetUser, newRole, clock.now().toISOString());
          await userRepository.save(updated);
          sendJson(response, 200, { user: publicUser(updated) });
          return;
        }

        // PATCH /api/admin/users/:id/quota  — установить квоту (quota: null|number)
        if (parts[2] === "users" && parts[4] === "quota" && request.method === "PATCH") {
          const targetUser = await userRepository.findById(parts[3]);
          if (!targetUser) { notFound(response); return; }
          const payload = await readJsonRequestBody(request);
          // payload.quota: null = безлимит, целое число ≥ 0 = лимит
          const quota = payload.quota === null ? null : Number(payload.quota);
          if (quota !== null && (!Number.isInteger(quota) || quota < 0)) {
            badRequest(response, "quota должна быть целым числом ≥ 0 или null.");
            return;
          }
          const updated = setTranscriptionQuota(targetUser, quota, clock.now().toISOString());
          await userRepository.save(updated);
          sendJson(response, 200, { user: publicUser(updated) });
          return;
        }

        // POST /api/admin/users/:id/quota/reset  — сбросить счётчик использования
        if (parts[2] === "users" && parts[4] === "quota" && parts[5] === "reset"
            && request.method === "POST") {
          const targetUser = await userRepository.findById(parts[3]);
          if (!targetUser) { notFound(response); return; }
          const updated = resetTranscriptionUsed(targetUser, clock.now().toISOString());
          await userRepository.save(updated);
          sendJson(response, 200, { user: publicUser(updated) });
          return;
        }

        notFound(response);
        return;
      }

      // ── Стандартная валидация ID ──────────────────────────────────────────────
      const ID_REGEX = /^[a-zA-Z0-9_-]+$/;

      if (parts[0] === "api" && parts[1] === "projects" && parts.length > 2) {
        const projectId = parts[2];
        if (!ID_REGEX.test(projectId)) {
          badRequest(response, "Некорректный ID проекта.");
          return;
        }
      }

      if (parts[0] === "api" && parts[1] === "meetings" && parts.length > 2) {
        const meetingId = parts[2];
        if (!ID_REGEX.test(meetingId)) {
          badRequest(response, "Некорректный ID встречи.");
          return;
        }
      }

      if (parts[0] === "local-upload" && parts.length > 1) {
        const meetingId = parts[1];
        if (!ID_REGEX.test(meetingId)) {
          badRequest(response, "Некорректный ID встречи.");
          return;
        }
      }

      if (request.method === "GET" && url.pathname === "/") {
        if (!webRootDirectory) { notFound(response); return; }
        const html = await readFile(path.join(webRootDirectory, "index.html"), "utf8");
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8"
        });
        response.end(html);
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/app/")) {
        if (!webRootDirectory) { notFound(response); return; }
        const assetPath = path.resolve(webRootDirectory, `.${url.pathname}`);
        const appDirectory = path.resolve(webRootDirectory, "app");

        if (!assetPath.startsWith(appDirectory)) {
          notFound(response);
          return;
        }

        const content = await readFile(assetPath, "utf8");
        response.writeHead(200, {
          "content-type": getContentType(assetPath)
        });
        response.end(content);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/projects") {
        const allProjects = await projectRepository.list();
        // Администраторы видят всё; обычные пользователи — только свои проекты
        const projects = (currentUser && currentUser.role === "admin")
          ? allProjects
          : allProjects.filter((p) => !p.ownerId || p.ownerId === currentUser?.id);
        sendJson(response, 200, { projects });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/projects") {
        const payload = await readJsonRequestBody(request);
        const project = await createProject.execute({
          name: payload.name,
          members: payload.members ?? [],
          ownerId: currentUser?.id ?? null
        });
        sendJson(response, 201, { project });
        return;
      }

      if (
        parts[0] === "api" &&
        parts[1] === "projects" &&
        parts[3] === "team" &&
        request.method === "GET"
      ) {
        const members = await projectRepository.getTeam(parts[2]);
        sendJson(response, 200, {
          projectId: parts[2],
          members
        });
        return;
      }

      if (
        parts[0] === "api" &&
        parts[1] === "projects" &&
        parts[3] === "team" &&
        request.method === "PUT"
      ) {
        const payload = await readJsonRequestBody(request);
        const project = await updateProjectTeam.execute({
          projectId: parts[2],
          members: payload.members ?? []
        });
        sendJson(response, 200, { project });
        return;
      }

      if (
        parts[0] === "api" &&
        parts[1] === "projects" &&
        parts[3] === "meetings" &&
        request.method === "GET"
      ) {
        sendJson(response, 200, {
          meetings: await meetingRepository.listByProject(parts[2])
        });
        return;
      }

      if (
        parts[0] === "api" &&
        parts[1] === "projects" &&
        parts.length === 3 &&
        request.method === "PATCH"
      ) {
        const project = await projectRepository.getById(parts[2]);
        if (!project) {
          notFound(response);
          return;
        }

        const payload = await readJsonRequestBody(request);
        const updated = {
          ...project,
          name: payload.name ?? project.name,
          updatedAt: clock.now().toISOString()
        };
        await projectRepository.save(updated);
        sendJson(response, 200, { project: updated });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/meetings") {
        const payload = await readJsonRequestBody(request);

        if (!payload.projectId || !ID_REGEX.test(payload.projectId)) {
          badRequest(response, "Некорректный ID проекта.");
          return;
        }

        const ALLOWED_CONTENT_TYPES = [
          "audio/mpeg", "audio/mp3", "audio/mp4", "audio/m4a",
          "audio/x-m4a", "audio/wav", "audio/wave", "audio/ogg",
          "audio/webm", "audio/aac", "audio/flac", "audio/x-flac",
          "audio/opus", "application/octet-stream"
        ];
        const AUDIO_EXT = /\.(mp3|m4a|mp4|wav|ogg|webm|aac|flac|opus)$/i;
        const MAX_FILE_NAME_LEN = 255;

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

        const result = await createMeeting.execute({
          projectId: payload.projectId,
          date: payload.date,
          startTime: payload.startTime ?? null,
          endTime: payload.endTime ?? null,
          participantIds: payload.participantIds ?? [],
          guests: payload.guests ?? [],
          fileName: payload.fileName,
          contentType: payload.contentType
        });
        sendJson(response, 201, result);
        return;
      }

      if (parts[0] === "local-upload" && request.method === "PUT") {
        const meetingId = parts[1];
        const token = url.searchParams.get("token");
        if (!meetingId || !token) {
          badRequest(response, "Missing upload token.");
          return;
        }

        await artifactStorage.writeUpload(meetingId, token, request);
        sendJson(response, 200, { ok: true });
        return;
      }

      if (
        parts[0] === "api" &&
        parts[1] === "meetings" &&
        parts[3] === "upload-complete" &&
        request.method === "POST"
      ) {
        // Проверяем квоту расшифровок для текущего пользователя
        if (currentUser && sessionSecret) {
          const freshUser = await userRepository.findById(currentUser.id);
          if (freshUser) {
            const quotaCheck = checkTranscriptionQuota(freshUser);
            if (!quotaCheck.allowed) {
              response.writeHead(402, { "content-type": "application/json" });
              response.end(JSON.stringify({ error: quotaCheck.reason }));
              return;
            }
            // Инкрементируем счётчик сразу при постановке в обработку
            const withUsed = incrementTranscriptionUsed(freshUser, clock.now().toISOString());
            await userRepository.save(withUsed);
          }
        }

        const payload = await readJsonRequestBody(request);
        const meeting = await markUploadCompleted.execute({
          meetingId: parts[2],
          sizeBytes: payload.sizeBytes ?? 0,
          durationSeconds: payload.durationSeconds ?? null
        });
        pipelineService.enqueueProcessing(parts[2]);
        sendJson(response, 200, { meeting });
        return;
      }

      if (
        parts[0] === "api" &&
        parts[1] === "meetings" &&
        parts[3] === "confirm-draft" &&
        request.method === "POST"
      ) {
        const payload = await readJsonRequestBody(request);
        const meeting = await pipelineService.confirmDraft(parts[2], {
          titleDraft: payload.titleDraft,
          speakerDrafts: payload.speakerDrafts ?? []
        });
        sendJson(response, 200, { meeting });
        return;
      }

      if (
        parts[0] === "api" &&
        parts[1] === "meetings" &&
        parts.length === 3 &&
        request.method === "GET"
      ) {
        const meeting = await meetingRepository.getById(parts[2]);
        if (!meeting) {
          notFound(response);
          return;
        }

        sendJson(response, 200, { meeting });
        return;
      }

      if (
        parts[0] === "api" &&
        parts[1] === "meetings" &&
        parts[3] === "retry" &&
        request.method === "POST"
      ) {
        const meeting = await pipelineService.retry(parts[2]);
        sendJson(response, 200, { meeting });
        return;
      }

      // PATCH /api/meetings/:id/transcript — сохранить отредактированный текст расшифровки
      if (
        parts[0] === "api" &&
        parts[1] === "meetings" &&
        parts[3] === "transcript" &&
        request.method === "PATCH"
      ) {
        const meeting = await meetingRepository.getById(parts[2]);
        if (!meeting) { notFound(response); return; }

        const { rawText } = await readJsonRequestBody(request);
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
          updatedAt: clock.now().toISOString()
        };
        await meetingRepository.save(updatedMeeting);

        sendJson(response, 200, { ok: true, meeting: updatedMeeting });
        return;
      }

      // POST /api/meetings/:id/transcript/restore — вернуть исходную расшифровку из .raw.json
      if (
        parts[0] === "api" &&
        parts[1] === "meetings" &&
        parts[3] === "transcript" &&
        parts[4] === "restore" &&
        request.method === "POST"
      ) {
        const meeting = await meetingRepository.getById(parts[2]);
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
          updatedAt: clock.now().toISOString()
        };
        await meetingRepository.save(updated);
        sendJson(response, 200, { ok: true });
        return;
      }

      // PATCH /api/meetings/:id/protocol — сохранить отредактированный протокол (action items, дедлайны и т.п.)
      if (
        parts[0] === "api" &&
        parts[1] === "meetings" &&
        parts[3] === "protocol" &&
        request.method === "PATCH"
      ) {
        const meeting = await meetingRepository.getById(parts[2]);
        if (!meeting) { notFound(response); return; }

        const { protocol } = await readJsonRequestBody(request);
        if (!protocol || typeof protocol !== "object") {
          badRequest(response, "protocol обязателен.");
          return;
        }

        await artifactStorage.writeJson(meeting.artifacts.protocolJsonKey, protocol);

        const updated = { ...meeting, protocol, updatedAt: clock.now().toISOString() };
        await meetingRepository.save(updated);
        sendJson(response, 200, { ok: true });
        return;
      }

      // POST /api/meetings/:id/regenerate-protocol — пересобрать протокол из сохранённой расшифровки
      if (
        parts[0] === "api" &&
        parts[1] === "meetings" &&
        parts[3] === "regenerate-protocol" &&
        request.method === "POST"
      ) {
        const meeting = await meetingRepository.getById(parts[2]);
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
        pipelineService.enqueueProcessing(parts[2]);
        sendJson(response, 200, { meeting: updated });
        return;
      }

      if (
        parts[0] === "api" &&
        parts[1] === "meetings" &&
        parts[3] === "protocol.txt" &&
        request.method === "GET"
      ) {
        const meeting = await meetingRepository.getById(parts[2]);
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
        return;
      }

      if (
        parts[0] === "api" &&
        parts[1] === "meetings" &&
        parts[3] === "transcript.txt" &&
        request.method === "GET"
      ) {
        const meeting = await meetingRepository.getById(parts[2]);
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
        return;
      }

      if (
        parts[0] === "api" &&
        parts[1] === "projects" &&
        parts.length === 3 &&
        request.method === "DELETE"
      ) {
        await projectRepository.delete(parts[2]);
        sendJson(response, 200, { ok: true });
        return;
      }

      if (
        parts[0] === "api" &&
        parts[1] === "meetings" &&
        parts.length === 3 &&
        request.method === "DELETE"
      ) {
        await meetingRepository.delete(parts[2]);
        sendJson(response, 200, { ok: true });
        return;
      }

      notFound(response);
    } catch (error) {
      serverError(response, error);
    }
  };
}
