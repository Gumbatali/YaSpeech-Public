import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseWavHeader,
  sliceWav,
  chunkWav,
  stitchChunkedSegments,
} from "../src/infrastructure/diarization/wav-chunker.js";

const SAMPLE_RATE = 16_000;

/** Строит валидный WAV PCM 16-bit mono заданной длительности. */
function makeWav(durationSec, { sampleRate = SAMPLE_RATE } = {}) {
  const frames = Math.round(durationSec * sampleRate);
  const dataLength = frames * 2;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataLength, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataLength, 40);

  // Пилообразный сигнал — по значению сэмпла видно его порядковый номер.
  const pcm = Buffer.alloc(dataLength);
  for (let i = 0; i < frames; i++) {
    pcm.writeInt16LE((i % 1000) - 500, i * 2);
  }

  return Buffer.concat([header, pcm]);
}

test("parseWavHeader reads canonical PCM header", () => {
  const wav = makeWav(2);
  const info = parseWavHeader(wav);

  assert.ok(info);
  assert.equal(info.sampleRate, SAMPLE_RATE);
  assert.equal(info.channels, 1);
  assert.equal(info.bitsPerSample, 16);
  assert.equal(Math.round(info.durationSec), 2);
});

test("parseWavHeader rejects non-WAV data", () => {
  assert.equal(parseWavHeader(Buffer.from("not audio at all")), null);
  assert.equal(parseWavHeader(Buffer.alloc(10)), null);
});

test("parseWavHeader trusts real byte length over a lying header", () => {
  // Именно этот случай ломал старую байтовую обрезку: заголовок обещает
  // больше данных, чем осталось в буфере.
  const wav = makeWav(4);
  const truncated = wav.subarray(0, 44 + 1000);
  const info = parseWavHeader(truncated);

  assert.ok(info);
  assert.equal(info.dataLength, 1000);
});

test("sliceWav produces a valid standalone WAV with correct duration", () => {
  const wav = makeWav(10);
  const slice = sliceWav(wav, 2, 5);

  const info = parseWavHeader(slice);
  assert.ok(info, "slice must itself be parseable");
  assert.ok(Math.abs(info.durationSec - 3) < 0.01);

  // Заголовок должен описывать реальный размер, а не исходный.
  assert.equal(info.dataLength, slice.length - 44);
  assert.equal(slice.readUInt32LE(4), 36 + info.dataLength);
});

test("sliceWav aligns cuts to frame boundaries", () => {
  const wav = makeWav(10);
  // Момент, который не попадает на целый байт-фрейм.
  const slice = sliceWav(wav, 1.00003, 2.00007);
  const info = parseWavHeader(slice);

  assert.equal(info.dataLength % info.bytesPerFrame, 0);
});

test("sliceWav clamps to available audio and rejects empty ranges", () => {
  const wav = makeWav(5);

  const past = sliceWav(wav, 4, 99);
  assert.ok(Math.abs(parseWavHeader(past).durationSec - 1) < 0.01);

  assert.equal(sliceWav(wav, 3, 3), null);
  assert.equal(sliceWav(wav, 9, 10), null);
});

test("chunkWav returns the original when it fits in one chunk", () => {
  const wav = makeWav(30);
  const chunks = chunkWav(wav, { maxChunkSec: 600 });

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].startSec, 0);
});

test("chunkWav covers a long file end to end with overlap", () => {
  const wav = makeWav(100);
  const chunks = chunkWav(wav, { maxChunkSec: 30, overlapSec: 5 });

  assert.ok(chunks.length > 1);
  assert.equal(chunks[0].startSec, 0);

  // Ключевое свойство: последний чанк достаёт до конца записи.
  // Старый код терял здесь всё после лимита.
  const last = chunks[chunks.length - 1];
  assert.ok(Math.abs(last.endSec - 100) < 0.05, `last chunk ends at ${last.endSec}`);

  // Соседние чанки действительно перекрываются.
  for (let i = 1; i < chunks.length; i++) {
    assert.ok(chunks[i].startSec < chunks[i - 1].endSec);
  }

  // Каждый чанк — валидный самостоятельный WAV.
  for (const chunk of chunks) {
    assert.ok(parseWavHeader(chunk.buffer), `chunk ${chunk.index} must be valid WAV`);
  }
});

test("chunkWav rejects overlap larger than the chunk", () => {
  const wav = makeWav(100);
  assert.throws(() => chunkWav(wav, { maxChunkSec: 10, overlapSec: 10 }));
});

test("stitchChunkedSegments shifts chunk timings into absolute time", () => {
  const stitched = stitchChunkedSegments(
    [
      { startSec: 0, segments: [{ speaker: "SPEAKER_00", start: 1, stop: 5 }] },
      { startSec: 60, segments: [{ speaker: "SPEAKER_00", start: 20, stop: 25 }] },
    ],
    { overlapSec: 10 }
  );

  const late = stitched.find((s) => s.start > 50);
  assert.ok(late);
  assert.equal(late.start, 80); // 60 + 20
  assert.equal(late.stop, 85);
});

test("stitchChunkedSegments matches speakers across chunks by overlap", () => {
  // Один и тот же человек в зоне перекрытия назван по-разному в двух чанках.
  // Сшивка должна понять, что это один спикер.
  const stitched = stitchChunkedSegments(
    [
      {
        startSec: 0,
        segments: [
          { speaker: "SPEAKER_00", start: 0, stop: 30 },
          { speaker: "SPEAKER_01", start: 30, stop: 58 },
        ],
      },
      {
        startSec: 50,
        segments: [
          // Локальный SPEAKER_01 звучит в перекрытии там же, где прежний SPEAKER_01.
          { speaker: "SPEAKER_01", start: 0, stop: 8 },
          { speaker: "SPEAKER_00", start: 12, stop: 30 },
        ],
      },
    ],
    { overlapSec: 10 }
  );

  const speakers = new Set(stitched.map((s) => s.speaker));
  assert.equal(speakers.size, 2, `expected 2 speakers, got ${[...speakers].join(", ")}`);
});

test("stitchChunkedSegments introduces a new speaker for an unseen local label", () => {
  // Во втором чанке появляется ярлык, которого раньше не было, и в зоне
  // перекрытия он не звучит. Сопоставлять не с чем — это новый участник.
  const stitched = stitchChunkedSegments(
    [
      { startSec: 0, segments: [{ speaker: "SPEAKER_00", start: 0, stop: 20 }] },
      { startSec: 50, segments: [{ speaker: "SPEAKER_07", start: 30, stop: 40 }] },
    ],
    { overlapSec: 10 }
  );

  assert.equal(new Set(stitched.map((s) => s.speaker)).size, 2);
});

test("stitchChunkedSegments reuses identity for the same label across a silent seam", () => {
  // Тот же локальный ярлык, но человек молчал ровно в стыке. Акустических
  // свидетельств нет, и единственный доступный сигнал — совпадение ярлыка.
  // Считаем его тем же участником: лишний фантомный спикер в протоколе хуже,
  // чем небольшой риск склейки, потому что дробит реплики одного человека.
  const stitched = stitchChunkedSegments(
    [
      { startSec: 0, segments: [{ speaker: "SPEAKER_00", start: 0, stop: 20 }] },
      { startSec: 50, segments: [{ speaker: "SPEAKER_00", start: 30, stop: 40 }] },
    ],
    { overlapSec: 10 }
  );

  assert.equal(new Set(stitched.map((s) => s.speaker)).size, 1);
});

test("stitchChunkedSegments returns segments sorted by start time", () => {
  const stitched = stitchChunkedSegments(
    [
      { startSec: 100, segments: [{ speaker: "SPEAKER_00", start: 0, stop: 5 }] },
      { startSec: 0, segments: [{ speaker: "SPEAKER_00", start: 0, stop: 5 }] },
    ],
    { overlapSec: 10 }
  );

  for (let i = 1; i < stitched.length; i++) {
    assert.ok(stitched[i].start >= stitched[i - 1].start);
  }
});

test("stitchChunkedSegments handles empty input", () => {
  assert.deepEqual(stitchChunkedSegments([]), []);
  assert.deepEqual(stitchChunkedSegments(null), []);
});
