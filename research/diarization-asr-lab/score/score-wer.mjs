#!/usr/bin/env node
/**
 * WER/CER гипотезы ASR (run/transcribe.py) против эталонного текста сессии
 * (build-corpus.mjs). Речь идёт о качестве распознавания текста как
 * такового, без учёта привязки к спикеру — для этого есть score-cpwer.mjs.
 *
 * Переиспользует scripts/benchmark/lib/wer.mjs как есть.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { scoreTranscript } from "../../../scripts/benchmark/lib/wer.mjs";

function parseArgs(argv) {
  const args = { corpusDir: null, asrDir: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--corpus-dir") args.corpusDir = argv[++i];
    else if (a === "--asr-dir") args.asrDir = argv[++i];
    else if (a === "--out") args.out = argv[++i];
  }
  if (!args.corpusDir || !args.asrDir) {
    console.error("Использование: score-wer.mjs --corpus-dir DIR --asr-dir DIR [--out report.md]");
    process.exit(1);
  }
  args.out ??= join(args.asrDir, "wer-report.md");
  return args;
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = readFileSync(join(args.corpusDir, "manifest.jsonl"), "utf-8")
    .split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));

  const rows = [];
  let sumDistance = 0, sumRefWords = 0;

  for (const session of manifest) {
    const ref = loadJson(join(args.corpusDir, session.ref));
    const refText = ref.segments.map((s) => s.text).join(" ");

    const asrPath = join(args.asrDir, `${session.id}.asr.json`);
    let hypText = "";
    try {
      hypText = loadJson(asrPath).text ?? "";
    } catch {
      console.warn(`  ! нет гипотезы ASR для ${session.id} (${asrPath}) — пропуск`);
      continue;
    }

    const score = scoreTranscript(refText, hypText);
    rows.push({ sessionId: session.id, ...score });
    sumDistance += score.wer * score.refWords;
    sumRefWords += score.refWords;

    console.log(`  ${session.id}: WER=${(score.wer * 100).toFixed(1)}%  CER=${(score.cer * 100).toFixed(1)}%`);
  }

  const microWer = sumRefWords > 0 ? sumDistance / sumRefWords : null;

  const lines = [
    "# WER/CER report",
    "",
    "| session | WER | CER | ref words | S | D | I |",
    "|---|---|---|---|---|---|---|",
    ...rows.map((r) =>
      `| ${r.sessionId} | ${(r.wer * 100).toFixed(1)}% | ${(r.cer * 100).toFixed(1)}% | ${r.refWords} | ${r.substitutions} | ${r.deletions} | ${r.insertions} |`
    ),
    "",
    `**Micro-average WER (весь корпус): ${microWer !== null ? (microWer * 100).toFixed(1) + "%" : "н/д"}**`,
  ];

  writeFileSync(resolve(args.out), lines.join("\n") + "\n", "utf-8");
  console.log(`\nMicro-average WER: ${microWer !== null ? (microWer * 100).toFixed(1) + "%" : "н/д"}`);
  console.log(`Отчёт: ${resolve(args.out)}`);
}

main();
