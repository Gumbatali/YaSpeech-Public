/**
 * Анализатор качества аудио.
 * Не делает decisions, просто отдаёт метрики и оценку quality:
 *   "good" — пайплайн справится
 *   "fair" — попробуем, но может быть хуже
 *   "poor" — стоит предупредить юзера ДО загрузки
 */

const SILENCE_THRESHOLD = 0.005;
const CLIPPING_THRESHOLD = 0.98;

function analyseSamples(samples) {
  let sumSquares = 0;
  let peak = 0;
  let clippingCount = 0;
  let silentSamples = 0;

  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i]);
    sumSquares += abs * abs;
    if (abs > peak) peak = abs;
    if (abs > CLIPPING_THRESHOLD) clippingCount++;
    if (abs < SILENCE_THRESHOLD) silentSamples++;
  }

  return {
    rms: Math.sqrt(sumSquares / samples.length),
    peak,
    clippingRatio: clippingCount / samples.length,
    silenceRatio: silentSamples / samples.length
  };
}

/**
 * Грубая оценка SNR: peak / median noise level.
 * Считаем нижний 20-й процентиль амплитуды как уровень шума.
 */
function estimateSnr(samples) {
  const abs = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) abs[i] = Math.abs(samples[i]);
  const sorted = abs.slice().sort();
  const noiseLevel = sorted[Math.floor(sorted.length * 0.2)] || 1e-6;
  const signalLevel = sorted[Math.floor(sorted.length * 0.95)] || 1e-6;
  return 20 * Math.log10(signalLevel / noiseLevel);
}

export async function analyzeAudioQuality(file) {
  const arrayBuffer = await file.arrayBuffer();
  const audioCtx = new AudioContext();
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  audioCtx.close();

  // Используем первый канал — достаточно для метрик
  const samples = audioBuffer.getChannelData(0);
  const stats = analyseSamples(samples);
  const snrDb = estimateSnr(samples);
  const durationSeconds = audioBuffer.duration;

  // Quality scoring
  const issues = [];
  if (stats.clippingRatio > 0.001) issues.push("clipping");
  if (stats.silenceRatio > 0.8) issues.push("mostly_silent");
  if (snrDb < 10) issues.push("low_snr");
  if (durationSeconds < 5) issues.push("too_short");
  if (stats.peak < 0.05) issues.push("too_quiet");

  let quality = "good";
  if (issues.length >= 2 || issues.includes("low_snr")) quality = "fair";
  if (issues.length >= 3 || issues.includes("mostly_silent") ||
      issues.includes("too_quiet")) quality = "poor";

  return {
    durationSeconds,
    sampleRate: audioBuffer.sampleRate,
    numChannels: audioBuffer.numberOfChannels,
    peakAmplitude: stats.peak,
    rmsLevel: stats.rms,
    snrDb: Math.round(snrDb * 10) / 10,
    clippingRatio: stats.clippingRatio,
    silenceRatio: stats.silenceRatio,
    quality,
    issues
  };
}

export function describeQuality(report) {
  const labels = {
    clipping: "обрезано (перегружено по громкости)",
    mostly_silent: "большая часть — тишина",
    low_snr: "много фонового шума",
    too_short: "слишком короткая запись",
    too_quiet: "запись слишком тихая"
  };
  const lines = [
    `Длительность: ${Math.round(report.durationSeconds)} сек`,
    `SNR: ~${report.snrDb} дБ`,
    `Качество: ${report.quality}`
  ];
  if (report.issues.length) {
    lines.push("Проблемы: " + report.issues.map((i) => labels[i] || i).join(", "));
  }
  return lines.join(" · ");
}
