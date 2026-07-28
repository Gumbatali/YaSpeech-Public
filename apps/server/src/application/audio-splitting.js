/**
 * Разрезание WAV-файла на самостоятельные валидные WAV-чанки.
 *
 * Изначально жила только в groq-whisper-gateway.js (под лимит файла Groq API,
 * 25 MB). Вынесена сюда и обобщена — используется также для ПАРАЛЛЕЛЬНОГО
 * распознавания больших записей через Yandex SpeechKit (см.
 * meeting-pipeline-service.js): вместо одного долгого запроса записи режутся
 * на куски по длительности и распознаются одновременно, а не по очереди.
 *
 * Наши файлы всегда PCM 16-bit mono 16kHz (см. apps/web/app/audio/preprocessor.js),
 * но заголовок читаем динамически — на случай другого формата WAV.
 */

/**
 * Читает базовые параметры из заголовка WAV.
 */
export function parseWavHeader(buf) {
  if (buf.length < 44) throw new Error("WAV buffer too small");
  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bitsPerSample = buf.readUInt16LE(34);
  return { channels, sampleRate, bitsPerSample, headerSize: 44 };
}

/**
 * Пересобирает корректный WAV-заголовок для среза PCM-данных.
 */
export function buildWavBuffer(pcmSlice, { channels, sampleRate, bitsPerSample }) {
  const dataSize = pcmSlice.length;
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

  return Buffer.concat([header, pcmSlice]);
}

/**
 * Нарезает WAV буфер на чанки ≤ maxBytes.
 * Каждый чанк — самостоятельный валидный WAV файл.
 *
 * @returns {Array<{ wavBuffer: Buffer, offsetSeconds: number, durationSeconds: number }>}
 */
export function splitWavByBytes(wavBuf, maxBytes) {
  const params = parseWavHeader(wavBuf);
  const { sampleRate, bitsPerSample, channels, headerSize } = params;
  const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);

  if (wavBuf.length <= maxBytes) {
    const durationSeconds = (wavBuf.length - headerSize) / bytesPerSecond;
    return [{ wavBuffer: wavBuf, offsetSeconds: 0, durationSeconds }];
  }

  const maxPcmBytes = maxBytes - headerSize;
  const pcm = wavBuf.slice(headerSize);
  const chunks = [];
  let offset = 0;

  while (offset < pcm.length) {
    const slice = pcm.slice(offset, offset + maxPcmBytes);
    const wav = buildWavBuffer(slice, params);
    const offsetSeconds = offset / bytesPerSecond;
    const durationSeconds = slice.length / bytesPerSecond;
    chunks.push({ wavBuffer: wav, offsetSeconds, durationSeconds });
    offset += maxPcmBytes;
  }

  return chunks;
}

/**
 * То же самое, но параметр — целевая длительность чанка в секундах
 * (удобнее для параллельного ASR, где важно число и размер параллельных
 * задач, а не байтовый лимит стороннего API).
 *
 * @returns {Array<{ wavBuffer: Buffer, offsetSeconds: number, durationSeconds: number }>}
 */
export function splitWavBySeconds(wavBuf, chunkSeconds) {
  const { sampleRate, bitsPerSample, channels } = parseWavHeader(wavBuf);
  const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
  const maxBytes = 44 + Math.floor(chunkSeconds * bytesPerSecond);
  return splitWavByBytes(wavBuf, maxBytes);
}
