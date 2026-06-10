/**
 * Админ-маршруты: пользователи, роли, баны, квоты.
 * Guard «только админ» применяется в create-http-handler ДО диспатча,
 * поэтому здесь currentUser гарантированно admin.
 */
import { publicUser } from "../../../../../packages/core/src/index.js";
import {
  banUser,
  unbanUser,
  setRole,
  setTranscriptionQuota,
  resetTranscriptionUsed
} from "../../../../../packages/core/src/domain/user.js";
import { badRequest, notFound, sendJson } from "../../shared/http.js";

export function registerAdminRoutes(router, deps) {
  const { userRepository, clock, readBody } = deps;

  async function findTarget(params, response) {
    const target = await userRepository.findById(params.id);
    if (!target) notFound(response);
    return target;
  }

  router.add("GET", "/api/admin/users", async ({ response }) => {
    const users = (await userRepository.list()).map(publicUser);
    sendJson(response, 200, { users });
  });

  router.add("POST", "/api/admin/users/:id/ban", async ({ response, params, currentUser }) => {
    const target = await findTarget(params, response);
    if (!target) return;
    if (target.id === currentUser.id) {
      badRequest(response, "Нельзя заблокировать самого себя.");
      return;
    }
    const banned = banUser(target, clock.now().toISOString());
    await userRepository.save(banned);
    sendJson(response, 200, { user: publicUser(banned) });
  });

  router.add("POST", "/api/admin/users/:id/unban", async ({ response, params }) => {
    const target = await findTarget(params, response);
    if (!target) return;
    const unbanned = unbanUser(target, clock.now().toISOString());
    await userRepository.save(unbanned);
    sendJson(response, 200, { user: publicUser(unbanned) });
  });

  router.add("PATCH", "/api/admin/users/:id/role", async ({ request, response, params }) => {
    const target = await findTarget(params, response);
    if (!target) return;
    const payload = await readBody(request);
    const newRole = payload.role;

    // Защита: нельзя разжаловать последнего админа
    if (target.role === "admin" && newRole === "member") {
      const adminCount = await userRepository.countByRole("admin");
      if (adminCount <= 1) {
        badRequest(response, "Нельзя разжаловать последнего администратора.");
        return;
      }
    }

    const updated = setRole(target, newRole, clock.now().toISOString());
    await userRepository.save(updated);
    sendJson(response, 200, { user: publicUser(updated) });
  });

  router.add("PATCH", "/api/admin/users/:id/quota", async ({ request, response, params }) => {
    const target = await findTarget(params, response);
    if (!target) return;
    const payload = await readBody(request);
    // payload.quota: null = безлимит, целое число ≥ 0 = лимит
    const quota = payload.quota === null ? null : Number(payload.quota);
    if (quota !== null && (!Number.isInteger(quota) || quota < 0)) {
      badRequest(response, "quota должна быть целым числом ≥ 0 или null.");
      return;
    }
    const updated = setTranscriptionQuota(target, quota, clock.now().toISOString());
    await userRepository.save(updated);
    sendJson(response, 200, { user: publicUser(updated) });
  });

  router.add("POST", "/api/admin/users/:id/quota/reset", async ({ response, params }) => {
    const target = await findTarget(params, response);
    if (!target) return;
    const updated = resetTranscriptionUsed(target, clock.now().toISOString());
    await userRepository.save(updated);
    sendJson(response, 200, { user: publicUser(updated) });
  });
}
