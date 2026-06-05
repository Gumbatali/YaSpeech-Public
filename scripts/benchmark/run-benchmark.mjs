#!/usr/bin/env node
/**
 * YaSpeech ASR-бенчмарк.
 *
 * Прогоняет набор аудио с известными эталонными расшифровками через живой
 * YaSpeech API и считает WER/CER. На выходе — report.json + report.md.
 *
 * Использование:
 *   BENCH_BASE_URL=https://<gateway> \
 *   BENCH_LOGIN=admin BENCH_PASSWORD=*** \
 *   node scripts/benchmark/run-benchmark.mjs scripts/benchmark/data/manifest.jsonl
 *
 * Формат manifest.jsonl — по одной JSON-записи на строку:
 *   { "id": "golos-001", "audio": "data/golos-001.wav",
 *     "ref": "эталонный текст", "tags": ["farfield"] }
 * Поле "audio" — путь относительно директории манифеста.
 *
 * Зависимостей нет: только встроенный fetch (Node 18+).
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { scoreTranscript } from "./lib/wer.mjs";

const BASE_URL = (process.env.BENCH_BASE_URL || "").replace(/\/$/, "");
const LOGIN = process.env.BENCH_LOGIN || "";
const PASSWORD = process.env.BENCH_PASSWORD || "";
const POLL_INTERVAL_MS = Number(process.env.BENCH_POLL_MS || 3000);
const POLL_TIMEOUT_MS = Number(process.env.BENCH_TIMEOUT_MS || 180000);
// Статусы, на которых расшифровка уже готова к чтению.
const READY_STATUSES = new Set(["draft", "done"]);

function die(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

function guessContentType(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  const map = {
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/m4a",
    ".ogg": "audio/ogg", ".opus": "audio/opus", ".flac": "audio/flac",
    ".webm": "audio/webm", ".aac": "audio/aac"
  };
  return map[ext] || "application/octet-stream";
}

/** Тонкая обёртка над fetch: тянет cookie сессии между запросами. */
class ApiSession {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cookie = null;
  }

  async request(method, pathname, { json, raw, contentType, headers = {} } = {}) {
    const finalHeaders = { ...headers };
    if (this.cookie) finalHeaders.cookie = this.cookie;
    let body;
    if (json !== undefined) {
      finalHeaders["content-type"] = "application/json";
      body = JSON.stringify(json);
    } else if (raw !== undefined) {
      finalHeaders["content-type"] = contentType || "application/octet-stream";
      body = raw;
    }

    const res = await fetch(`${this.baseUrl}${pathname}`, { method, headers: finalHeaders, body });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";")[0];
    return res;
  }

  async login(login, password) {
    const res = await this.request("POST", "/api/auth/login", { json: { login, password } });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      die(`Login failed (${res.status}): ${text}`);
    }
  }
}

/** Загрузка одного аудио и ожидание готовой расшифровки. Возвращает текст. */
async function transcribeOne(session, projectId, sample, manifestDir) {
  const audioPath = path.resolve(manifestDir, sample.audio);
  const audioBytes = await readFile(audioPath);
  const fileName = path.basename(audioPath);
  const contentType = guessContentType(fileName);

  // 1. Создаём встречу — получаем presigned upload URL.
  const createRes = await session.request("POST", "/api/meetings", {
    json: { projectId, date: new Date().toISOString().slice(0, 10), fileName, contentType }
  });
  if (!createRes.ok) {
    throw new Error(`create meeting ${createRes.status}: ${await createRes.text()}`);
  }
  const { meeting, upload } = await createRes.json();
  const meetingId = meeting.id;

  // 2. Заливаем байты по presigned URL (абсолютный URL на storage.yandexcloud.net).
  const putRes = await fetch(upload.uploadUrl, {
    method: upload.method || "PUT",
    headers: { "content-type": contentType },
    body: audioBytes
  });
  if (!putRes.ok) {
    throw new Error(`upload PUT ${putRes.status}: ${await putRes.text().catch(() => "")}`);
  }

  // 3. Сигналим о завершении загрузки → пайплайн стартует.
  const completeRes = await session.request(
    "POST",
    `/api/meetings/${meetingId}/upload-complete`,
    { json: { sizeBytes: audioBytes.length } }
  );
  if (!completeRes.ok) {
    throw new Error(`upload-complete ${completeRes.status}: ${await completeRes.text()}`);
  }

  // 4. Поллим статус, пока расшифровка не готова (draft/done) или не упала.
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastStatus = "uploaded";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const statusRes = await session.request("GET", `/api/meetings/${meetingId}`);
    if (!statusRes.ok) continue;
    const body = await statusRes.json();
    lastStatus = body.meeting?.status;
    if (READY_STATUSES.has(lastStatus)) break;
    if (lastStatus === "failed") {
      throw new Error(`pipeline failed: ${body.meeting?.error || "unknown"}`);
    }
  }
  if (!READY_STATUSES.has(lastStatus)) {
    throw new Error(`timeout, last status: ${lastStatus}`);
  }

  // 5. Забираем готовый текст.
  const txtRes = await session.request("GET", `/api/meetings/${meetingId}/transcript.txt`);
  if (!txtRes.ok) {
    throw new Error(`transcript.txt ${txtRes.status}: ${await txtRes.text()}`);
  }
  return { text: await txtRes.text(), meetingId };
}

async function main() {
  const manifestPath = process.argv[2];
  if (!manifestPath) die("Укажи путь к manifest.jsonl первым аргументом.");
  if (!BASE_URL) die("Не задан BENCH_BASE_URL.");
  if (!LOGIN || !PASSWORD) die("Не заданы BENCH_LOGIN / BENCH_PASSWORD.");

  const manifestDir = path.dirname(path.resolve(manifestPath));
  const raw = await readFile(manifestPath, "utf8");
  const samples = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  if (samples.length === 0) die("Манифест пуст.");

  console.log(`📋 ${samples.length} образцов | ${BASE_URL}`);
  const session = new ApiSession(BASE_URL);
  await session.login(LOGIN, PASSWORD);
  console.log(`🔑 Авторизован как ${LOGIN}`);

  // Отдельный проект под прогон, чтобы не засорять рабочие данные.
  const projectName = `benchmark-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`;
  const projRes = await session.request("POST", "/api/projects", { json: { name: projectName } });
  if (!projRes.ok) die(`create project ${projRes.status}: ${await projRes.text()}`);
  const projectId = (await projRes.json()).project.id;
  console.log(`📁 Проект: ${projectName} (${projectId})\n`);

  const results = [];
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i];
    const label = `[${i + 1}/${samples.length}] ${sample.id}`;
    try {
      const { text, meetingId } = await transcribeOne(session, projectId, sample, manifestDir);
      const score = scoreTranscript(sample.ref, text);
      results.push({ id: sample.id, tags: sample.tags || [], meetingId, ...score, ok: true, hypothesis: text });
      console.log(`${label}  WER ${(score.wer * 100).toFixed(1)}%  CER ${(score.cer * 100).toFixed(1)}%`);
    } catch (error) {
      results.push({ id: sample.id, tags: sample.tags || [], ok: false, error: error.message });
      console.log(`${label}  ⚠️  ${error.message}`);
    }
  }

  const ok = results.filter((r) => r.ok);
  const avg = (key) => (ok.length ? ok.reduce((s, r) => s + r[key], 0) / ok.length : 0);
  const summary = {
    base: BASE_URL,
    runAt: new Date().toISOString(),
    total: results.length,
    succeeded: ok.length,
    failed: results.length - ok.length,
    avgWer: avg("wer"),
    avgCer: avg("cer")
  };

  const reportJson = { summary, results };
  const outBase = path.resolve(manifestDir, "..");
  await writeFile(path.join(outBase, "report.json"), JSON.stringify(reportJson, null, 2));
  await writeFile(path.join(outBase, "report.md"), renderMarkdown(summary, results));

  console.log(`\n── Итого ──`);
  console.log(`Успешно: ${summary.succeeded}/${summary.total}`);
  console.log(`Средний WER: ${(summary.avgWer * 100).toFixed(1)}%`);
  console.log(`Средний CER: ${(summary.avgCer * 100).toFixed(1)}%`);
  console.log(`📄 report.json + report.md → ${outBase}`);
}

function renderMarkdown(summary, results) {
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  const lines = [
    `# YaSpeech ASR Benchmark`,
    ``,
    `- **Когда:** ${summary.runAt}`,
    `- **Образцов:** ${summary.total} (успешно ${summary.succeeded}, ошибок ${summary.failed})`,
    `- **Средний WER:** ${pct(summary.avgWer)}`,
    `- **Средний CER:** ${pct(summary.avgCer)}`,
    ``,
    `| ID | Теги | WER | CER | S | D | I | Статус |`,
    `|----|------|-----|-----|---|---|---|--------|`
  ];
  for (const r of results) {
    if (r.ok) {
      lines.push(`| ${r.id} | ${(r.tags || []).join(", ")} | ${pct(r.wer)} | ${pct(r.cer)} | ${r.substitutions} | ${r.deletions} | ${r.insertions} | ✅ |`);
    } else {
      lines.push(`| ${r.id} | ${(r.tags || []).join(", ")} | — | — | — | — | — | ⚠️ ${r.error} |`);
    }
  }
  return lines.join("\n") + "\n";
}

main().catch((e) => die(e.stack || e.message));
