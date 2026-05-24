/**
 * Audio preprocessing pipeline для записей с диктофона/телефона.
 * Все операции работают с Float32Array PCM-сэмплами.
 *
 * Пайплайн:
 *   decode → mono → resample(16kHz) → highPass(80Hz) → normalize → noiseGate → vadTrim
 */

const TARGET_SAMPLE_RATE = 16_000; // SpeechKit оптимум
const HIGH_PASS_HZ = 60;            // мягче — отрезаем только глубокий рокот
const TARGET_RMS = 0.08;            // ~-22 dBFS — без агрессивного буста
const NOISE_GATE_DB = -55;          // консервативно: давим только реально тихие участки
const NOISE_GATE_ATTACK_MS = 10;
const NOISE_GATE_RELEASE_MS = 150;  // длиннее release — не режет хвосты слов

function dbToLinear(db) {
  return Math.pow(10, db / 20);
}

function linearToDb(linear) {
  return 20 * Math.log10(Math.max(1e-10, linear));
}

/**
 * Сводит многоканальное аудио в моно усреднением каналов.
 */
function toMono(audioBuffer) {
  if (audioBuffer.numberOfChannels === 1) {
    return audioBuffer.getChannelData(0).slice();
  }

  const length = audioBuffer.length;
  const result = new Float32Array(length);
  const channels = audioBuffer.numberOfChannels;

  for (let ch = 0; ch < channels; ch++) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      result[i] += data[i];
    }
  }

  for (let i = 0; i < length; i++) {
    result[i] /= channels;
  }

  return result;
}

/**
 * Линейный ресемплинг (быстрый, для речи качества хватает).
 */
function resample(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;

  const ratio = fromRate / toRate;
  const newLength = Math.floor(samples.length / ratio);
  const result = new Float32Array(newLength);

  for (let i = 0; i < newLength; i++) {
    const srcIndex = i * ratio;
    const idx = Math.floor(srcIndex);
    const frac = srcIndex - idx;
    const a = samples[idx] ?? 0;
    const b = samples[idx + 1] ?? a;
    result[i] = a + (b - a) * frac;
  }

  return result;
}

/**
 * Однопроходный biquad high-pass filter.
 * Отсекает компоненты ниже cutoff (рокот, гул вентилятора, дыхание).
 */
function highPassFilter(samples, sampleRate, cutoffHz) {
  const omega = 2 * Math.PI * cutoffHz / sampleRate;
  const sinOmega = Math.sin(omega);
  const cosOmega = Math.cos(omega);
  const Q = 0.707;
  const alpha = sinOmega / (2 * Q);

  const b0 = (1 + cosOmega) / 2;
  const b1 = -(1 + cosOmega);
  const b2 = (1 + cosOmega) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosOmega;
  const a2 = 1 - alpha;

  const result = new Float32Array(samples.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;

  for (let i = 0; i < samples.length; i++) {
    const x0 = samples[i];
    const y0 = (b0 / a0) * x0 + (b1 / a0) * x1 + (b2 / a0) * x2
             - (a1 / a0) * y1 - (a2 / a0) * y2;
    result[i] = y0;
    x2 = x1; x1 = x0;
    y2 = y1; y1 = y0;
  }

  return result;
}

/**
 * Нормализация по RMS — выравнивает среднюю громкость к целевому уровню.
 * Безопаснее peak normalization для речи.
 */
function normalizeRms(samples, targetRms) {
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) {
    sumSquares += samples[i] * samples[i];
  }
  const currentRms = Math.sqrt(sumSquares / samples.length);
  if (currentRms < 1e-6) return samples; // тишина

  const gain = targetRms / currentRms;
  const safeGain = Math.min(gain, 8); // не больше +18 dB

  const result = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] * safeGain;
    result[i] = Math.max(-1, Math.min(1, v));
  }
  return result;
}

/**
 * Noise gate с attack/release envelope.
 * Подавляет участки тише threshold, оставляя речь нетронутой.
 */
function noiseGate(samples, sampleRate, thresholdDb, attackMs, releaseMs) {
  const threshold = dbToLinear(thresholdDb);
  const attackCoef = Math.exp(-1 / ((attackMs / 1000) * sampleRate));
  const releaseCoef = Math.exp(-1 / ((releaseMs / 1000) * sampleRate));

  const result = new Float32Array(samples.length);
  let envelope = 0;
  let gateOpen = 0;

  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i]);
    envelope = abs > envelope
      ? attackCoef * envelope + (1 - attackCoef) * abs
      : releaseCoef * envelope + (1 - releaseCoef) * abs;

    const targetGain = envelope > threshold ? 1 : 0;
    gateOpen = targetGain > gateOpen
      ? attackCoef * gateOpen + (1 - attackCoef) * targetGain
      : releaseCoef * gateOpen + (1 - releaseCoef) * targetGain;

    result[i] = samples[i] * gateOpen;
  }

  return result;
}

/**
 * VAD-based silence trimming.
 * Считает RMS на кадрах VAD_FRAME_MS, склеивает речевые сегменты,
 * удаляет паузы длиннее maxSilenceMs (оставляя 200ms padding).
 */
function vadTrim(samples, sampleRate, silenceThresholdDb, maxSilenceMs) {
  const frameSamples = Math.floor((VAD_FRAME_MS / 1000) * sampleRate);
  const maxSilenceFrames = Math.floor(maxSilenceMs / VAD_FRAME_MS);
  const paddingFrames = Math.floor(200 / VAD_FRAME_MS);
  const threshold = dbToLinear(silenceThresholdDb);

  // 1) для каждого фрейма считаем — речь или тишина
  const frames = [];
  for (let i = 0; i < samples.length; i += frameSamples) {
    let sumSquares = 0;
    const end = Math.min(i + frameSamples, samples.length);
    for (let j = i; j < end; j++) {
      sumSquares += samples[j] * samples[j];
    }
    const rms = Math.sqrt(sumSquares / (end - i));
    frames.push({ start: i, end, isVoice: rms > threshold });
  }

  // 2) расширяем VOICE кадры на padding с обеих сторон
  const keep = new Array(frames.length).fill(false);
  for (let i = 0; i < frames.length; i++) {
    if (frames[i].isVoice) {
      const lo = Math.max(0, i - paddingFrames);
      const hi = Math.min(frames.length - 1, i + paddingFrames);
      for (let k = lo; k <= hi; k++) keep[k] = true;
    }
  }

  // 3) если подряд keep=false дольше maxSilenceFrames — выбрасываем
  // (но не больше — короткие паузы между фразами оставляем)
  const result = [];
  let silenceRun = 0;
  for (let i = 0; i < frames.length; i++) {
    if (keep[i]) {
      silenceRun = 0;
      const f = frames[i];
      for (let j = f.start; j < f.end; j++) result.push(samples[j]);
    } else {
      silenceRun++;
      if (silenceRun <= maxSilenceFrames) {
        const f = frames[i];
        for (let j = f.start; j < f.end; j++) result.push(samples[j]);
      }
    }
  }

  return new Float32Array(result);
}

/**
 * Кодирует Float32 моно в WAV PCM 16-bit.
 */
function encodeWavMono(samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeStr = (off, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  };

  writeStr(0, "RIFF"); view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, "WAVE"); writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);        // PCM
  view.setUint16(22, 1, true);        // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data"); view.setUint32(40, dataBytes, true);

  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    off += 2;
  }
  return buffer;
}

/**
 * Главная функция — берёт File, возвращает обработанный File (WAV 16kHz mono).
 * Все шаги логируются для отладки.
 *
 * onProgress(stage, percent) — опциональный callback для UI.
 */
export async function preprocessAudio(file, onProgress) {
  // ВАЖНО: убрали VAD trim — он может удалить участки которые SpeechKit бы распознал.
  // SpeechKit умеет сам разбивать на фразы по паузам. Наша задача — нормализовать
  // громкость и убрать низкочастотный шум, не более того.
  const stages = ["decode", "mono", "resample", "highpass", "normalize", "gate", "encode"];
  let stageIdx = 0;
  const tick = (label) => {
    stageIdx++;
    onProgress?.(label, Math.round((stageIdx / stages.length) * 100));
  };

  const arrayBuffer = await file.arrayBuffer();
  const audioCtx = new AudioContext();
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  const originalSampleRate = audioBuffer.sampleRate;
  audioCtx.close();
  tick("Декодирование");

  let samples = toMono(audioBuffer);
  tick("Сведение в моно");

  samples = resample(samples, originalSampleRate, TARGET_SAMPLE_RATE);
  tick("Ресемплинг 16kHz");

  samples = highPassFilter(samples, TARGET_SAMPLE_RATE, HIGH_PASS_HZ);
  tick("Фильтр низких частот");

  samples = normalizeRms(samples, TARGET_RMS);
  tick("Нормализация громкости");

  samples = noiseGate(samples, TARGET_SAMPLE_RATE, NOISE_GATE_DB,
    NOISE_GATE_ATTACK_MS, NOISE_GATE_RELEASE_MS);
  tick("Подавление фонового шума");

  const wavBuffer = encodeWavMono(samples, TARGET_SAMPLE_RATE);
  tick("Кодирование WAV");

  const baseName = file.name.replace(/\.[^.]+$/, "");
  return new File([wavBuffer], baseName + ".processed.wav", { type: "audio/wav" });
}
