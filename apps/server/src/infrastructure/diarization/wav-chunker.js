/**
 * Нарезка WAV PCM по времени.
 *
 * Зачем: HuggingFace Inference API принимает не больше ~25 МБ. Раньше код
 * резал буфер через `buffer.slice(0, MAX_BYTES)` — по сырым байтам. Для WAV
 * это оставляет заголовок со старой длиной (декодер видит обрезанный файл как
 * битый), а для MP3/M4A обрывает посреди фрейма. Вдобавок всё после лимита
 * молча теряло спикеров: часовая планёрка диаризовалась только на первых
 * ~25 минутах, остальное схлопывалось в «Спикер 1».
 *
 * Решение: резать по границам сэмплов и переписывать заголовок, а длинное
 * аудио обрабатывать чанками с последующей сшивкой.
 *
 * Формат на входе гарантирован: браузерный preprocessor отдаёт WAV PCM
 * 16-bit mono 16 kHz (apps/web/app/audio/preprocessor.js). Для всего
 * остального parseWavHeader вернёт null, и вызывающий код решит, что делать.
 */

const WAV_HEADER_SIZE = 44;

/**
 * Разбирает канонический 44-байтный WAV-заголовок.
 * @returns {{sampleRate: number, channels: number, bitsPerSample: number,
 *            dataOffset: number, dataLength: number, durationSec: number}|null}
 */
export function parseWavHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < WAV_HEADER_SIZE) return null;
  if (buffer.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buffer.toString("ascii", 8, 12) !== "WAVE") return null;

  // Ищем чанки fmt и data — между ними могут быть посторонние (LIST, fact).
  let offset = 12;
  let fmt = null;
  let dataOffset = null;
  let dataLength = null;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const bodyOffset = offset + 8;

    if (chunkId === "fmt " && bodyOffset + 16 <= buffer.length) {
      fmt = {
        audioFormat: buffer.readUInt16LE(bodyOffset),
        channels: buffer.readUInt16LE(bodyOffset + 2),
        sampleRate: buffer.readUInt32LE(bodyOffset + 4),
        bitsPerSample: buffer.readUInt16LE(bodyOffset + 14),
      };
    } else if (chunkId === "data") {
      dataOffset = bodyOffset;
      // Заголовок может врать о длине (обрезанный файл) — доверяем реальности.
      dataLength = Math.min(chunkSize, buffer.length - bodyOffset);
      break;
    }

    offset = bodyOffset + chunkSize + (chunkSize % 2); // чанки выровнены по 2 байта
  }

  if (!fmt || dataOffset == null || dataLength == null || dataLength <= 0) return null;
  if (fmt.audioFormat !== 1) return null; // только несжатый PCM
  if (!fmt.sampleRate || !fmt.channels || !fmt.bitsPerSample) return null;

  const bytesPerFrame = (fmt.bitsPerSample / 8) * fmt.channels;
  if (bytesPerFrame <= 0) return null;

  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: fmt.bitsPerSample,
    bytesPerFrame,
    dataOffset,
    dataLength,
    durationSec: dataLength / bytesPerFrame / fmt.sampleRate,
  };
}

/** Собирает корректный 44-байтный WAV-заголовок для куска PCM. */
function buildWavHeader({ sampleRate, channels, bitsPerSample, dataLength }) {
  const header = Buffer.alloc(WAV_HEADER_SIZE);
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataLength, 4); // размер файла минус первые 8 байт
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // размер fmt-чанка для PCM
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataLength, 40);

  return header;
}

/**
 * Вырезает [startSec, endSec) как самостоятельный валидный WAV.
 * Границы выравниваются по целым фреймам — иначе сдвиг на полсэмпла
 * превращает 16-битный PCM в шум.
 */
export function sliceWav(buffer, startSec, endSec) {
  const info = parseWavHeader(buffer);
  if (!info) return null;

  const { sampleRate, channels, bitsPerSample, bytesPerFrame, dataOffset, dataLength } = info;

  const clampedStart = Math.max(0, startSec);
  const clampedEnd = Math.min(info.durationSec, endSec);
  if (clampedEnd <= clampedStart) return null;

  const startFrame = Math.floor(clampedStart * sampleRate);
  const endFrame = Math.floor(clampedEnd * sampleRate);

  const byteStart = dataOffset + startFrame * bytesPerFrame;
  const byteEnd = Math.min(dataOffset + endFrame * bytesPerFrame, dataOffset + dataLength);
  if (byteEnd <= byteStart) return null;

  const pcm = buffer.subarray(byteStart, byteEnd);
  const header = buildWavHeader({
    sampleRate,
    channels,
    bitsPerSample,
    dataLength: pcm.length,
  });

  return Buffer.concat([header, pcm]);
}

/**
 * Режет запись на чанки не длиннее maxChunkSec с перекрытием overlapSec.
 *
 * Перекрытие обязательно: на стыке чанков модель теряет контекст и почти
 * всегда ошибается в границе реплики. Общий кусок даёт материал для сшивки.
 *
 * @returns {Array<{buffer: Buffer, startSec: number, endSec: number, index: number}>}
 */
export function chunkWav(buffer, { maxChunkSec = 600, overlapSec = 10 } = {}) {
  const info = parseWavHeader(buffer);
  if (!info) return null;

  if (info.durationSec <= maxChunkSec) {
    return [{ buffer, startSec: 0, endSec: info.durationSec, index: 0 }];
  }

  const stride = maxChunkSec - overlapSec;
  if (stride <= 0) throw new Error("overlapSec must be smaller than maxChunkSec");

  const chunks = [];
  let index = 0;

  for (let start = 0; start < info.durationSec; start += stride) {
    const end = Math.min(start + maxChunkSec, info.durationSec);
    const chunkBuffer = sliceWav(buffer, start, end);
    if (chunkBuffer) {
      chunks.push({ buffer: chunkBuffer, startSec: start, endSec: end, index: index++ });
    }
    if (end >= info.durationSec) break;
  }

  return chunks;
}

/**
 * Сшивает сегменты, полученные из разных чанков, в единую разметку.
 *
 * Две задачи:
 *   1. Сдвинуть тайминги чанка в абсолютное время записи.
 *   2. Согласовать имена спикеров между чанками. Диаризаторы нумеруют
 *      спикеров независимо в каждом запуске, поэтому SPEAKER_00 из второго
 *      чанка — вообще не тот человек, что SPEAKER_00 из первого. Сопоставляем
 *      по перекрытию в общей зоне: кто с кем звучал одновременно, тот и он же.
 *
 * Это эвристика, а не полноценная кластеризация эмбеддингов: она надёжна,
 * когда в зоне перекрытия говорят, и деградирует в тишине. Для честного
 * сравнения бэкендов этого достаточно; для прода лучше не резать вовсе
 * (self-hosted сервис лимита не имеет).
 */
export function stitchChunkedSegments(chunkResults, { overlapSec = 10 } = {}) {
  if (!Array.isArray(chunkResults) || chunkResults.length === 0) return [];

  const sorted = [...chunkResults].sort((a, b) => a.startSec - b.startSec);
  const out = [];
  /** @type {Map<string,string>} канонические имена спикеров предыдущего чанка */
  let previousCanonical = new Map();
  let nextSpeakerNumber = 0;

  for (let i = 0; i < sorted.length; i++) {
    const { segments, startSec } = sorted[i];
    if (!Array.isArray(segments)) continue;

    // Перевод в абсолютное время.
    const absolute = segments.map((s) => ({
      speaker: s.speaker,
      start: s.start + startSec,
      stop: s.stop + startSec,
    }));

    if (i === 0) {
      const mapping = new Map();
      for (const seg of absolute) {
        if (!mapping.has(seg.speaker)) {
          mapping.set(seg.speaker, `SPEAKER_${String(nextSpeakerNumber++).padStart(2, "0")}`);
        }
      }
      previousCanonical = mapping;
      out.push(...absolute.map((s) => ({ ...s, speaker: mapping.get(s.speaker) })));
      continue;
    }

    const overlapStart = startSec;
    const overlapEnd = startSec + overlapSec;

    // Сколько времени каждый локальный спикер делит с каждым уже известным.
    const affinity = new Map();
    for (const seg of absolute) {
      if (seg.start >= overlapEnd) continue;
      for (const prior of out) {
        if (prior.stop <= overlapStart) continue;
        const lo = Math.max(seg.start, prior.start, overlapStart);
        const hi = Math.min(seg.stop, prior.stop, overlapEnd);
        if (hi <= lo) continue;
        const key = `${seg.speaker} ${prior.speaker}`;
        affinity.set(key, (affinity.get(key) ?? 0) + (hi - lo));
      }
    }

    // Жадное сопоставление: сначала самые уверенные пары.
    const ranked = [...affinity.entries()].sort((a, b) => b[1] - a[1]);
    const mapping = new Map();
    const claimed = new Set();

    for (const [key] of ranked) {
      const [local, canonical] = key.split(" ");
      if (mapping.has(local) || claimed.has(canonical)) continue;
      mapping.set(local, canonical);
      claimed.add(canonical);
    }

    // Локальные спикеры без свидетельств в зоне перекрытия.
    //
    // Наивный вариант — сразу заводить нового участника — систематически
    // плодит фантомов: человек, промолчавший ровно в зоне стыка, получал бы
    // новое имя в каждом чанке, и часовая планёрка «набирала» десяток спикеров.
    //
    // Поэтому сначала пробуем переиспользовать канонические имена предыдущего
    // чанка, ещё не занятые в текущем. Диаризаторы нумеруют спикеров стабильно
    // (обычно по порядку появления), так что совпадение локального имени с
    // прежним — слабый, но полезный сигнал. Только если и это не срабатывает,
    // признаём участника новым.
    for (const seg of absolute) {
      if (mapping.has(seg.speaker)) continue;

      // Единственное допустимое переиспользование: тот же локальный ярлык, что
      // и в прошлом чанке, и он ещё никем не занят. Брать любое свободное имя
      // «наугад» нельзя — так молчавший в стыке участник сливается со случайным
      // соседом, а это хуже лишнего спикера: реплики уходят не тому человеку.
      const priorForSameLocalName = previousCanonical.get(seg.speaker);
      const canonical =
        priorForSameLocalName && !claimed.has(priorForSameLocalName)
          ? priorForSameLocalName
          : `SPEAKER_${String(nextSpeakerNumber++).padStart(2, "0")}`;

      mapping.set(seg.speaker, canonical);
      claimed.add(canonical);
    }

    // В зоне перекрытия сегменты уже есть от предыдущего чанка — не дублируем.
    const fresh = absolute
      .filter((s) => s.start >= overlapEnd)
      .map((s) => ({ ...s, speaker: mapping.get(s.speaker) }));

    out.push(...fresh);
    previousCanonical = mapping;
  }

  return out.sort((a, b) => a.start - b.start || a.stop - b.stop);
}
