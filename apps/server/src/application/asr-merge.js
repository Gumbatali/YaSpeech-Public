/**
 * Слияние транскриптов от параллельно распознанных чанков одной записи
 * (см. meeting-pipeline-service.js — большие записи режутся на куски и
 * распознаются одновременно, а не по очереди, см. audio-splitting.js).
 *
 * ВАЖНО про спикеров: диаризация SpeechKit (channelTag) — ML-кластеризация
 * ЛОКАЛЬНАЯ для каждого запроса на распознавание. Если один и тот же
 * человек говорит и в чанке 1, и в чанке 2, SpeechKit НЕ гарантирует, что
 * присвоит ему тот же channelTag в обоих запросах — это два независимых
 * запуска диаризации. Поэтому здесь спикеры НЕ пытаются сопоставляться
 * между чанками (это потребовало бы голосовых отпечатков — вне охвата):
 * нумерация продолжается сквозным счётчиком по границам чанков, чтобы
 * НЕ склеить случайно двух разных людей под одним "Спикер N". Один и тот
 * же реальный человек в разных чанках может получить разные номера —
 * честный компромисс, а не ложная точность. Имена по контексту (кнопка
 * «Улучшить с помощью ИИ» → identifySpeakers) реконструируют личность
 * по содержанию речи независимо от этой нумерации.
 */

/**
 * @param {Array<{ offsetSeconds: number, transcript: { phrases: Array, rawText?: string, jobId?: string, meetingId?: string } }>} chunkResults
 * @returns {{ jobId: string|null, meetingId: string|null, rawText: string, phrases: Array, generatedAt: string, mergedFromChunks: number }}
 */
export function mergeChunkTranscripts(chunkResults) {
  const sorted = [...chunkResults].sort((a, b) => a.offsetSeconds - b.offsetSeconds);

  let nextGlobalIndex = 1;
  const mergedPhrases = [];

  for (const { offsetSeconds, transcript } of sorted) {
    const localToGlobal = new Map();

    for (const phrase of transcript?.phrases ?? []) {
      if (!localToGlobal.has(phrase.speakerId)) {
        localToGlobal.set(phrase.speakerId, nextGlobalIndex++);
      }
      const globalIndex = localToGlobal.get(phrase.speakerId);
      const offsetMs = offsetSeconds * 1000;

      mergedPhrases.push({
        ...phrase,
        speakerId: `speaker-${globalIndex}`,
        speakerLabel: `Спикер ${globalIndex}`,
        startTimeMs: (phrase.startTimeMs ?? 0) + offsetMs,
        endTimeMs: (phrase.endTimeMs ?? 0) + offsetMs
      });
    }
  }

  const rawText = mergedPhrases.map((p) => `${p.speakerLabel}: ${p.text}`).join("\n");
  const first = sorted[0]?.transcript;

  return {
    jobId: first?.jobId ?? null,
    meetingId: first?.meetingId ?? null,
    rawText,
    phrases: mergedPhrases,
    generatedAt: new Date().toISOString(),
    mergedFromChunks: sorted.length
  };
}
