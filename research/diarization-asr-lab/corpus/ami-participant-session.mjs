#!/usr/bin/env node
/**
 * Builds a single-participant session from one AMI Headset-N.wav track and
 * that participant's own words.xml — for testing ASR on isolated per-speaker
 * audio instead of the crosstalk-mixed Mix-Headset track (see
 * ami-to-session.mjs for the combined-session equivalent).
 */
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

function parseArgs(argv) {
  const args = { wordsFile: null, audio: null, sessionId: null, out: null, pause: 1.0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--words-file") args.wordsFile = argv[++i];
    else if (a === "--audio") args.audio = argv[++i];
    else if (a === "--session-id") args.sessionId = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--pause") args.pause = Number(argv[++i]);
  }
  if (!args.wordsFile || !args.audio || !args.sessionId || !args.out) {
    console.error("Использование: ami-participant-session.mjs --words-file FILE --audio PATH --session-id ID --out DIR [--pause SEC]");
    process.exit(1);
  }
  return args;
}

function decodeXmlEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"');
}

function parseWordsXml(path) {
  const xml = readFileSync(path, "utf-8");
  const words = [];
  const tagRe = /<w\b([^>]*)>([^<]*)<\/w>/g;
  let m;
  while ((m = tagRe.exec(xml))) {
    const attrs = m[1];
    const start = attrs.match(/starttime="([\d.]+)"/)?.[1];
    const end = attrs.match(/endtime="([\d.]+)"/)?.[1];
    if (start === undefined || end === undefined) continue;
    const text = decodeXmlEntities(m[2]).trim();
    if (!text) continue;
    words.push({ start: Number(start), end: Number(end), text });
  }
  return words;
}

function wordsToSegments(words, pauseSec) {
  const segments = [];
  let cur = null;
  for (const w of words) {
    if (!cur || w.start - cur.end > pauseSec) {
      if (cur) segments.push(cur);
      cur = { start: w.start, end: w.end, text: w.text };
    } else {
      cur.text += " " + w.text;
      cur.end = Math.max(cur.end, w.end);
    }
  }
  if (cur) segments.push(cur);
  return segments;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.out, { recursive: true });

  const words = parseWordsXml(args.wordsFile);
  const segments = wordsToSegments(words, args.pause);

  const refSegments = segments.map((s) => ({
    speaker: "SPEAKER_00",
    startSec: Number(s.start.toFixed(3)),
    endSec: Number(s.end.toFixed(3)),
    text: s.text,
  }));

  const durationSec = Math.max(...refSegments.map((s) => s.endSec));

  writeFileSync(
    join(args.out, `${args.sessionId}.ref.json`),
    JSON.stringify({ sessionId: args.sessionId, durationSec, segments: refSegments }, null, 2)
  );

  const audioName = `${args.sessionId}.wav`;
  copyFileSync(args.audio, join(args.out, audioName));

  const manifestEntry = {
    id: args.sessionId,
    audio: audioName,
    ref: `${args.sessionId}.ref.json`,
    numSpeakers: 1,
    durationSec,
  };
  writeFileSync(join(args.out, "manifest.jsonl"), JSON.stringify(manifestEntry) + "\n");

  console.log(`${args.sessionId}: ${refSegments.length} реплик, ${(durationSec / 60).toFixed(1)} мин -> ${args.out}/manifest.jsonl`);
}

main();
