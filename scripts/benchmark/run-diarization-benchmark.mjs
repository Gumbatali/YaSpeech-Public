#!/usr/bin/env node
/**
 * Сравнение бэкендов диаризации по DER на одном корпусе.
 *
 * Каждый бэкенд — HTTP-сервис на общем контракте
 * (apps/server/src/infrastructure/diarization/contract.md), поэтому раннер
 * не знает, что внутри: NeMo, diart или pyannote. Это и позволяет сравнивать
 * их честно — одинаковый вход, одинаковая метрика, одинаковая постобработка.
 *
 * Запуск:
 *   node scripts/benchmark/run-diarization-benchmark.mjs \
 *     --manifest scripts/benchmark/data/synthetic/manifest.jsonl \
 *     --backend nemo-sortformer=http://51.250.1.1:8000 \
 *     --backend diart=http://51.250.1.2:8000 \
 *     --backend pyannote-selfhosted=http://51.250.1.3:8000
 *
 * Результат — таблица в stdout и JSON-отчёт рядом с манифестом.
 */

import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { computeDer, speakerCountError } from "./lib/der.mjs";

const args = parseArgs(process.argv.slice(2));

if (!args.manifest || args.backends.length === 0) {
  console.error(`
Использование:
  node run-diarization-benchmark.mjs --manifest <path> --backend <name>=<url> [--backend ...]

Опции:
  --manifest <path>       манифест корпуса (jsonl с полем reference)
  --backend <name>=<url>  сервис диаризации; можно указывать несколько раз
  --collar <sec>          collar для DER (по умолчанию 0.25)
  --skip-overlap          не штрафовать за перекрывающуюся речь
  --num-speakers <n>      подсказка числа спикеров (передаётся сервису)
  --timeout <sec>         таймаут одного запроса (по умолчанию 900)
`);
  process.exit(1);
}

const manifestPath = resolve(args.manifest);
const corpusDir = dirname(manifestPath);

const records = (await readFile(manifestPath, "utf8"))
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));

const withReference = records.filter((r) => Array.isArray(r.reference) && r.reference.length);

if (withReference.length === 0) {
  console.error("❌ В манифесте нет записей с полем reference — DER посчитать не из чего.");
  process.exit(1);
}

console.log(`📊 Корпус: ${withReference.length} записей из ${basename(manifestPath)}`);
console.log(`🎯 Бэкендов: ${args.backends.length}\n`);

// Проверяем доступность до прогона: ждать 20 минут, чтобы узнать, что сервис
// не поднялся, — плохой способ потратить время.
for (const backend of args.backends) {
  const health = await checkHealth(backend);
  const mark = health.ok ? "✓" : "✗";
  console.log(`  ${mark} ${backend.name.padEnd(22)} ${backend.url}  ${health.detail}`);
  backend.healthy = health.ok;
}

const usable = args.backends.filter((b) => b.healthy);
if (usable.length === 0) {
  console.error("\n❌ Ни один сервис не отвечает. Проверь, что контейнеры запущены.");
  process.exit(1);
}

console.log("");

const results = [];

for (const backend of usable) {
  console.log(`\n▶ ${backend.name}`);
  const perFile = [];

  for (const record of withReference) {
    const audioPath = join(corpusDir, record.audio);
    process.stdout.write(`   ${record.id} … `);

    try {
      const started = Date.now();
      const segments = await callDiarize(backend, audioPath, record, args);
      const elapsedSec = (Date.now() - started) / 1000;

      const der = computeDer(record.reference, segments, {
        collarSec: args.collar,
        skipOverlap: args.skipOverlap,
      });
      const counts = speakerCountError(record.reference, segments);
      const audioSec = record.reference.at(-1)?.stop ?? 0;

      perFile.push({
        id: record.id,
        der: der.der,
        miss: der.missRate,
        falseAlarm: der.falseAlarmRate,
        speakerError: der.speakerErrorRate,
        refSpeakers: counts.reference,
        hypSpeakers: counts.hypothesis,
        speakerCountCorrect: counts.correct,
        elapsedSec,
        rtf: audioSec > 0 ? elapsedSec / audioSec : null,
      });

      console.log(
        `DER ${pct(der.der)}  (miss ${pct(der.missRate)} / fa ${pct(der.falseAlarmRate)} / spk ${pct(
          der.speakerErrorRate
        )})  спикеров ${counts.hypothesis}/${counts.reference}`
      );
    } catch (e) {
      console.log(`ОШИБКА: ${e.message}`);
      perFile.push({ id: record.id, error: e.message });
    }
  }

  results.push({ backend: backend.name, url: backend.url, files: perFile });
}

// ── Итоговая таблица ────────────────────────────────────────────────────────

console.log("\n\n═══ ИТОГИ ═══\n");

const summary = results.map((r) => {
  const ok = r.files.filter((f) => !f.error);
  return {
    backend: r.backend,
    files: `${ok.length}/${r.files.length}`,
    der: mean(ok.map((f) => f.der)),
    miss: mean(ok.map((f) => f.miss)),
    falseAlarm: mean(ok.map((f) => f.falseAlarm)),
    speakerError: mean(ok.map((f) => f.speakerError)),
    speakerCountAcc: ok.length ? ok.filter((f) => f.speakerCountCorrect).length / ok.length : 0,
    rtf: mean(ok.map((f) => f.rtf).filter((x) => x != null)),
  };
});

summary.sort((a, b) => (a.der ?? 1e9) - (b.der ?? 1e9));

const header = ["бэкенд", "файлы", "DER", "miss", "FA", "spk-err", "N спик.", "RTF"];
const rows = summary.map((s) => [
  s.backend,
  s.files,
  pct(s.der),
  pct(s.miss),
  pct(s.falseAlarm),
  pct(s.speakerError),
  pct(s.speakerCountAcc),
  s.rtf != null ? s.rtf.toFixed(2) + "×" : "—",
]);

printTable(header, rows);

console.log("\nDER — ниже лучше. RTF — доля реального времени (0.5× = вдвое быстрее записи).");
console.log("«N спик.» — доля записей, где число участников угадано точно.\n");

if (summary.length > 1 && summary[0].der != null) {
  console.log(`🏆 Лучший по DER: ${summary[0].backend} (${pct(summary[0].der)})`);
}

const reportPath = join(corpusDir, "diarization-benchmark-report.json");
await writeFile(
  reportPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      manifest: manifestPath,
      options: { collar: args.collar, skipOverlap: args.skipOverlap },
      summary,
      details: results,
    },
    null,
    2
  )
);
console.log(`\n📄 Подробный отчёт: ${reportPath}`);

// ── Вспомогательное ─────────────────────────────────────────────────────────

async function checkHealth(backend) {
  try {
    const res = await fetch(`${backend.url}/health`, { signal: AbortSignal.timeout(10_000) });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.model_loaded) {
      return { ok: true, detail: `${body.model ?? "?"} на ${body.device ?? "?"}` };
    }
    return { ok: false, detail: body.status === "loading" ? "модель ещё грузится" : `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}

async function callDiarize(backend, audioPath, record, options) {
  const audio = await readFile(audioPath);
  const form = new FormData();
  form.append("audio", new Blob([audio]), basename(audioPath));

  // Подсказку числа спикеров берём из манифеста, если её не задали флагом:
  // так сравнение отражает реальный сценарий, где состав встречи известен.
  const hint = options.numSpeakers ?? record.num_speakers;
  if (hint) form.append("num_speakers", String(hint));

  const res = await fetch(`${backend.url}/diarize`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(options.timeout * 1000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.segments ?? [];
}

function parseArgs(argv) {
  const out = { backends: [], collar: 0.25, skipOverlap: false, timeout: 900, numSpeakers: null };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--manifest") out.manifest = argv[++i];
    else if (arg === "--backend") {
      const spec = argv[++i] ?? "";
      const idx = spec.indexOf("=");
      if (idx > 0) out.backends.push({ name: spec.slice(0, idx), url: spec.slice(idx + 1).replace(/\/+$/, "") });
    } else if (arg === "--collar") out.collar = Number(argv[++i]);
    else if (arg === "--skip-overlap") out.skipOverlap = true;
    else if (arg === "--timeout") out.timeout = Number(argv[++i]);
    else if (arg === "--num-speakers") out.numSpeakers = Number(argv[++i]);
  }

  return out;
}

function mean(values) {
  const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

function pct(value) {
  return value == null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function printTable(header, rows) {
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i]).length))
  );
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join("  ");

  console.log(line(header));
  console.log(widths.map((w) => "─".repeat(w)).join("  "));
  for (const row of rows) console.log(line(row));
}
