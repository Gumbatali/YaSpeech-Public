/**
 * Маршруты проектов: CRUD, команда, список встреч проекта.
 */
import { notFound, sendJson } from "../../shared/http.js";
import { optionalString, requireArray, requireString } from "../../shared/validate.js";
import { assertProjectAccess } from "../../shared/authorize.js";
import {
  isUploadStalled,
  isProcessingStalled,
  markUploadStalled,
  markProcessingStalled
} from "../../../../../packages/core/src/domain/meeting.js";

export function registerProjectRoutes(router, deps) {
  const { projectRepository, meetingRepository, clock, useCases, readBody } = deps;

  router.add("GET", "/api/projects", async ({ response, currentUser }) => {
    const allProjects = await projectRepository.list();
    // Администраторы видят всё; обычные пользователи — только свои проекты
    const projects = (currentUser && currentUser.role === "admin")
      ? allProjects
      : allProjects.filter((p) => !p.ownerId || p.ownerId === currentUser?.id);
    sendJson(response, 200, { projects });
  });

  router.add("POST", "/api/projects", async ({ request, response, currentUser }) => {
    const payload = await readBody(request);
    const name = requireString(payload.name, "name", { max: 200 });
    const members = requireArray(payload.members ?? [], "members", { max: 100 });

    const project = await useCases.createProject.execute({
      name,
      members,
      ownerId: currentUser?.id ?? null
    });
    sendJson(response, 201, { project });
  });

  router.add("GET", "/api/projects/:id/team", async ({ response, params, currentUser }) => {
    const project = await projectRepository.getById(params.id);
    if (!assertProjectAccess(project, currentUser, response, notFound)) return;

    const members = await projectRepository.getTeam(params.id);
    sendJson(response, 200, { projectId: params.id, members });
  });

  router.add("PUT", "/api/projects/:id/team", async ({ request, response, params, currentUser }) => {
    const project = await projectRepository.getById(params.id);
    if (!assertProjectAccess(project, currentUser, response, notFound)) return;

    const payload = await readBody(request);
    const members = requireArray(payload.members ?? [], "members", { max: 100 });

    const updated = await useCases.updateProjectTeam.execute({
      projectId: params.id,
      members
    });
    sendJson(response, 200, { project: updated });
  });

  router.add("GET", "/api/projects/:id/meetings", async ({ response, params, currentUser }) => {
    const project = await projectRepository.getById(params.id);
    if (!assertProjectAccess(project, currentUser, response, notFound)) return;

    const meetings = await meetingRepository.listByProject(params.id);

    // Зависания лечим прямо на чтении списка: иначе встреча вечно висит
    // «Загружаем файл…» (брошенная загрузка) или «Готовим текст…» (мёртвая
    // очередь / упавший worker), хотя обновлений давно нет.
    const isStalled = (m, nowIso) => isUploadStalled(m, nowIso) || isProcessingStalled(m, nowIso);
    const markStalled = (m, nowIso) =>
      isUploadStalled(m, nowIso) ? markUploadStalled(m, nowIso) : markProcessingStalled(m, nowIso);

    const healed = await Promise.all(
      meetings.map(async (entry) => {
        const nowIso = clock.now().toISOString();
        if (!isStalled(entry, nowIso)) {
          return entry;
        }
        const full = await meetingRepository.getById(entry.id);
        if (!full || !isStalled(full, nowIso)) {
          return entry;
        }
        const stalled = markStalled(full, nowIso);
        await meetingRepository.save(stalled);
        return { ...entry, status: stalled.status, updatedAt: stalled.updatedAt };
      })
    );

    sendJson(response, 200, { meetings: healed });
  });

  router.add("PATCH", "/api/projects/:id", async ({ request, response, params, currentUser }) => {
    const project = await projectRepository.getById(params.id);
    if (!assertProjectAccess(project, currentUser, response, notFound)) return;

    const payload = await readBody(request);
    const name = optionalString(payload.name, "name", { max: 200 });
    const updated = {
      ...project,
      name: name || project.name,
      updatedAt: clock.now().toISOString()
    };
    await projectRepository.save(updated);
    sendJson(response, 200, { project: updated });
  });

  router.add("DELETE", "/api/projects/:id", async ({ response, params, currentUser }) => {
    const project = await projectRepository.getById(params.id);
    if (!assertProjectAccess(project, currentUser, response, notFound)) return;

    await projectRepository.delete(params.id);
    sendJson(response, 200, { ok: true });
  });
}
