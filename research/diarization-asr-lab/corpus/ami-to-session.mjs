#!/usr/bin/env node
/**
 * Converts one real meeting from the AMI Meeting Corpus (manual NITE XML
 * word-level annotations, one *.words.xml file per participant) into a
 * session in the same format build-corpus.mjs produces, so run/diarize.py,
 * run/transcribe.py and score/*.mjs work unchanged. Words per participant
 * are collapsed into utterances by pause (--pause, default 1s).
 */
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

function parseArgs(argv) {
  const args = { wordsDir: null, meetingId: null, audio: null, out: null, pause: 1.0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--words-dir") args.wordsDir = argv[++i];
    else if (a === "--meeting-id") args.meetingId = argv[++i];
    else if (a === "--audio") args.audio = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--pause") args.pause = Number(argv[++i]);
  }
  if (!args.wordsDir || !args.meetingId || !args.audio || !args.out) {
    console.error("Использование: ami-to-session.mjs --words-dir DIR --meeting-id ID --audio PATH --out DIR [--pause SEC]");
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

/** Возвращает [{start, end, text}] в порядке появления в файле (уже хронологический) */
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

/** Схлопывает слова одного участника в реплики по паузе */
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

function findParticipantFiles(wordsDir, meetingId) {
  return readdirSync(wordsDir)
    .filter((f) => f.startsWith(`${meetingId}.`) && f.endsWith(".words.xml"))
    .map((f) => ({ participant: f.split(".")[1], path: join(wordsDir, f) }))
    .sort((a, b) => a.participant.localeCompare(b.participant));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.out, { recursive: true });

  const participantFiles = findParticipantFiles(args.wordsDir, args.meetingId);
  if (participantFiles.length === 0) {
    console.error(`Не нашёл файлов *.words.xml для ${args.meetingId} в ${args.wordsDir}`);
    process.exit(1);
  }

  const allSegments = [];
  for (const { participant, path } of participantFiles) {
    const words = parseWordsXml(path);
    const segments = wordsToSegments(words, args.pause);
    for (const s of segments) {
      allSegments.push({
        speaker: `SPEAKER_${participant}`,
        sourceId: participant,
        startSec: Number(s.start.toFixed(3)),
        endSec: Number(s.end.toFixed(3)),
        text: s.text,
      });
    }
    console.log(`  ${participant}: ${words.length} слов -> ${segments.length} реплик`);
  }
  allSegments.sort((a, b) => a.startSec - b.startSec);

  const durationSec = Math.max(...allSegments.map((s) => s.endSec));
  const sessionId = `session-ami-${args.meetingId}`;

  const rttmLines = allSegments.map((s) =>
    `SPEAKER ${sessionId} 1 ${s.startSec.toFixed(3)} ${(s.endSec - s.startSec).toFixed(3)} <NA> <NA> ${s.speaker} <NA> <NA>`
  );
  writeFileSync(join(args.out, `${sessionId}.rttm`), rttmLines.join("\n") + "\n");

  writeFileSync(
    join(args.out, `${sessionId}.ref.json`),
    JSON.stringify({ sessionId, durationSec, segments: allSegments }, null, 2)
  );

  const audioName = `${sessionId}.wav`;
  copyFileSync(args.audio, join(args.out, audioName));

  const manifestEntry = {
    id: sessionId,
    audio: audioName,
    rttm: `${sessionId}.rttm`,
    ref: `${sessionId}.ref.json`,
    numSpeakers: new Set(allSegments.map((s) => s.speaker)).size,
    durationSec,
  };
  writeFileSync(join(args.out, "manifest.jsonl"), JSON.stringify(manifestEntry) + "\n");

  console.log(
    `\n${sessionId}: ${allSegments.length} реплик, ${manifestEntry.numSpeakers} спикеров, ` +
    `${(durationSec / 60).toFixed(1)} мин -> ${args.out}/manifest.jsonl`
  );
}

main();
