/**
 * Миграция: добавить ownerId в projects/index.json
 *
 * Проблема: при сохранении проекта ownerId не писался в индекс,
 * из-за чего фильтр `!p.ownerId` всегда пропускал все проекты всем пользователям.
 *
 * Что делает скрипт:
 * 1. Читает projects/index.json
 * 2. Для каждого проекта без ownerId загружает projects/{id}/project.json
 * 3. Перезаписывает индекс с полем ownerId
 *
 * Запуск (dry-run по умолчанию):
 *   node scripts/migrate-project-owner-index.js
 *
 * Применить изменения:
 *   node scripts/migrate-project-owner-index.js --apply
 */

import { createHmac, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DRY_RUN = !process.argv.includes("--apply");
const REGION = "ru-central1";
const HOST = "storage.yandexcloud.net";

// Загружаем секреты из scripts/.env.deploy
const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), ".env.deploy");
const env = Object.fromEntries(
  readFileSync(envPath, "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split("=").map((p) => p.trim()))
    .filter(([k]) => k)
    .map(([k, ...rest]) => [k, rest.join("=")])
);

const BUCKET = env.BUCKET;
const KEY_ID = env.KEY_ID;
const SECRET = env.SECRET;

if (!BUCKET || !KEY_ID || !SECRET) {
  console.error("Не найдены переменные BUCKET / KEY_ID / SECRET в scripts/.env.deploy");
  process.exit(1);
}

// ── AWS Signature V4 (минимальная реализация для GET/PUT) ────────

function sha256hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key, data) {
  return createHmac("sha256", key).update(data).digest();
}

function signingKey(secret, dateStr, region, service) {
  const kDate = hmacSha256("AWS4" + secret, dateStr);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}

function s3Request(method, key, body = null) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "").slice(0, 15) + "Z";
  const dateStr = amzDate.slice(0, 8);
  const bodyHash = sha256hex(body ?? "");
  const path_ = `/${BUCKET}/${key}`;

  const headers = {
    host: HOST,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": bodyHash,
    ...(body !== null ? { "content-type": "application/json" } : {}),
  };

  const sortedHeaders = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaders.map((h) => `${h}:${headers[h]}`).join("\n") + "\n";
  const signedHeaders = sortedHeaders.join(";");

  const canonicalRequest = [
    method,
    path_,
    "",
    canonicalHeaders,
    signedHeaders,
    bodyHash,
  ].join("\n");

  const credentialScope = `${dateStr}/${REGION}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256hex(canonicalRequest),
  ].join("\n");

  const signature = hmacSha256(signingKey(SECRET, dateStr, REGION, "s3"), stringToSign)
    .toString("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${KEY_ID}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const url = `https://${HOST}${path_}`;
  return { url, headers: { ...headers, authorization } };
}

async function s3Get(key) {
  const { url, headers } = s3Request("GET", key);
  const res = await fetch(url, { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${key} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function s3Put(key, data) {
  const body = JSON.stringify(data, null, 2);
  const { url, headers } = s3Request("PUT", key, body);
  const res = await fetch(url, { method: "PUT", headers, body });
  if (!res.ok) throw new Error(`PUT ${key} → ${res.status}: ${await res.text()}`);
}

// ── Миграция ─────────────────────────────────────────────────────

async function main() {
  console.log(`Режим: ${DRY_RUN ? "DRY-RUN (без изменений)" : "APPLY"}`);
  console.log(`Бакет: ${BUCKET}\n`);

  const index = await s3Get("projects/index.json");
  if (!index) {
    console.log("projects/index.json не найден — нечего мигрировать.");
    return;
  }

  console.log(`Проектов в индексе: ${index.length}`);

  const needsBackfill = index.filter((p) => p.ownerId === undefined);
  const alreadyHas = index.filter((p) => p.ownerId !== undefined);

  console.log(`  уже с ownerId: ${alreadyHas.length}`);
  console.log(`  нужна дозапись: ${needsBackfill.length}\n`);

  if (needsBackfill.length === 0) {
    console.log("Всё уже в порядке, миграция не нужна.");
    return;
  }

  const updated = await Promise.all(
    index.map(async (entry) => {
      if (entry.ownerId !== undefined) return entry;

      let project = null;
      try {
        project = await s3Get(`projects/${entry.id}/project.json`);
      } catch (e) {
        console.warn(`  WARN: не удалось загрузить projects/${entry.id}/project.json — ${e.message}`);
      }
      const ownerId = project?.ownerId ?? null;
      console.log(`  ${entry.id}: ownerId = ${ownerId ?? "(нет — legacy)"}`);
      return { ...entry, ownerId };
    })
  );

  console.log("\n--- Результат ---");
  for (const p of updated) {
    console.log(`  ${p.id} → ownerId: ${p.ownerId ?? "null (будет виден только админу)"}`);
  }

  if (DRY_RUN) {
    console.log("\n[DRY-RUN] projects/index.json НЕ изменён. Запустите с --apply чтобы применить.");
  } else {
    await s3Put("projects/index.json", updated);
    console.log("\n✓ projects/index.json обновлён.");
  }
}

main().catch((err) => {
  console.error("Ошибка:", err.message);
  process.exit(1);
});
