/**
 * Постпроцессинг сырого транскрипта от SpeechKit:
 *   1. Удаление мусорных коротких сегментов (<2 слов, скорее всего шум)
 *   2. Склейка подряд идущих реплик одного спикера
 *   3. Коррекция типичных ASR ошибок
 *   4. Реномирование спикеров по talk time (главный говорящий = speaker-1)
 *   5. Подсчёт статистики по каждому спикеру
 */

import { logger } from "../shared/logger.js";

// Типичные ошибки распознавания → корректные слова.
// Только высокоуверенные замены, лучше пропустить чем испортить.
const ASR_CORRECTIONS = new Map([
  ["окей google", ""],          // активация ассистента — мусор
  ["окей гугл", ""],
  ["алиса", ""],
  ["сири", ""],
  ["айфон", ""],
  // Слова которые часто галлюцинирует SpeechKit на шуме
  ["часища", "часть"],
  ["курочки", ""],
  ["порно", ""]
]);

const NOISE_MARKERS = new Set([
  "угу", "ага", "эм", "эээ", "ну", "вот", "это", "так"
]);

/**
 * Удаляет ASR-галлюцинации и слова-паразиты в одиночных сегментах.
 */
function cleanText(text) {
  if (!text) return "";
  let result = text;
  for (const [bad, good] of ASR_CORRECTIONS) {
    const pattern = new RegExp("\\b" + bad.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "gi");
    result = result.replace(pattern, good);
  }
  return result.replace(/\s+/g, " ").trim();
}

/**
 * Проверяет — является ли сегмент мусорным.
 * Мусор: меньше 2 слов И состоит только из маркеров согласия/паразитов.
 */
function isNoiseSegment(text) {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  if (words.length > 3) return false;
  return words.every((w) => NOISE_MARKERS.has(w));
}

/**
 * Объединяет подряд идущие сегменты от одного спикера в один.
 * Сегменты могут разрываться SpeechKit'ом на короткие фразы — склеиваем.
 */
function mergeConsecutive(phrases) {
  const merged = [];
  for (const p of phrases) {
    const last = merged.at(-1);
    if (last && last.speakerId === p.speakerId) {
      last.text = (last.text + " " + p.text).trim();
      last.endTimeMs = p.endTimeMs;
    } else {
      merged.push({ ...p });
    }
  }
  return merged;
}

/**
 * Переименовывает спикеров по убыванию длительности речи.
 * Самый "разговорчивый" становится speaker-1 — обычно это организатор встречи.
 */
function relabelByTalkTime(phrases) {
  const wordsByOriginalId = new Map();
  for (const p of phrases) {
    const wc = p.text.split(/\s+/).filter(Boolean).length;
    wordsByOriginalId.set(p.speakerId, (wordsByOriginalId.get(p.speakerId) || 0) + wc);
  }

  // сортируем по убыванию word count
  const sorted = [...wordsByOriginalId.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);

  // строим маппинг старый → новый
  const remap = new Map();
  sorted.forEach((oldId, idx) => {
    remap.set(oldId, {
      newId: `speaker-${idx + 1}`,
      newLabel: `Спикер ${idx + 1}`
    });
  });

  return phrases.map((p) => {
    const r = remap.get(p.speakerId);
    return {
      ...p,
      speakerId: r.newId,
      speakerLabel: r.newLabel,
      originalSpeakerId: p.speakerId
    };
  });
}

/**
 * Считает статистику по каждому спикеру: длительность речи, кол-во слов, кол-во реплик.
 */
function computeSpeakerStats(phrases) {
  const stats = new Map();
  for (const p of phrases) {
    const id = p.speakerId;
    const cur = stats.get(id) || {
      speakerId: id,
      speakerLabel: p.speakerLabel,
      utterances: 0,
      words: 0,
      durationMs: 0
    };
    cur.utterances += 1;
    cur.words += p.text.split(/\s+/).filter(Boolean).length;
    cur.durationMs += Math.max(0, (p.endTimeMs ?? 0) - (p.startTimeMs ?? 0));
    stats.set(id, cur);
  }
  return [...stats.values()];
}

/**
 * Главная функция: принимает сырой transcript от SpeechKit,
 * возвращает обогащённый transcript с postprocessing.
 *
 * Контракт входного transcript:
 *   { phrases: [{ speakerId, speakerLabel, text, startTimeMs, endTimeMs }], rawText, ... }
 */
export function postprocessTranscript(transcript, options = {}) {
  // Минимально-инвазивная фильтрация — мы не должны "терять" фрагменты речи.
  // Делаем только: чистка явных ассистент-команд + склейка по спикерам.
  const { minWordsPerSegment = 1, keepNoiseMarkers = true } = options;

  const before = transcript.phrases?.length ?? 0;

  // 1. Чистим текст и фильтруем мусор
  let phrases = (transcript.phrases ?? [])
    .map((p) => ({ ...p, text: cleanText(p.text) }))
    .filter((p) => p.text && p.text.length > 0)
    .filter((p) => keepNoiseMarkers || !isNoiseSegment(p.text))
    .filter((p) => p.text.split(/\s+/).filter(Boolean).length >= minWordsPerSegment);

  // 2. Склеиваем подряд идущие реплики одного спикера
  phrases = mergeConsecutive(phrases);

  // 3. Переименовываем спикеров по talk time
  phrases = relabelByTalkTime(phrases);

  // 4. Снова склеиваем — после relabel могут появиться новые consecutive
  phrases = mergeConsecutive(phrases);

  // 5. Пересобираем rawText
  const rawText = phrases
    .map((p) => `${p.speakerLabel}: ${p.text}`)
    .join("\n");

  // 6. Статистика
  const speakerStats = computeSpeakerStats(phrases);

  logger.info("Transcript postprocessing", {
    segmentsBefore: before,
    segmentsAfter: phrases.length,
    speakers: speakerStats.length,
    totalWords: speakerStats.reduce((s, x) => s + x.words, 0)
  });

  return {
    ...transcript,
    rawText,
    phrases,
    speakerStats,
    postprocessedAt: new Date().toISOString()
  };
}
