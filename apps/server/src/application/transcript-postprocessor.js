/**
 * Постпроцессинг сырого транскрипта от SpeechKit:
 *   1. Восстановление пунктуации по паузам между словами (без LLM)
 *   2. Коррекция ASR-галлюцинаций, удаление слов-паразитов, схлопывание
 *      повторов ("да, да, да" → "да") — тоже без LLM
 *   3. Удаление мусорных коротких сегментов (<2 слов, скорее всего шум)
 *   4. Склейка подряд идущих реплик одного спикера
 *   5. Реномирование спикеров по talk time (главный говорящий = speaker-1)
 *   6. Подсчёт статистики по каждому спикеру
 */

import { logger } from "../shared/logger.js";
import { removeFillerWords, collapseRepeatedWords } from "./filler-words.js";
import { punctuateByPauses } from "./punctuation-by-pauses.js";

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
 * Удаляет ASR-галлюцинации в одиночных сегментах.
 *
 * ВАЖНО: \b в JS regex построен на \w, а \w НЕ включает кириллицу — "\bалиса\b"
 * никогда не совпадёт с русским словом (граница слова вокруг кириллических
 * букв просто не возникает). Раньше это тихо ломало все замены здесь.
 * Используем lookaround на "не-букву" вместо \b (см. также filler-words.js,
 * где та же проблема встречалась и была исправлена так же).
 */
function cleanText(text) {
  if (!text) return "";
  let result = text;
  for (const [bad, good] of ASR_CORRECTIONS) {
    const escaped = bad.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?<=^|[^a-zа-яё])${escaped}(?=[^a-zа-яё]|$)`, "gi");
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

  // 1. Пунктуация по паузам между словами — ДО чистки текста и склейки фраз:
  // word-level тайминги известны только внутри одной ещё не склеенной фразы
  // (после mergeConsecutive текст разных фраз/пауз между ними уже неотличим
  // от пауз внутри одной фразы). Если слов с таймингами нет (fallback, старый
  // SpeechKit v2 без per-word timestamps) — punctuateByPauses вернёт "" и
  // используем исходный текст без пунктуации как раньше.
  let phrases = (transcript.phrases ?? []).map((p) => {
    const punctuated = punctuateByPauses(p.words);
    return { ...p, text: punctuated || p.text };
  });

  // 2. Чистим текст: ASR-галлюцинации → слова-паразиты/междометия → повторы
  phrases = phrases
    .map((p) => ({ ...p, text: collapseRepeatedWords(removeFillerWords(cleanText(p.text))) }))
    .filter((p) => p.text && p.text.length > 0)
    .filter((p) => keepNoiseMarkers || !isNoiseSegment(p.text))
    .filter((p) => p.text.split(/\s+/).filter(Boolean).length >= minWordsPerSegment);

  // 3. Склеиваем подряд идущие реплики одного спикера
  phrases = mergeConsecutive(phrases);

  // 4. Переименовываем спикеров по talk time
  phrases = relabelByTalkTime(phrases);

  // 5. Снова склеиваем — после relabel могут появиться новые consecutive
  phrases = mergeConsecutive(phrases);

  // 6. Пересобираем rawText
  const rawText = phrases
    .map((p) => `${p.speakerLabel}: ${p.text}`)
    .join("\n");

  // 7. Статистика
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
