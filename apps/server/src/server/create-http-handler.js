/**
 * Композиционный корень HTTP-слоя.
 *
 * Раньше здесь жил весь роутинг одной цепочкой if-ов (809 строк).
 * Теперь: middleware-конвейер + табличный роутер, маршруты — в routes/*.
 *
 * Порядок обработки (сохранён из монолита):
 *   1. CORS + OPTIONS
 *   2. session-middleware для /api/* (кроме /api/auth/*)
 *   3. guard «только админ» для /api/admin/*
 *   4. валидация ID в путях projects/meetings/local-upload
 *   5. статика (/ и /app/*)
 *   6. диспатч по таблице маршрутов
 *   7. 404 / 500
 */
import { readJsonRequestBody, badRequest, notFound, sendJson, serverError } from "../shared/http.js";
import { UserError } from "../shared/http.js";
import { ID_REGEX } from "../shared/validate.js";
import { verifySessionToken, parseCookies } from "../shared/session.js";
import { Router } from "./router.js";
import { makeUseCases } from "./make-use-cases.js";
import { registerAuthRoutes } from "./routes/auth-routes.js";
import { registerAdminRoutes } from "./routes/admin-routes.js";
import { registerProjectRoutes } from "./routes/project-routes.js";
import { registerMeetingRoutes } from "./routes/meeting-routes.js";
import { serveStatic } from "./routes/static-routes.js";

// Максимальный размер JSON-тела. Правки длинных расшифровок занимают мегабайты,
// поэтому лимит щедрый, но конечный — защита от заведомо мусорных запросов.
const MAX_JSON_BODY_BYTES = 10 * 1024 * 1024;

async function readBody(request) {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (declared > MAX_JSON_BODY_BYTES) {
    throw new UserError("Тело запроса слишком большое.", 413, "PAYLOAD_TOO_LARGE");
  }
  try {
    return await readJsonRequestBody(request);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new UserError("Некорректный JSON в теле запроса.");
    }
    throw error;
  }
}

function splitPathname(pathname) {
  return pathname.split("/").filter(Boolean);
}

export function createHttpHandler(deps) {
  const {
    userRepository,
    webRootDirectory,
    sessionSecret
  } = deps;

  const useCases = makeUseCases(deps);

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

  const routeDeps = { ...deps, useCases, readBody, resolveCurrentUser };

  const router = new Router();
  registerAuthRoutes(router, routeDeps);
  registerAdminRoutes(router, routeDeps);
  registerProjectRoutes(router, routeDeps);
  registerMeetingRoutes(router, routeDeps);

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
      // ── Session middleware для всех /api/* кроме /api/auth/* ───────────────
      let currentUser = null;
      if (parts[0] === "api" && parts[1] !== "auth") {
        if (sessionSecret) {
          currentUser = await resolveCurrentUser(request);
          if (!currentUser) {
            sendJson(response, 401, { error: "Требуется авторизация." });
            return;
          }
        }
      }

      // ── Guard «только админ» для /api/admin/* ──────────────────────────────
      if (parts[0] === "api" && parts[1] === "admin") {
        if (!currentUser || currentUser.role !== "admin") {
          sendJson(response, 403, { error: "Доступ запрещён." });
          return;
        }
      }

      // ── Валидация ID в путях ────────────────────────────────────────────────
      if (parts[0] === "api" && parts[1] === "projects" && parts.length > 2
          && !ID_REGEX.test(parts[2])) {
        badRequest(response, "Некорректный ID проекта.");
        return;
      }
      if (parts[0] === "api" && parts[1] === "meetings" && parts.length > 2
          && !ID_REGEX.test(parts[2])) {
        badRequest(response, "Некорректный ID встречи.");
        return;
      }
      if (parts[0] === "local-upload" && parts.length > 1
          && !ID_REGEX.test(parts[1])) {
        badRequest(response, "Некорректный ID встречи.");
        return;
      }

      // ── Статика (/ и /app/*) ───────────────────────────────────────────────
      if (await serveStatic({ request, response, url, webRootDirectory })) {
        return;
      }

      // ── Диспатч по таблице маршрутов ───────────────────────────────────────
      const match = router.match(request.method, parts);
      if (match) {
        await match.handler({
          request,
          response,
          url,
          params: match.params,
          currentUser
        });
        return;
      }

      notFound(response);
    } catch (error) {
      serverError(response, error);
    }
  };
}
