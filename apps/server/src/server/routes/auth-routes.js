/**
 * Auth-маршруты: register / login / logout / me.
 * Работают БЕЗ session-middleware (доступны неавторизованным).
 */
import { publicUser } from "../../../../../packages/core/src/index.js";
import { badRequest, sendJson } from "../../shared/http.js";
import { requireString } from "../../shared/validate.js";
import {
  createSessionToken,
  setSessionCookie,
  clearSessionCookie
} from "../../shared/session.js";

export function registerAuthRoutes(router, deps) {
  const { useCases, sessionSecret, readBody, resolveCurrentUser } = deps;

  router.add("POST", "/api/auth/register", async ({ request, response }) => {
    const payload = await readBody(request);
    const login = requireString(payload.login ?? "", "login", { max: 128, allowEmpty: true });
    const password = requireString(payload.password ?? "", "password", { max: 1024, allowEmpty: true });

    let user;
    try {
      user = await useCases.registerUser.execute({ login, password });
    } catch (e) {
      badRequest(response, e.message);
      return;
    }
    if (sessionSecret) {
      setSessionCookie(response, createSessionToken(user.id, sessionSecret));
    }
    sendJson(response, 201, { user });
  });

  router.add("POST", "/api/auth/login", async ({ request, response }) => {
    const payload = await readBody(request);
    const login = requireString(payload.login ?? "", "login", { max: 128, allowEmpty: true });
    const password = requireString(payload.password ?? "", "password", { max: 1024, allowEmpty: true });

    let user;
    try {
      user = await useCases.loginUser.execute({ login, password });
    } catch (e) {
      // 401 для неверных данных, 403 для бана — как в исходном монолите
      const status = e.message.includes("заблокирован") ? 403 : 401;
      sendJson(response, status, { error: e.message });
      return;
    }
    if (sessionSecret) {
      setSessionCookie(response, createSessionToken(user.id, sessionSecret));
    }
    sendJson(response, 200, { user });
  });

  router.add("POST", "/api/auth/logout", async ({ response }) => {
    clearSessionCookie(response);
    sendJson(response, 200, { ok: true });
  });

  router.add("GET", "/api/auth/me", async ({ request, response }) => {
    const currentUser = await resolveCurrentUser(request);
    if (!currentUser) {
      sendJson(response, 401, { error: "Не авторизован." });
      return;
    }
    sendJson(response, 200, { user: publicUser(currentUser) });
  });
}
