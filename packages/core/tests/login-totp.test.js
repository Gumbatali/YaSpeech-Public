/**
 * Логин со вторым фактором (TOTP) — поведение LoginUserUseCase.
 * Используем настоящий scrypt и настоящий TOTP, фейкаем только хранилище.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { LoginUserUseCase } from "../src/application/register-user-use-case.js";
import { createUser, enableTotp } from "../src/domain/user.js";
import { hashPassword, verifyPassword } from "../../../apps/server/src/shared/password.js";
import {
  generateTotpSecret,
  generateBackupCodes,
  totpNow
} from "../../../apps/server/src/shared/totp.js";
import { verifyTotp } from "../../../apps/server/src/shared/totp.js";

const clock = { now: () => new Date("2026-06-19T00:00:00Z") };

function makeRepo(users) {
  return {
    users,
    async findByLogin(login) {
      return users.find((u) => u.login === login.toLowerCase().trim()) ?? null;
    },
    async findById(id) {
      return users.find((u) => u.id === id) ?? null;
    },
    async save(user) {
      const i = users.findIndex((u) => u.id === user.id);
      if (i >= 0) users[i] = user;
      else users.push(user);
    }
  };
}

function makeUseCase(users) {
  const repo = makeRepo(users);
  const passwordVerifier = { verify: (p, h) => verifyPassword(p, h) };
  const totpVerifier = { verify: (s, c) => verifyTotp(s, c) };
  return {
    repo,
    useCase: new LoginUserUseCase(repo, passwordVerifier, totpVerifier, passwordVerifier, clock)
  };
}

async function makeAdminWithTotp({ secret, backupCodes = [] }) {
  const base = createUser({
    id: "u1",
    login: "admin_stroytech",
    passwordHash: await hashPassword("correct horse"),
    role: "admin",
    createdAt: clock.now().toISOString()
  });
  const backupCodeHashes = [];
  for (const c of backupCodes) backupCodeHashes.push(await hashPassword(c));
  return enableTotp(base, { secret, backupCodeHashes }, clock.now().toISOString());
}

test("обычный пользователь без 2FA входит без кода", async () => {
  const user = createUser({
    id: "m1",
    login: "worker",
    passwordHash: await hashPassword("password1"),
    createdAt: clock.now().toISOString()
  });
  const { useCase } = makeUseCase([user]);
  const result = await useCase.execute({ login: "worker", password: "password1" });
  assert.equal(result.login, "worker");
  assert.equal(result.totpEnabled, false);
});

test("админ с 2FA без кода → TOTP_REQUIRED", async () => {
  const admin = await makeAdminWithTotp({ secret: generateTotpSecret() });
  const { useCase } = makeUseCase([admin]);
  await assert.rejects(
    () => useCase.execute({ login: "admin_stroytech", password: "correct horse" }),
    (e) => e.code === "TOTP_REQUIRED"
  );
});

test("админ с 2FA: верный код → вход", async () => {
  const secret = generateTotpSecret();
  const admin = await makeAdminWithTotp({ secret });
  const { useCase } = makeUseCase([admin]);
  const code = totpNow(secret);
  const result = await useCase.execute({
    login: "admin_stroytech",
    password: "correct horse",
    totpCode: code
  });
  assert.equal(result.role, "admin");
  assert.equal(result.totpEnabled, true);
  assert.equal(result.totp, undefined, "секрет TOTP не должен утекать клиенту");
});

test("админ с 2FA: неверный код → TOTP_INVALID", async () => {
  const admin = await makeAdminWithTotp({ secret: generateTotpSecret() });
  const { useCase } = makeUseCase([admin]);
  await assert.rejects(
    () =>
      useCase.execute({
        login: "admin_stroytech",
        password: "correct horse",
        totpCode: "000000"
      }),
    (e) => e.code === "TOTP_INVALID"
  );
});

test("верный пароль + неверный пароль не путаются с TOTP", async () => {
  const admin = await makeAdminWithTotp({ secret: generateTotpSecret() });
  const { useCase } = makeUseCase([admin]);
  await assert.rejects(
    () => useCase.execute({ login: "admin_stroytech", password: "wrong", totpCode: "123456" }),
    (e) => e.code === "INVALID_CREDENTIALS"
  );
});

test("код восстановления работает один раз и гасится", async () => {
  const secret = generateTotpSecret();
  const [backupCode] = generateBackupCodes(1);
  const admin = await makeAdminWithTotp({ secret, backupCodes: [backupCode] });
  const { useCase, repo } = makeUseCase([admin]);

  const ok = await useCase.execute({
    login: "admin_stroytech",
    password: "correct horse",
    totpCode: backupCode
  });
  assert.equal(ok.role, "admin");

  // Повторное использование того же кода — уже невалидно
  await assert.rejects(
    () =>
      useCase.execute({
        login: "admin_stroytech",
        password: "correct horse",
        totpCode: backupCode
      }),
    (e) => e.code === "TOTP_INVALID"
  );
  assert.equal(repo.users[0].totp.backupCodes.length, 0, "код восстановления должен быть погашен");
});
