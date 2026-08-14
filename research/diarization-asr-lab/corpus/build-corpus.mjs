#!/usr/bin/env node
/**
 * Builds a synthetic multi-speaker corpus from independent Golos utterances
 * (manifest.jsonl from scripts/benchmark/download_golos.py). Each utterance
 * is treated as its own synthetic speaker. Outputs per session: concatenated
 * WAV, reference RTTM, and ref.json (per-utterance text for cpWER).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const SILENCE_MS = 400; // пауза между репликами внутри сессии

function parseArgs(argv) {
  const args = { manifest: null, out: "results/corpus", sessions: 8, speakersPerSession: 4, seed: 42 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--manifest") args.manifest = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--sessions") args.sessions = Number(argv[++i]);
    else if (a === "--speakers-per-session") args.speakersPerSession = Number(argv[++i]);
    else if (a === "--seed") args.seed = Number(argv[++i]);
  }
  if (!args.manifest) {
    console.error("Использование: build-corpus.mjs --manifest <manifest.jsonl> [--out DIR] [--sessions N] [--speakers-per-session K] [--seed N]");
    process.exit(1);
  }
  return args;
}

// Детерминированный PRNG (mulberry32) — воспроизводимые сессии по --seed
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function parseWavHeader(buf) {
  if (buf.length < 44) throw new Error("WAV buffer too small");
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a RIFF/WAVE file");
  }
  // Ищем чанк "fmt " и "data" — не предполагаем фиксированное смещение 44,
  // некоторые энкодеры (в т.ч. libsndfile) добавляют доп. чанки перед data.
  let offset = 12;
  let fmt = null;
  let dataOffset = null, dataSize = null;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (chunkId === "fmt ") {
      fmt = {
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (chunkId === "data") {
      dataOffset = body;
      dataSize = chunkSize;
      break; // данные нам дальше не нужны, fmt уже должен быть найден раньше
    }
    offset = body + chunkSize + (chunkSize % 2); // чанки выровнены по 2 байта
  }
  if (!fmt || dataOffset === null) throw new Error("WAV: fmt/data chunk not found");
  return { ...fmt, dataOffset, dataSize };
}

function buildWavBuffer(pcm, { channels, sampleRate, bitsPerSample }) {
  const dataSize = pcm.length;
  const header = Buffer.allocUnsafe(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  header.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

function readPcm(wavPath) {
  const buf = readFileSync(wavPath);
  const { channels, sampleRate, bitsPerSample, dataOffset, dataSize } = parseWavHeader(buf);
  if (channels !== 1) throw new Error(`${wavPath}: ожидался mono WAV, найдено ${channels} каналов`);
  const pcm = buf.subarray(dataOffset, dataOffset + dataSize);
  return { pcm, sampleRate, bitsPerSample };
}

function silencePcm(ms, sampleRate, bitsPerSample) {
  const bytesPerSample = bitsPerSample / 8;
  const samples = Math.round((ms / 1000) * sampleRate);
  return Buffer.alloc(samples * bytesPerSample); // нули = тишина
}

function loadManifest(path) {
  const dir = dirname(resolve(path));
  return readFileSync(path, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const row = JSON.parse(line);
      return { ...row, audioAbs: resolve(dir, row.audio) };
    });
}

function buildSession(sessionIdx, replicas, outDir) {
  const sessionId = `session-${String(sessionIdx).padStart(3, "0")}`;
  let sampleRate = null, bitsPerSample = null;
  const pcmParts = [];
  const rttmLines = [];
  const refSegments = [];
  let cursorSec = 0;

  replicas.forEach((rep, i) => {
    const { pcm, sampleRate: sr, bitsPerSample: bps } = readPcm(rep.audioAbs);
    if (sampleRate === null) { sampleRate = sr; bitsPerSample = bps; }
    else if (sr !== sampleRate || bps !== bitsPerSample) {
      throw new Error(`${rep.id}: несовпадающий формат WAV в сессии (ожидался ${sampleRate}Hz/${bitsPerSample}bit, получено ${sr}Hz/${bps}bit)`);
    }

    const durationSec = pcm.length / (sampleRate * (bitsPerSample / 8));
    const speaker = `SPEAKER_${String(rep.speakerSlot).padStart(2, "0")}`;

    rttmLines.push(
      `SPEAKER ${sessionId} 1 ${cursorSec.toFixed(3)} ${durationSec.toFixed(3)} <NA> <NA> ${speaker} <NA> <NA>`
    );
    refSegments.push({
      speaker,
      sourceId: rep.id,
      startSec: Number(cursorSec.toFixed(3)),
      endSec: Number((cursorSec + durationSec).toFixed(3)),
      text: rep.ref,
    });

    pcmParts.push(pcm);
    cursorSec += durationSec;

    if (i < replicas.length - 1) {
      pcmParts.push(silencePcm(SILENCE_MS, sampleRate, bitsPerSample));
      cursorSec += SILENCE_MS / 1000;
    }
  });

  const wav = buildWavBuffer(Buffer.concat(pcmParts), { channels: 1, sampleRate, bitsPerSample });
  writeFileSync(join(outDir, `${sessionId}.wav`), wav);
  writeFileSync(join(outDir, `${sessionId}.rttm`), rttmLines.join("\n") + "\n");
  writeFileSync(
    join(outDir, `${sessionId}.ref.json`),
    JSON.stringify({ sessionId, durationSec: cursorSec, segments: refSegments }, null, 2)
  );

  return {
    id: sessionId,
    audio: `${sessionId}.wav`,
    rttm: `${sessionId}.rttm`,
    ref: `${sessionId}.ref.json`,
    numSpeakers: new Set(replicas.map((r) => r.speakerSlot)).size,
    durationSec: Number(cursorSec.toFixed(3)),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rand = mulberry32(args.seed);
  const rows = loadManifest(args.manifest);

  const perSession = args.speakersPerSession;
  if (rows.length < perSession) {
    console.error(`Манифест даёт только ${rows.length} реплик — нужно минимум ${perSession} на сессию.`);
    process.exit(1);
  }

  mkdirSync(args.out, { recursive: true });

  const pool = shuffle(rows, rand);
  const manifestOut = [];

  for (let s = 0; s < args.sessions; s++) {
    // Каждая сессия — свежая перестановка K реплик из пула (с возвратом,
    // пул может быть меньше sessions*K). speakerSlot переиндексируется
    // локально на сессию (0..K-1), это НЕ один и тот же человек между сессиями.
    const picks = [];
    for (let k = 0; k < perSession; k++) {
      picks.push(pool[(s * perSession + k) % pool.length]);
    }
    const replicas = shuffle(picks, rand).map((r, slot) => ({ ...r, speakerSlot: slot }));

    const session = buildSession(s, replicas, args.out);
    manifestOut.push(session);
    console.log(`  ${session.id}  ${session.numSpeakers} спикеров, ${session.durationSec.toFixed(1)}s`);
  }

  writeFileSync(
    join(args.out, "manifest.jsonl"),
    manifestOut.map((s) => JSON.stringify(s)).join("\n") + "\n"
  );

  console.log(`\n${manifestOut.length} сессий → ${resolve(args.out)}/manifest.jsonl`);
}

main();
