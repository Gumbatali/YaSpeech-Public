#!/usr/bin/env node
/**
 * Прогоняет одну реальную запись через две схемы и сохраняет оба протокола
 * рядом для сравнения глазами.
 *
 * В отличие от run-asr-benchmark.mjs, здесь нет эталонного текста —
 * реальные планёрки не размечены вручную. Поэтому WER/cpWER не считаются;
 * сравнение идёт по структуре (число спикеров, распределение реплик) и
 * визуально — эксперту нужно посмотреть, стало ли читать протокол легче.
 *
 * Схема A: SpeechKit как есть (channelTag 0/1, как в проде сейчас)
 * Схема B: SpeechKit + внешний диаризатор (channelTag заменяется на
 *          разметку от отдельной модели)
 *
 * Запуск:
 *   YC_IAM_TOKEN=... YC_BUCKET=... node run-real-meeting.mjs \
 *     --audio meeting1.wav --diarizer http://localhost:8003 --out results/
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";

const args = parseArgs(process.argv.slice(2));

if (!args.audio || !args.diarizer || !args.out) {
  console.error("Использование: --audio <path> --diarizer <url> --out <dir> [--language ru-RU]");
  process.exit(1);
}

const language = args.language ?? "ru-RU";
const id = basename(args.audio).replace(/\.\w+$/, "");

await mkdir(args.out, { recursive: true });

console.log(`🎙  ${id}: распознаю через SpeechKit…`);
const started = Date.now();
const speechKitUtterances = await transcribeSpeechKit(args.audio, language);
const asrElapsed = (Date.now() - started) / 1000;

console.log(
  `   готово за ${asrElapsed.toFixed(0)}с: ${speechKitUtterances.length} реплик, ` +
    `${countWords(speechKitUtterances)} слов, спикеров ${countSpeakers(speechKitUtterances)}`
);

// Схема A — как есть, только приводим к общему формату отчёта.
const schemeA = {
  scheme: "speechkit-as-is",
  utterances: speechKitUtterances,
  speakers: countSpeakers(speechKitUtterances),
  words: countWords(speechKitUtterances),
};

// Схема B — переразмечаем той же диаризацией, что и в make-deps.js (smart).
console.log(`🔀 диаризую через ${args.diarizer}…`);
const diarStarted = Date.now();
const diarization = await callDiarizer(args.audio, args.diarizer, args.numSpeakers);
const diarElapsed = (Date.now() - diarStarted) / 1000;

console.log(
  `   готово за ${diarElapsed.toFixed(0)}с: ${diarization.length} сегментов, ` +
    `${new Set(diarization.map((d) => d.speaker)).size} спикеров`
);

const rediarized = rediarize(speechKitUtterances, diarization);
const schemeB = {
  scheme: "speechkit+diarizer",
  utterances: rediarized,
  speakers: countSpeakers(rediarized),
  words: countWords(rediarized),
  diarizationSegments: diarization.length,
  diarizationElapsedSec: diarElapsed,
};

// ── Отчёт ────────────────────────────────────────────────────────────────

console.log(`\n═══ ${id} ═══`);
console.log(`  Схема A (SpeechKit как есть):        ${schemeA.speakers} спикеров, ${schemeA.words} слов`);
console.log(`  Схема B (SpeechKit + диаризатор):    ${schemeB.speakers} спикеров, ${schemeB.words} слов`);

const report = {
  id,
  generatedAt: new Date().toISOString(),
  audioDurationSec: await audioDuration(args.audio),
  asrElapsedSec: asrElapsed,
  schemeA,
  schemeB,
};

await writeFile(join(args.out, `${id}-comparison.json`), JSON.stringify(report, null, 2));

// Протоколы читаемым текстом — для визуального сравнения.
await writeFile(join(args.out, `${id}-scheme-a.txt`), formatTranscript(schemeA.utterances));
await writeFile(join(args.out, `${id}-scheme-b.txt`), formatTranscript(schemeB.utterances));

console.log(`\n📄 ${args.out}/${id}-comparison.json`);
console.log(`📄 ${args.out}/${id}-scheme-a.txt`);
console.log(`📄 ${args.out}/${id}-scheme-b.txt`);

// ── SpeechKit ────────────────────────────────────────────────────────────

async function transcribeSpeechKit(audioPath, language) {
  const iamToken = process.env.YC_IAM_TOKEN;
  const bucket = process.env.YC_BUCKET;
  if (!iamToken || !bucket) throw new Error("нужны YC_IAM_TOKEN и YC_BUCKET");

  const key = `real-meeting/${basename(audioPath)}`;
  const body = await readFile(audioPath);

  const upload = await fetch(`https://storage.yandexcloud.net/${bucket}/${key}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${iamToken}`, "Content-Type": "audio/wav" },
    body,
  });
  if (!upload.ok) throw new Error(`upload ${upload.status}: ${(await upload.text()).slice(0, 200)}`);

  const uri = `https://storage.yandexcloud.net/${bucket}/${key}`;
  const folderHeaders = process.env.YC_FOLDER_ID ? { "x-folder-id": process.env.YC_FOLDER_ID } : {};

  const startRes = await fetch("https://stt.api.cloud.yandex.net/stt/v3/recognizeFileAsync", {
    method: "POST",
    headers: { Authorization: `Bearer ${iamToken}`, "Content-Type": "application/json", ...folderHeaders },
    body: JSON.stringify({
      uri,
      recognitionModel: {
        model: "general",
        audioFormat: { containerAudio: { containerAudioType: "WAV" } },
        textNormalization: { textNormalization: "TEXT_NORMALIZATION_ENABLED", literatureText: false },
        languageRestriction: { restrictionType: "WHITELIST", languageCode: [language] },
      },
      speakerLabeling: { speakerLabeling: "SPEAKER_LABELING_ENABLED" },
    }),
  });

  if (!startRes.ok) throw new Error(`SpeechKit start ${startRes.status}: ${(await startRes.text()).slice(0, 200)}`);
  const { id: operationId } = await startRes.json();

  const deadline = Date.now() + 40 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(10_000);
    const res = await fetch(
      `https://stt.api.cloud.yandex.net/stt/v3/getRecognition?operationId=${operationId}`,
      { headers: { Authorization: `Bearer ${iamToken}`, ...folderHeaders } }
    );
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`SpeechKit get ${res.status}`);
    const text = await res.text();
    if (!text.trim()) continue;
    const utterances = parseSpeechKitNdjson(text);
    if (utterances.length) return utterances;
  }
  throw new Error("SpeechKit: истёк таймаут ожидания");
}

/** Та же дедупликация final/finalRefinement, что и в run-asr-benchmark.mjs. */
function parseSpeechKitNdjson(body) {
  const events = [];
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* пропускаем битую строку */
    }
  }

  const byCursor = new Map();
  for (const event of events) {
    const result = event.result ?? event;
    const cursor = String(result.audioCursors?.finalTimeMs ?? result.audioCursors?.finalIndex ?? "");
    const refinement = result.finalRefinement?.normalizedText;
    const payload = refinement ?? result.final;
    if (!payload) continue;
    const alternatives = payload.alternatives ?? [];
    if (!alternatives.length) continue;
    const text = alternatives[0].text ?? "";
    if (!text.trim()) continue;
    const speaker = String(result.speakerTag ?? alternatives[0].speakerTag ?? result.channelTag ?? "1");
    const startMs = Number(alternatives[0].startTimeMs ?? result.audioCursors?.partialTimeMs ?? 0);
    const entry = { speaker: `spk${speaker}`, start: startMs / 1000, text };
    if (!byCursor.has(cursor) || refinement) byCursor.set(cursor, entry);
  }
  return [...byCursor.values()].sort((a, b) => a.start - b.start);
}

// ── Диаризация ───────────────────────────────────────────────────────────

async function callDiarizer(audioPath, diarizerUrl, numSpeakers) {
  const audio = await readFile(audioPath);
  const form = new FormData();
  form.append("audio", new Blob([audio]), basename(audioPath));
  if (numSpeakers) form.append("num_speakers", String(numSpeakers));

  const res = await fetch(`${diarizerUrl.replace(/\/+$/, "")}/diarize`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(40 * 60 * 1000),
  });
  if (!res.ok) throw new Error(`diarizer ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).segments ?? [];
}

/**
 * Та же логика, что в проде (findDominantSpeaker) и в run-asr-benchmark.mjs:
 * наибольшее перекрытие, а без перекрытия — ближайший по времени сегмент.
 */
function rediarize(utterances, diarization) {
  if (diarization.length === 0) return utterances;

  const withEnd = utterances.map((u, i) => ({
    ...u,
    end: u.end ?? utterances[i + 1]?.start ?? u.start + 3,
  }));

  return withEnd.map((u) => {
    const overlap = {};
    for (const d of diarization) {
      const lo = Math.max(u.start, d.start);
      const hi = Math.min(u.end, d.stop);
      if (hi > lo) overlap[d.speaker] = (overlap[d.speaker] ?? 0) + (hi - lo);
    }

    const best = Object.entries(overlap).sort((a, b) => b[1] - a[1])[0];
    if (best) return { speaker: best[0], start: u.start, text: u.text };

    let nearest = null;
    let bestDistance = Infinity;
    const middle = (u.start + u.end) / 2;
    for (const d of diarization) {
      const distance = middle < d.start ? d.start - middle : middle > d.stop ? middle - d.stop : 0;
      if (distance < bestDistance) {
        bestDistance = distance;
        nearest = d.speaker;
      }
    }
    return { speaker: nearest ?? "SPEAKER_00", start: u.start, text: u.text };
  });
}

// ── Вспомогательное ──────────────────────────────────────────────────────

function formatTranscript(utterances) {
  return utterances
    .sort((a, b) => a.start - b.start)
    .map((u) => `[${formatTime(u.start)}] ${u.speaker}: ${u.text}`)
    .join("\n");
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function countSpeakers(utterances) {
  return new Set(utterances.map((u) => u.speaker)).size;
}

function countWords(utterances) {
  return utterances.reduce((s, u) => s + u.text.split(/\s+/).filter(Boolean).length, 0);
}

async function audioDuration(path) {
  // Быстрая оценка по размеру WAV PCM16 mono 16kHz — не читаем весь файл.
  const { size } = await import("node:fs").then((fs) => fs.promises.stat(path));
  return Math.round(((size - 44) / 2 / 16000) * 10) / 10;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--audio") out.audio = argv[++i];
    else if (a === "--diarizer") out.diarizer = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--language") out.language = argv[++i];
    else if (a === "--num-speakers") out.numSpeakers = Number(argv[++i]);
  }
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
