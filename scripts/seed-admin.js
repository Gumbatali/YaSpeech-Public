/**
 * Создаёт или сбрасывает администратора продукта в Object Storage и
 * включает ему двухфакторную аутентификацию (TOTP).
 *
 * Запуск: node scripts/seed-admin.js
 *
 * Читает из окружения (или scripts/.env.deploy):
 *   KEY_ID, SECRET, BUCKET, ADMIN_LOGIN, ADMIN_PASSWORD
 *
 * Каждый запуск выдаёт НОВЫЙ TOTP-секрет и НОВЫЕ коды восстановления —
 * это и есть штатный сброс второго фактора (например, при потере телефона).
 */
import { createHmac, createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

import { createUser, enableTotp } from "../packages/core/src/domain/user.js";
import { hashPassword } from "../apps/server/src/shared/password.js";
import {
  generateTotpSecret,
  generateBackupCodes,
  otpauthUri
} from "../apps/server/src/shared/totp.js";

// ── Загрузить .env.deploy, если переменных нет в окружении ──────────────────
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = path.join(ROOT, "scripts", ".env.deploy");
if (fs.existsSync(ENV_FILE) && !process.env.KEY_ID) {
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}

const ENDPOINT = "https://storage.yandexcloud.net";
const REGION   = "ru-central1";
const BUCKET   = process.env.BUCKET;
const KEY_ID   = process.env.KEY_ID;
const SECRET   = process.env.SECRET;
const LOGIN    = process.env.ADMIN_LOGIN;
const PASSWORD = process.env.ADMIN_PASSWORD;

// Ключ, который реально читает приложение (YcUserRepository → users/index.json)
const USERS_KEY = "users/index.json";

for (const [k, v] of Object.entries({ BUCKET, KEY_ID, SECRET, ADMIN_LOGIN: LOGIN, ADMIN_PASSWORD: PASSWORD })) {
  if (!v) { console.error(`❌  Переменная ${k} не задана`); process.exit(1); }
}

// ── AWS4-подпись для Yandex Object Storage ──────────────────────────────────
function sign(key, msg) { return createHmac("sha256", key).update(msg).digest(); }
function signingKey(secret, date, region, service) {
  return sign(sign(sign(sign("AWS4" + secret, date), region), service), "aws4_request");
}

async function s3(method, key, body = null) {
  const now       = new Date();
  const amzDate   = now.toISOString().replace(/[:-]|\.\d{3}/g, "").slice(0, 15) + "Z";
  const dateStamp = amzDate.slice(0, 8);
  const host      = "storage.yandexcloud.net";
  const path_     = `/${BUCKET}/${key}`;
  const payload   = body ?? "";
  const payloadHash = createHash("sha256").update(payload).digest("hex");

  const hdrs = {
    "content-type":          body !== null ? "application/json" : "application/octet-stream",
    "host":                  host,
    "x-amz-content-sha256":  payloadHash,
    "x-amz-date":            amzDate
  };
  const sortedKeys    = Object.keys(hdrs).sort();
  const signedHeaders = sortedKeys.join(";");
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${hdrs[k]}`).join("\n") + "\n";

  const canonicalRequest = [method, path_, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/${REGION}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope,
    createHash("sha256").update(canonicalRequest).digest("hex")].join("\n");
  const sig = createHmac("sha256", signingKey(SECRET, dateStamp, REGION, "s3"))
    .update(stringToSign).digest("hex");

  return fetch(`${ENDPOINT}${path_}`, {
    method,
    headers: {
      ...hdrs,
      Authorization: `AWS4-HMAC-SHA256 Credential=${KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`
    },
    ...(body !== null ? { body: payload } : {})
  });
}

// ── Вывод секрета для аутентификатора ───────────────────────────────────────
function printEnrollment(secret, uri, backupCodes) {
  const grouped = secret.replace(/(.{4})/g, "$1 ").trim();

  console.log("\n┌──────────────────────────────────────────────────────────────┐");
  console.log("│  ВТОРОЙ ФАКТОР (2FA) — настройте приложение-аутентификатор    │");
  console.log("└──────────────────────────────────────────────────────────────┘\n");

  // QR прямо в терминале, если установлен qrencode (brew install qrencode)
  try {
    const qr = execFileSync("qrencode", ["-t", "ANSIUTF8", uri], { encoding: "utf8" });
    console.log("Отсканируйте QR в Google Authenticator / 1Password / Authy:\n");
    console.log(qr);
  } catch {
    console.log("Добавьте аккаунт вручную (Google Authenticator → «Ввести ключ настройки»):\n");
  }

  console.log(`  Ключ (secret):  ${grouped}`);
  console.log(`  Или ссылка:     ${uri}\n`);
  console.log("Коды восстановления (одноразовые, на случай потери телефона —");
  console.log("сохраните в надёжном месте, второй раз показаны не будут):\n");
  for (const c of backupCodes) console.log(`    ${c}`);
  console.log("");
}

// ── Основная логика ─────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🔑  Настраиваю администратора «${LOGIN}» в бакете ${BUCKET}…`);

  let users = [];
  const getRes = await s3("GET", USERS_KEY);
  if (getRes.ok) {
    users = JSON.parse(await getRes.text());
    console.log(`📂  В ${USERS_KEY} найдено пользователей: ${users.length}`);
  } else if (getRes.status === 404) {
    console.log(`📂  ${USERS_KEY} ещё нет — создаю новый индекс`);
  } else {
    console.error(`❌  Ошибка чтения ${USERS_KEY}: ${getRes.status} ${await getRes.text()}`);
    process.exit(1);
  }

  const now = new Date().toISOString();
  const passwordHash = await hashPassword(PASSWORD);

  // Свежий TOTP-секрет и коды восстановления при каждом запуске
  const secret = generateTotpSecret();
  const backupCodes = generateBackupCodes(10);
  const backupCodeHashes = [];
  for (const c of backupCodes) backupCodeHashes.push(await hashPassword(c));

  const existing = users.find((u) => u.login?.toLowerCase() === LOGIN.toLowerCase());
  const base = existing
    ? { ...existing, passwordHash, role: "admin", status: "active", updatedAt: now }
    : createUser({ id: randomUUID(), login: LOGIN, passwordHash, role: "admin", createdAt: now });

  const admin = enableTotp(base, { secret, backupCodeHashes }, now);

  const nextUsers = existing
    ? users.map((u) => (u.id === admin.id ? admin : u))
    : [...users, admin];

  const putRes = await s3("PUT", USERS_KEY, JSON.stringify(nextUsers, null, 2));
  if (!putRes.ok) {
    console.error(`❌  Ошибка записи ${USERS_KEY}: ${putRes.status} ${await putRes.text()}`);
    process.exit(1);
  }
  console.log(existing
    ? `♻️   Пароль и второй фактор обновлены`
    : `✅  Администратор создан с ролью admin`);

  const uri = otpauthUri(secret, { account: LOGIN, issuer: "YaSpeech" });
  printEnrollment(secret, uri, backupCodes);

  console.log(`🎉  Готово. Вход: логин «${LOGIN}», пароль из ADMIN_PASSWORD, затем код из приложения.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
