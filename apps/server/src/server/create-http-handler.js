import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  CreateMeetingUseCase,
  CreateProjectUseCase,
  MarkUploadCompletedUseCase,
  UpdateProjectTeamUseCase
} from "../../../../packages/core/src/index.js";
import {
  badRequest,
  notFound,
  readJsonRequestBody,
  sendJson,
  sendText,
  serverError
} from "../shared/http.js";

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
  artifactStorage,
  pipelineService,
  clock,
  idGenerator,
  webRootDirectory,
  apiKey
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

    // API key protection — только для /api/* маршрутов
    if (apiKey && parts[0] === "api" && request.headers["x-api-key"] !== apiKey) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    try {
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
        sendJson(response, 200, { projects: await projectRepository.list() });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/projects") {
        const payload = await readJsonRequestBody(request);
        const project = await createProject.execute({
          name: payload.name,
          members: payload.members ?? []
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
