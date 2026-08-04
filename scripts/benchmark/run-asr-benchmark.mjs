#!/usr/bin/env node
/**
 * Замер качества расшифровки: WER и cpWER.
 *
 * Отвечает на вопрос, который не покрывает DER: насколько хорош итоговый
 * протокол, а не только разметка «кто когда говорил».
 *
 *   WER   — верны ли слова (качество ASR)
 *   cpWER — верны ли слова И правильному ли человеку приписаны
 *
 * Разница между ними — цена ошибок диаризации и выравнивания. Если WER 15%,
 * а cpWER 35%, то половина проблемы протокола не в распознавании, а в том,
 * что реплики уходят не тем людям.
 *
 * Схемы (--mode):
 *   speechkit         — Яндекс SpeechKit со встроенной диаризацией (как в проде)
 *   whisper+diarizer  — Groq Whisper для текста + внешний диаризатор
 *
 * Запуск:
 *   YC_IAM_TOKEN=$(yc iam create-token) YC_BUCKET=my-bucket \
 *   node run-asr-benchmark.mjs --manifest ami/manifest.jsonl --mode speechkit
 *
 *   GROQ_API_KEY=gsk_... node run-asr-benchmark.mjs \
 *     --manifest ami/manifest.jsonl --mode whisper+diarizer \
 *     --diarizer http://localhost:8003 --language en
 */

import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { computeCpWer, computeWer } from "./lib/cpwer.mjs";

const args = parseArgs(process.argv.slice(2));

if (!args.manifest || !args.mode) {
  console.error(`
Использование:
  node run-asr-benchmark.mjs --manifest <path> --mode <speechkit|whisper+diarizer> [опции]

Опции:
  --diarizer <url>   адрес сервиса диаризации (для whisper+diarizer)
  --language <код>   язык, напр. ru-RU или en (по умолчанию из манифеста)
  --label <имя>      как назвать схему в отчёте
  --limit <n>        обработать только первые n записей

Переменные окружения:
  speechkit:        YC_IAM_TOKEN, YC_BUCKET
  whisper+diarizer: GROQ_API_KEY
`);
  process.exit(1);
}

const manifestPath = resolve(args.manifest);
const corpusDir = dirname(manifestPath);

let records = (await readFile(manifestPath, "utf8"))
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l))
  .filter((r) => Array.isArray(r.reference_text) && r.reference_text.length);

if (records.length === 0) {
  console.error("❌ В манифесте нет записей с полем reference_text — WER считать не из чего.");
  process.exit(1);
}

if (args.limit) records = records.slice(0, args.limit);

const label = args.label ?? args.mode;

console.log(`📊 Корпус: ${records.length} записей`);
console.log(`🎙  Схема: ${label}\n`);

const results = [];

for (const record of records) {
  const audioPath = join(corpusDir, record.audio);
  const language = args.language ?? (record.language === "en" ? "en-US" : "ru-RU");

  process.stdout.write(`   ${record.id} … `);
  const started = Date.now();

  try {
    const utterances =
      args.mode === "speechkit"
        ? await transcribeSpeechKit(audioPath, record, language)
        : await transcribeWhisperPlusDiarizer(audioPath, record, language);

    const elapsedSec = (Date.now() - started) / 1000;

    const wer = computeWer(record.reference_text, utterances);
    const cp = computeCpWer(record.reference_text, utterances);

    results.push({
      id: record.id,
      wer: wer.wer,
      cpwer: cp.cpwer,
      refWords: wer.refWords,
      refSpeakers: cp.refSpeakers,
      hypSpeakers: cp.hypSpeakers,
      elapsedSec,
      rtf: record.duration_sec ? elapsedSec / record.duration_sec : null,
    });

    console.log(
      `WER ${pct(wer.wer)}  cpWER ${pct(cp.cpwer)}  спикеров ${cp.hypSpeakers}/${cp.refSpeakers}  (${elapsedSec.toFixed(0)}с)`
    );
  } catch (e) {
    console.log(`ОШИБКА: ${e.message}`);
    results.push({ id: record.id, error: e.message });
  }
}

// ── Итоги ───────────────────────────────────────────────────────────────────

const ok = results.filter((r) => !r.error);

console.log(`\n═══ ${label} ═══\n`);

if (ok.length === 0) {
  console.log("Ни одной успешной записи.");
} else {
  // Взвешенное по словам среднее, а не среднее по файлам: длинная встреча
  // должна влиять на итог сильнее короткой.
  const totalWords = ok.reduce((s, r) => s + r.refWords, 0);
  const wWer = ok.reduce((s, r) => s + r.wer * r.refWords, 0) / totalWords;
  const wCp = ok.reduce((s, r) => s + r.cpwer * r.refWords, 0) / totalWords;

  console.log(`  WER    ${pct(wWer)}   (качество текста)`);
  console.log(`  cpWER  ${pct(wCp)}   (текст + привязка к спикерам)`);
  console.log(`  разрыв ${pct(wCp - wWer)}   ← цена ошибок диаризации и выравнивания`);
  console.log(`\n  файлов ${ok.length}/${results.length}, слов в эталоне ${totalWords}`);

  const rtfs = ok.map((r) => r.rtf).filter((x) => x != null);
  if (rtfs.length) {
    console.log(`  RTF    ${(rtfs.reduce((a, b) => a + b, 0) / rtfs.length).toFixed(2)}×`);
  }
}

const reportPath = join(corpusDir, `asr-benchmark-${label.replace(/[^\w.-]/g, "_")}.json`);
await writeFile(
  reportPath,
  JSON.stringify({ generatedAt: new Date().toISOString(), label, mode: args.mode, files: results }, null, 2)
);
console.log(`\n📄 Отчёт: ${reportPath}`);

// ── SpeechKit ───────────────────────────────────────────────────────────────

async function transcribeSpeechKit(audioPath, record, language) {
  const iamToken = process.env.YC_IAM_TOKEN;
  const bucket = process.env.YC_BUCKET;
  if (!iamToken || !bucket) throw new Error("нужны YC_IAM_TOKEN и YC_BUCKET");

  const key = `benchmark/${record.id}.wav`;
  await uploadToStorage(audioPath, bucket, key, iamToken);
  const uri = `https://storage.yandexcloud.net/${bucket}/${key}`;

  // x-folder-id обязателен, когда токен получен для пользовательского
  // аккаунта (yc iam create-token). У сервисного аккаунта folder выводится
  // из самого токена, но лишний заголовок ему не мешает.
  const folderHeaders = process.env.YC_FOLDER_ID
    ? { "x-folder-id": process.env.YC_FOLDER_ID }
    : {};

  const startRes = await fetch("https://stt.api.cloud.yandex.net/stt/v3/recognizeFileAsync", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${iamToken}`,
      "Content-Type": "application/json",
      ...folderHeaders,
    },
    body: JSON.stringify({
      uri,
      recognitionModel: {
        model: "general",
        audioFormat: { containerAudio: { containerAudioType: "WAV" } },
        textNormalization: {
          textNormalization: "TEXT_NORMALIZATION_ENABLED",
          literatureText: false,
        },
        languageRestriction: {
          restrictionType: "WHITELIST",
          languageCode: [language],
        },
      },
      speakerLabeling: { speakerLabeling: "SPEAKER_LABELING_ENABLED" },
    }),
  });

  if (!startRes.ok) {
    throw new Error(`SpeechKit start ${startRes.status}: ${(await startRes.text()).slice(0, 200)}`);
  }

  const { id: operationId } = await startRes.json();

  // Опрос до готовности. SpeechKit обрабатывает примерно за треть
  // длительности записи, но гарантий нет.
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(10_000);

    const res = await fetch(
      `https://stt.api.cloud.yandex.net/stt/v3/getRecognition?operationId=${operationId}`,
      { headers: { Authorization: `Bearer ${iamToken}`, ...folderHeaders } }
    );

    if (res.status === 404) continue; // ещё не начал
    if (!res.ok) throw new Error(`SpeechKit get ${res.status}`);

    const body = await res.text();
    if (!body.trim()) continue;

    const utterances = parseSpeechKitNdjson(body);
    if (utterances.length) return utterances;
  }

  throw new Error("SpeechKit: истёк таймаут ожидания");
}

/**
 * Разбирает NDJSON-ответ SpeechKit.
 *
 * Тонкость, из-за которой наивный парсер удваивает текст: на каждую реплику
 * приходит ДВА события — `final` (сырой результат) и `finalRefinement`
 * (тот же текст после нормализации). Считать оба — значит получить WER
 * больше 100%, потому что расшифровка удваивается.
 *
 * Берём finalRefinement, если он есть (там расставлены заглавные буквы и
 * числа приведены к цифрам), иначе final. Одна реплика — одна запись.
 *
 * Про спикеров: даже при speakerLabeling=ENABLED поле speakerTag в ответе
 * может отсутствовать — тогда остаётся только channelTag, который для
 * одноканального файла всегда один и тот же. В этом случае диаризации
 * фактически нет, и это видно по числу найденных спикеров.
 */
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

  // Ключ реплики — момент её окончания: он одинаков у final и его refinement.
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

    const speaker = String(
      result.speakerTag ?? alternatives[0].speakerTag ?? result.channelTag ?? "1"
    );
    const startMs = Number(alternatives[0].startTimeMs ?? result.audioCursors?.partialTimeMs ?? 0);

    const entry = { speaker: `spk${speaker}`, start: startMs / 1000, text };

    // refinement перезаписывает более раннюю сырую версию той же реплики.
    if (!byCursor.has(cursor) || refinement) byCursor.set(cursor, entry);
  }

  return [...byCursor.values()].sort((a, b) => a.start - b.start);
}

async function uploadToStorage(audioPath, bucket, key, iamToken) {
  const body = await readFile(audioPath);
  const res = await fetch(`https://storage.yandexcloud.net/${bucket}/${key}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${iamToken}`, "Content-Type": "audio/wav" },
    body,
  });
  if (!res.ok) {
    throw new Error(`upload ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

// ── Whisper + внешний диаризатор ────────────────────────────────────────────

async function transcribeWhisperPlusDiarizer(audioPath, record, language) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("нужен GROQ_API_KEY");
  if (!args.diarizer) throw new Error("нужен --diarizer <url>");

  const audio = await readFile(audioPath);

  // Шаг 1: текст с посегментными таймкодами.
  const form = new FormData();
  form.append("file", new Blob([audio]), basename(audioPath));
  form.append("model", "whisper-large-v3");
  form.append("response_format", "verbose_json");
  form.append("language", language.split("-")[0]);

  const asrRes = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(20 * 60 * 1000),
  });

  if (!asrRes.ok) {
    throw new Error(`Groq ${asrRes.status}: ${(await asrRes.text()).slice(0, 200)}`);
  }

  const asr = await asrRes.json();
  const segments = asr.segments ?? [];

  // Шаг 2: разметка спикеров.
  const diarForm = new FormData();
  diarForm.append("audio", new Blob([audio]), basename(audioPath));
  if (record.num_speakers) diarForm.append("num_speakers", String(record.num_speakers));

  const diarRes = await fetch(`${args.diarizer.replace(/\/+$/, "")}/diarize`, {
    method: "POST",
    body: diarForm,
    signal: AbortSignal.timeout(30 * 60 * 1000),
  });

  if (!diarRes.ok) {
    throw new Error(`diarizer ${diarRes.status}: ${(await diarRes.text()).slice(0, 200)}`);
  }

  const diarization = (await diarRes.json()).segments ?? [];

  // Шаг 3: выравнивание — тем же правилом, что в проде.
  return alignSegments(segments, diarization);
}

/**
 * Приписывает каждому сегменту Whisper спикера с наибольшим перекрытием.
 *
 * Ровно так делает alignTranscriptWithDiarization в проде, поэтому замер
 * отражает реальное качество протокола, а не идеализированное.
 */
function alignSegments(whisperSegments, diarizationSegments) {
  return whisperSegments
    .map((seg) => {
      const overlap = {};
      for (const d of diarizationSegments) {
        const lo = Math.max(seg.start, d.start);
        const hi = Math.min(seg.end, d.stop);
        if (hi > lo) overlap[d.speaker] = (overlap[d.speaker] ?? 0) + (hi - lo);
      }

      const best = Object.entries(overlap).sort((a, b) => b[1] - a[1])[0];
      return {
        speaker: best ? best[0] : "SPEAKER_00",
        start: seg.start,
        text: seg.text ?? "",
      };
    })
    .filter((u) => u.text.trim());
}

// ── Вспомогательное ─────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--manifest") out.manifest = argv[++i];
    else if (a === "--mode") out.mode = argv[++i];
    else if (a === "--diarizer") out.diarizer = argv[++i];
    else if (a === "--language") out.language = argv[++i];
    else if (a === "--label") out.label = argv[++i];
    else if (a === "--limit") out.limit = Number(argv[++i]);
  }
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pct(v) {
  return v == null ? "—" : `${(v * 100).toFixed(1)}%`;
}
