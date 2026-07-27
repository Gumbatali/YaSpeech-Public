import test from "node:test";
import assert from "node:assert/strict";
import {
  parseWavHeader,
  buildWavBuffer,
  splitWavByBytes,
  splitWavBySeconds
} from "../src/application/audio-splitting.js";

const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const BYTES_PER_SECOND = SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8); // 32000

/** Создаёт валидный WAV (16kHz mono 16-bit PCM) заданной длительности с
 *  предсказуемым содержимым — сэмпл N = N % 65536 (для проверки, что байты
 *  не теряются и не искажаются при разрезании). */
function makeTestWav(durationSeconds) {
  const totalSamples = Math.round(durationSeconds * SAMPLE_RATE);
  const pcm = Buffer.alloc(totalSamples * 2);
  for (let i = 0; i < totalSamples; i++) {
    pcm.writeInt16LE(i % 32768, i * 2);
  }
  return buildWavBuffer(pcm, { channels: CHANNELS, sampleRate: SAMPLE_RATE, bitsPerSample: BITS_PER_SAMPLE });
}

test("parseWavHeader: читает формат из собранного заголовка", () => {
  const wav = makeTestWav(1);
  const header = parseWavHeader(wav);
  assert.equal(header.channels, CHANNELS);
  assert.equal(header.sampleRate, SAMPLE_RATE);
  assert.equal(header.bitsPerSample, BITS_PER_SAMPLE);
  assert.equal(header.headerSize, 44);
});

test("splitWavByBytes: файл меньше лимита — один чанк, offset 0", () => {
  const wav = makeTestWav(2); // 64000 байт PCM + 44 заголовок
  const chunks = splitWavByBytes(wav, 10 * 1024 * 1024);

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].offsetSeconds, 0);
  assert.ok(Math.abs(chunks[0].durationSeconds - 2) < 0.001);
  assert.deepEqual(chunks[0].wavBuffer, wav); // не пересобирается зря
});

test("splitWavByBytes: файл больше лимита — несколько валидных WAV-чанков подряд", () => {
  const wav = makeTestWav(10); // 320000 байт PCM
  const maxBytes = 44 + 100000; // ~3.125 сек на чанк
  const chunks = splitWavByBytes(wav, maxBytes);

  assert.ok(chunks.length > 1, "должно быть несколько чанков");

  // Каждый чанк — самостоятельный валидный WAV с тем же форматом
  for (const chunk of chunks) {
    const header = parseWavHeader(chunk.wavBuffer);
    assert.equal(header.sampleRate, SAMPLE_RATE);
    assert.equal(header.channels, CHANNELS);
    assert.ok(chunk.wavBuffer.length <= maxBytes);
  }

  // offset'ы идут по порядку без пропусков и перекрытий
  let expectedOffset = 0;
  for (const chunk of chunks) {
    assert.ok(Math.abs(chunk.offsetSeconds - expectedOffset) < 1e-9);
    expectedOffset += chunk.durationSeconds;
  }
  assert.ok(Math.abs(expectedOffset - 10) < 0.001, "сумма длительностей чанков = исходная длительность");
});

test("splitWavByBytes: PCM-данные не теряются и не дублируются при разрезании (побайтовый roundtrip)", () => {
  const wav = makeTestWav(5);
  const originalPcm = wav.slice(44);
  const chunks = splitWavByBytes(wav, 44 + 50000);

  const reassembled = Buffer.concat(chunks.map((c) => c.wavBuffer.slice(44)));
  assert.deepEqual(reassembled, originalPcm);
});

test("splitWavBySeconds: делит по целевой длительности чанка, а не по байтам API", () => {
  const wav = makeTestWav(25); // 25 секунд
  const chunks = splitWavBySeconds(wav, 10); // по 10 сек

  assert.equal(chunks.length, 3); // 10 + 10 + 5
  assert.ok(Math.abs(chunks[0].durationSeconds - 10) < 0.001);
  assert.ok(Math.abs(chunks[1].durationSeconds - 10) < 0.001);
  assert.ok(Math.abs(chunks[2].durationSeconds - 5) < 0.001);
  assert.equal(chunks[1].offsetSeconds, 10);
  assert.equal(chunks[2].offsetSeconds, 20);
});

test("splitWavBySeconds: короткий файл — один чанк без разрезания", () => {
  const wav = makeTestWav(3);
  const chunks = splitWavBySeconds(wav, 600); // лимит 10 минут, файл 3 сек
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].offsetSeconds, 0);
});
