/**
 * Характеризационные тесты auth + admin маршрутов.
 *
 * Написаны ДО рефакторинга роутера и фиксируют текущее поведение:
 * статусы, форматы ошибок, выставление cookie, защиту последнего админа.
 * Любое расхождение после рефакторинга = регрессия.
 */

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createTestServer } from "../src/test-server.js";
import { createUser } from "../../../packages/core/src/domain/user.js";
import { hashPassword } from "../src/shared/password.js";
import { resetRateLimits } from "../src/shared/rate-limit.js";

const SESSION_SECRET = "test-secret-for-auth-tests";
const ADMIN_LOGIN = "boss";

// Продовый admin создаётся через scripts/seed-admin.js напрямую в хранилище,
// а не через POST /api/auth/register (тот путь зарезервированный логин
// отклоняет — см. register-user-use-case.js). Тесты воспроизводят тот же
// прямой путь через userRepository, а не публичный API.
async function seedAdmin(server, login, password) {
  const user = createUser({
    id: crypto.randomUUID(),
    login: login.toLowerCase().trim(),
    passwordHash: await hashPassword(password),
    role: "admin",
    createdAt: new Date().toISOString()
  });
  await server.repositories.userRepository.save(user);
  return user;
}

async function withAuthServer(run) {
  resetRateLimits();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "yaspeech-auth-"));
  const server = await createTestServer({
    dataDir,
    sessionSecret: SESSION_SECRET,
    adminLogin: ADMIN_LOGIN
  });

  try {
    await server.start();
    await run(server);
  } finally {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

/** fetch с ручным cookie-jar: возвращает { response, body, cookie } */
async function call(server, pathname, { cookie, ...init } = {}) {
  const response = await fetch(`${server.baseUrl}${pathname}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {})
    }
  });

  const setCookie = response.headers.get("set-cookie");
  const sessionCookie = setCookie ? setCookie.split(";")[0] : null;

  let body = null;
  try {
    body = await response.json();
  } catch {}

  return { response, body, cookie: sessionCookie };
}

function register(server, login, password) {
  return call(server, "/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ login, password })
  });
}

function login(server, loginName, password) {
  return call(server, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ login: loginName, password })
  });
}

test("register: админ-логин зарезервирован (400), обычный — member, дубль — 400", async () => {
  await withAuthServer(async (server) => {
    // ADMIN_LOGIN создаётся только через seed-admin.js, не через публичную
    // регистрацию — иначе пропуск сида отдаёт роль admin первому встречному.
    const reservedAttempt = await register(server, ADMIN_LOGIN, "secret123");
    assert.equal(reservedAttempt.response.status, 400);

    const member = await register(server, "worker", "secret123");
    assert.equal(member.response.status, 201);
    assert.equal(member.body.user.role, "member");

    const dup = await register(server, "worker", "secret456");
    assert.equal(dup.response.status, 400);

    const shortLogin = await register(server, "ab", "secret123");
    assert.equal(shortLogin.response.status, 400);

    const shortPass = await register(server, "valid-user", "12345");
    assert.equal(shortPass.response.status, 400);
  });
});

test("login: верный пароль 200 + cookie, неверный 401, бан 403", async () => {
  await withAuthServer(async (server) => {
    await seedAdmin(server, ADMIN_LOGIN, "secret123");
    await register(server, "victim", "secret123");

    const ok = await login(server, "victim", "secret123");
    assert.equal(ok.response.status, 200);
    assert.ok(ok.cookie?.startsWith("session="));

    const wrong = await login(server, "victim", "wrong-password");
    assert.equal(wrong.response.status, 401);

    const ghost = await login(server, "no-such-user", "whatever");
    assert.equal(ghost.response.status, 401);

    // Баним и проверяем 403 при логине
    const adminSession = (await login(server, ADMIN_LOGIN, "secret123")).cookie;
    const { body: usersBody } = await call(server, "/api/admin/users", { cookie: adminSession });
    const victim = usersBody.users.find((u) => u.login === "victim");
    await call(server, `/api/admin/users/${victim.id}/ban`, {
      method: "POST",
      cookie: adminSession,
      body: JSON.stringify({})
    });

    const banned = await login(server, "victim", "secret123");
    assert.equal(banned.response.status, 403);
  });
});

test("me + session middleware: без cookie 401, с cookie 200, logout очищает", async () => {
  await withAuthServer(async (server) => {
    const noAuth = await call(server, "/api/auth/me");
    assert.equal(noAuth.response.status, 401);

    const noProjects = await call(server, "/api/projects");
    assert.equal(noProjects.response.status, 401, "/api/* без сессии закрыт");

    const reg = await register(server, "someone", "secret123");
    const me = await call(server, "/api/auth/me", { cookie: reg.cookie });
    assert.equal(me.response.status, 200);
    assert.equal(me.body.user.login, "someone");

    const projects = await call(server, "/api/projects", { cookie: reg.cookie });
    assert.equal(projects.response.status, 200);

    const out = await call(server, "/api/auth/logout", {
      method: "POST",
      cookie: reg.cookie,
      body: JSON.stringify({})
    });
    assert.equal(out.response.status, 200);
    assert.match(out.cookie ?? "", /^session=;?$/, "cookie сброшена");
  });
});

test("admin: member получает 403, ban/unban/role/quota работают, последний админ защищён", async () => {
  await withAuthServer(async (server) => {
    await seedAdmin(server, ADMIN_LOGIN, "secret123");
    const admin = await login(server, ADMIN_LOGIN, "secret123");
    const member = await register(server, "pleb", "secret123");

    // member не админ
    const forbidden = await call(server, "/api/admin/users", { cookie: member.cookie });
    assert.equal(forbidden.response.status, 403);

    // список пользователей
    const list = await call(server, "/api/admin/users", { cookie: admin.cookie });
    assert.equal(list.response.status, 200);
    assert.equal(list.body.users.length, 2);
    const plebId = list.body.users.find((u) => u.login === "pleb").id;
    const adminId = list.body.users.find((u) => u.login === ADMIN_LOGIN).id;

    // нельзя забанить себя
    const selfBan = await call(server, `/api/admin/users/${adminId}/ban`, {
      method: "POST", cookie: admin.cookie, body: JSON.stringify({})
    });
    assert.equal(selfBan.response.status, 400);

    // ban → status=banned, его сессия умирает; unban возвращает
    const ban = await call(server, `/api/admin/users/${plebId}/ban`, {
      method: "POST", cookie: admin.cookie, body: JSON.stringify({})
    });
    assert.equal(ban.response.status, 200);
    assert.equal(ban.body.user.status, "banned");

    const bannedMe = await call(server, "/api/auth/me", { cookie: member.cookie });
    assert.equal(bannedMe.response.status, 401, "сессия забаненного не работает");

    const unban = await call(server, `/api/admin/users/${plebId}/unban`, {
      method: "POST", cookie: admin.cookie, body: JSON.stringify({})
    });
    assert.equal(unban.body.user.status, "active");

    // роль: member → admin → member
    const promote = await call(server, `/api/admin/users/${plebId}/role`, {
      method: "PATCH", cookie: admin.cookie, body: JSON.stringify({ role: "admin" })
    });
    assert.equal(promote.body.user.role, "admin");

    const demote = await call(server, `/api/admin/users/${plebId}/role`, {
      method: "PATCH", cookie: admin.cookie, body: JSON.stringify({ role: "member" })
    });
    assert.equal(demote.body.user.role, "member");

    // последний админ защищён от разжалования
    const lastAdmin = await call(server, `/api/admin/users/${adminId}/role`, {
      method: "PATCH", cookie: admin.cookie, body: JSON.stringify({ role: "member" })
    });
    assert.equal(lastAdmin.response.status, 400);

    // квота: установить, исчерпание видно через checkTranscriptionQuota — здесь только API-контракт
    const setQuota = await call(server, `/api/admin/users/${plebId}/quota`, {
      method: "PATCH", cookie: admin.cookie, body: JSON.stringify({ quota: 5 })
    });
    assert.equal(setQuota.body.user.transcriptionQuota, 5);

    const badQuota = await call(server, `/api/admin/users/${plebId}/quota`, {
      method: "PATCH", cookie: admin.cookie, body: JSON.stringify({ quota: -1 })
    });
    assert.equal(badQuota.response.status, 400);

    const resetQuota = await call(server, `/api/admin/users/${plebId}/quota/reset`, {
      method: "POST", cookie: admin.cookie, body: JSON.stringify({})
    });
    assert.equal(resetQuota.body.user.transcriptionUsed, 0);

    // неизвестный admin-маршрут → 404
    const unknown = await call(server, "/api/admin/nonsense", { cookie: admin.cookie });
    assert.equal(unknown.response.status, 404);
  });
});

test("без sessionSecret auth выключен: /api/projects открыт (локальный dev-режим)", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "yaspeech-noauth-"));
  const server = await createTestServer({ dataDir });
  try {
    await server.start();
    const open = await call(server, "/api/projects");
    assert.equal(open.response.status, 200, "auth off → доступ без cookie");

    const me = await call(server, "/api/auth/me");
    assert.equal(me.response.status, 401, "me всё равно 401 — фронт покажет логин");
  } finally {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
