#!/usr/bin/env node
/**
 * cpWER (concatenated minimum-permutation WER): WER that also penalizes
 * wrong speaker attribution, not just transcription errors. Assigns each
 * ASR segment to the diarization speaker with max time overlap, concatenates
 * text per hypothesis speaker, then takes the reference<->hypothesis speaker
 * permutation minimizing total edit distance (via alignTokens).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { alignTokens, tokenize } from "../../../scripts/benchmark/lib/wer.mjs";

function parseArgs(argv) {
  const args = { corpusDir: null, asrDir: null, diarizationDir: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--corpus-dir") args.corpusDir = argv[++i];
    else if (a === "--asr-dir") args.asrDir = argv[++i];
    else if (a === "--diarization-dir") args.diarizationDir = argv[++i];
    else if (a === "--out") args.out = argv[++i];
  }
  if (!args.corpusDir || !args.asrDir || !args.diarizationDir) {
    console.error("Использование: score-cpwer.mjs --corpus-dir DIR --asr-dir DIR --diarization-dir DIR [--out report.md]");
    process.exit(1);
  }
  args.out ??= join(args.diarizationDir, "cpwer-report.md");
  return args;
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function parseRttm(path) {
  const text = readFileSync(path, "utf-8");
  return text.split("\n").map((l) => l.trim()).filter(Boolean).map((line) => {
    const p = line.split(/\s+/);
    const start = Number(p[3]);
    const duration = Number(p[4]);
    return { speaker: p[7], start, end: start + duration };
  });
}

function dominantSpeaker(start, end, diarSegments) {
  let best = null, bestOverlap = 0;
  for (const seg of diarSegments) {
    const lo = Math.max(start, seg.start);
    const hi = Math.min(end, seg.end);
    const overlap = Math.max(0, hi - lo);
    if (overlap > bestOverlap) { bestOverlap = overlap; best = seg.speaker; }
  }
  if (best) return best;
  // Нет пересечения (пауза в диаризации) — ближайший по середине сегмента
  const mid = (start + end) / 2;
  let nearest = null, nearestDist = Infinity;
  for (const seg of diarSegments) {
    const segMid = (seg.start + seg.end) / 2;
    const dist = Math.abs(mid - segMid);
    if (dist < nearestDist) { nearestDist = dist; nearest = seg.speaker; }
  }
  return nearest ?? "UNKNOWN";
}

function buildHypBySpeaker(asrSegments, diarSegments) {
  const order = [];
  const bySpeaker = new Map();
  for (const seg of asrSegments) {
    const speaker = dominantSpeaker(seg.start, seg.end, diarSegments);
    if (!bySpeaker.has(speaker)) { bySpeaker.set(speaker, []); order.push(speaker); }
    bySpeaker.get(speaker).push(seg.text);
  }
  return order.map((label) => ({ label, text: bySpeaker.get(label).join(" ") }));
}

function buildRefBySpeaker(refSegments) {
  const order = [];
  const bySpeaker = new Map();
  for (const seg of refSegments) {
    if (!bySpeaker.has(seg.speaker)) { bySpeaker.set(seg.speaker, []); order.push(seg.speaker); }
    bySpeaker.get(seg.speaker).push(seg.text);
  }
  return order.map((label) => ({ label, text: bySpeaker.get(label).join(" ") }));
}

/** Все перестановки массива индексов [0..n) */
function* permutations(n) {
  const indices = Array.from({ length: n }, (_, i) => i);
  yield* permute(indices, 0);
}
function* permute(arr, k) {
  if (k === arr.length - 1) { yield arr.slice(); return; }
  for (let i = k; i < arr.length; i++) {
    [arr[k], arr[i]] = [arr[i], arr[k]];
    yield* permute(arr, k + 1);
    [arr[k], arr[i]] = [arr[i], arr[k]];
  }
}

/**
 * cpWER для одной сессии: минимум по всем перестановкам гипотез-спикеров
 * относительно фиксированного порядка эталонных.
 */
function computeSessionCpwer(refBySpeaker, hypBySpeaker) {
  const n = Math.max(refBySpeaker.length, hypBySpeaker.length);
  const refPadded = Array.from({ length: n }, (_, i) => refBySpeaker[i]?.text ?? "");
  const hypPadded = Array.from({ length: n }, (_, i) => hypBySpeaker[i]?.text ?? "");
  const refTokensAll = refPadded.map(tokenize);

  let best = { distance: Infinity, mapping: null };

  // n тут — число спикеров в сессии (в нашем корпусе единицы), n! тривиален
  for (const perm of permutations(n)) {
    let distance = 0;
    for (let i = 0; i < n; i++) {
      const hypTokens = tokenize(hypPadded[perm[i]]);
      distance += alignTokens(refTokensAll[i], hypTokens).distance;
    }
    if (distance < best.distance) best = { distance, mapping: perm.slice() };
  }

  const totalRefWords = refTokensAll.reduce((s, t) => s + t.length, 0);
  return {
    cpwer: totalRefWords > 0 ? best.distance / totalRefWords : (best.distance > 0 ? 1 : 0),
    distance: best.distance,
    refWords: totalRefWords,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = readFileSync(join(args.corpusDir, "manifest.jsonl"), "utf-8")
    .split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));

  const rows = [];
  let sumDistance = 0, sumRefWords = 0;

  for (const session of manifest) {
    const ref = loadJson(join(args.corpusDir, session.ref));
    const asrPath = join(args.asrDir, `${session.id}.asr.json`);
    const hypRttmPath = join(args.diarizationDir, `${session.id}.hyp.rttm`);

    let asr, diarSegments;
    try {
      asr = loadJson(asrPath);
      diarSegments = parseRttm(hypRttmPath);
    } catch {
      console.warn(`  ! нет гипотезы ASR или диаризации для ${session.id} — пропуск`);
      continue;
    }

    const refBySpeaker = buildRefBySpeaker(ref.segments);
    const hypBySpeaker = buildHypBySpeaker(asr.segments, diarSegments);

    const { cpwer, distance, refWords } = computeSessionCpwer(refBySpeaker, hypBySpeaker);
    rows.push({
      sessionId: session.id,
      cpwer,
      refSpeakers: refBySpeaker.length,
      hypSpeakers: hypBySpeaker.length,
    });
    sumDistance += distance;
    sumRefWords += refWords;

    console.log(
      `  ${session.id}: cpWER=${(cpwer * 100).toFixed(1)}%  ` +
      `спикеров реф=${refBySpeaker.length} гип=${hypBySpeaker.length}`
    );
  }

  const microCpwer = sumRefWords > 0 ? sumDistance / sumRefWords : null;

  const lines = [
    "# cpWER report",
    "",
    "| session | cpWER | ref speakers | hyp speakers |",
    "|---|---|---|---|",
    ...rows.map((r) => `| ${r.sessionId} | ${(r.cpwer * 100).toFixed(1)}% | ${r.refSpeakers} | ${r.hypSpeakers} |`),
    "",
    `**Micro-average cpWER (весь корпус): ${microCpwer !== null ? (microCpwer * 100).toFixed(1) + "%" : "н/д"}**`,
  ];

  writeFileSync(resolve(args.out), lines.join("\n") + "\n", "utf-8");
  console.log(`\nMicro-average cpWER: ${microCpwer !== null ? (microCpwer * 100).toFixed(1) + "%" : "н/д"}`);
  console.log(`Отчёт: ${resolve(args.out)}`);
}

main();
