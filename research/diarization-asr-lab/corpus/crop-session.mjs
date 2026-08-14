#!/usr/bin/env node
/**
 * Crops an existing session (any session in build-corpus.mjs/
 * ami-to-session.mjs format) to its first N minutes. Utterances crossing
 * the crop boundary are truncated, not dropped, so the reference RTTM stays
 * in sync with the actually-cropped audio; numSpeakers is recomputed.
 */
import { readFileSync, writeFileSync, mkdirSync, openSync, readSync, fstatSync, closeSync } from "node:fs";
import { join } from "node:path";

function parseArgs(argv) {
  const args = { sessionDir: null, sessionId: null, minutes: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--session-dir") args.sessionDir = argv[++i];
    else if (a === "--session-id") args.sessionId = argv[++i];
    else if (a === "--minutes") args.minutes = Number(argv[++i]);
    else if (a === "--out") args.out = argv[++i];
  }
  if (!args.sessionDir || !args.sessionId || !args.minutes || !args.out) {
    console.error("Использование: crop-session.mjs --session-dir DIR --session-id ID --minutes N --out DIR");
    process.exit(1);
  }
  return args;
}

function readWavChunks(path) {
  const fd = openSync(path, "r");
  const size = fstatSync(fd).size;
  const header = Buffer.alloc(12);
  readSync(fd, header, 0, 12, 0);
  if (header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WAVE") {
    closeSync(fd);
    throw new Error(`${path}: не WAV/RIFF`);
  }
  let offset = 12;
  let fmt = null;
  let dataOffset = null;
  let dataSize = null;
  const chunkHeader = Buffer.alloc(8);
  while (offset + 8 <= size) {
    readSync(fd, chunkHeader, 0, 8, offset);
    const id = chunkHeader.toString("ascii", 0, 4);
    const chunkSize = chunkHeader.readUInt32LE(4);
    if (id === "fmt ") {
      const fmtBuf = Buffer.alloc(chunkSize);
      readSync(fd, fmtBuf, 0, chunkSize, offset + 8);
      fmt = {
        audioFormat: fmtBuf.readUInt16LE(0),
        numChannels: fmtBuf.readUInt16LE(2),
        sampleRate: fmtBuf.readUInt32LE(4),
        bitsPerSample: fmtBuf.readUInt16LE(14),
      };
    } else if (id === "data") {
      dataOffset = offset + 8;
      dataSize = chunkSize;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  closeSync(fd);
  if (!fmt || dataOffset === null) throw new Error(`${path}: нет fmt/data чанка`);
  return { fmt, dataOffset, dataSize, path };
}

function cropWav(wavInfo, cropSec, outPath) {
  const { fmt, dataOffset, dataSize, path } = wavInfo;
  const bytesPerSample = (fmt.bitsPerSample / 8) * fmt.numChannels;
  const totalSamples = dataSize / bytesPerSample;
  const cropSamples = Math.min(Math.floor(cropSec * fmt.sampleRate), totalSamples);
  const cropBytes = cropSamples * bytesPerSample;

  const fd = openSync(path, "r");
  const audioBuf = Buffer.alloc(cropBytes);
  readSync(fd, audioBuf, 0, cropBytes, dataOffset);
  closeSync(fd);

  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + cropBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(fmt.audioFormat, 20);
  header.writeUInt16LE(fmt.numChannels, 22);
  header.writeUInt32LE(fmt.sampleRate, 24);
  header.writeUInt32LE(fmt.sampleRate * bytesPerSample, 28);
  header.writeUInt16LE(bytesPerSample, 32);
  header.writeUInt16LE(fmt.bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(cropBytes, 40);

  writeFileSync(outPath, Buffer.concat([header, audioBuf]));
  return cropSamples / fmt.sampleRate;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.out, { recursive: true });

  const srcWav = join(args.sessionDir, `${args.sessionId}.wav`);
  const srcRef = join(args.sessionDir, `${args.sessionId}.ref.json`);

  const wavInfo = readWavChunks(srcWav);
  const ref = JSON.parse(readFileSync(srcRef, "utf-8"));

  const cropSec = args.minutes * 60;
  const newSessionId = `${args.sessionId}-${args.minutes}min`;
  const actualCropSec = cropWav(wavInfo, cropSec, join(args.out, `${newSessionId}.wav`));

  const croppedSegments = [];
  for (const s of ref.segments) {
    if (s.startSec >= actualCropSec) continue;
    croppedSegments.push({ ...s, endSec: Math.min(s.endSec, actualCropSec) });
  }

  const numSpeakers = new Set(croppedSegments.map((s) => s.speaker)).size;

  writeFileSync(
    join(args.out, `${newSessionId}.ref.json`),
    JSON.stringify({ sessionId: newSessionId, durationSec: actualCropSec, segments: croppedSegments }, null, 2)
  );

  const rttmLines = croppedSegments.map((s) =>
    `SPEAKER ${newSessionId} 1 ${s.startSec.toFixed(3)} ${(s.endSec - s.startSec).toFixed(3)} <NA> <NA> ${s.speaker} <NA> <NA>`
  );
  writeFileSync(join(args.out, `${newSessionId}.rttm`), rttmLines.join("\n") + "\n");

  const manifestEntry = {
    id: newSessionId,
    audio: `${newSessionId}.wav`,
    rttm: `${newSessionId}.rttm`,
    ref: `${newSessionId}.ref.json`,
    numSpeakers,
    durationSec: actualCropSec,
  };
  writeFileSync(join(args.out, "manifest.jsonl"), JSON.stringify(manifestEntry) + "\n");

  const droppedSpeakers = new Set(ref.segments.map((s) => s.speaker)).size - numSpeakers;
  console.log(
    `${newSessionId}: ${croppedSegments.length} реплик (из ${ref.segments.length}), ` +
    `${numSpeakers} спикеров из окна 0–${(actualCropSec / 60).toFixed(1)} мин` +
    (droppedSpeakers > 0 ? ` (${droppedSpeakers} спикер(ов) из полной встречи ещё не заговорили)` : "") +
    ` -> ${args.out}/manifest.jsonl`
  );
}

main();
