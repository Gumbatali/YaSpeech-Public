/**
 * YandexGPT Gateway — LLM-вызовы поверх Lite-модели.
 *
 * ВСЕ вызовы инициируются действиями пользователя (решение 2026-06-10):
 *   Кнопка «Улучшить с помощью ИИ» → analyzeContext, diarizeTranscript,
 *     extractGlossary, refineLines×N, identifySpeakers
 *   Кнопка «Собрать протокол» → extractProtocol (+map-reduce для длинных),
 *     qaProtocol (только при fair/poor)
 *
 * Автоматических LLM-вызовов в пайплайне нет.
 */

import { YandexGptClient } from "./llm/yandex-gpt-client.js";
import {
  promptDiarization,
  promptGlossary,
  promptContextAnalysis,
  promptSpeakerIdentification,
  promptProtocolExtraction,
  promptProtocolReduce,
  promptFaithfulnessCheck,
  promptCompletenessCheck,
  promptTranscriptRefine
} from "./llm/prompts.js";
import { parseRefinedLines, extractAddressedNames } from "../application/transcription/refiner.js";
import { logger } from "../shared/logger.js";

const MAX_TRANSCRIPT_CHARS = 22_000;

// GPT иногда вместо пустого массива возвращает заглушку вроде "null" или
// текстовый вариант того же самого ("нет решений", "не указано") — эти
// функции чистят такой мусор, а не только гарантируют наличие поля.
// Осознанно НЕ ловим "не" в середине содержательного текста ("не согласовано
// техзадание") — только фразы-заглушки целиком, начинающиеся с отрицания.
// Без \b после кириллических групп — в JS \w не включает кириллицу, поэтому
// \b на границе "слово на -о" + пробел не сработал бы (проверено на кейсе
// "не указано").
const JUNK_STRING_PATTERN = /^(null|нет(\s.*)?|не\s+(было|указано|определено|найдено|заданы?).*|отсутствует.*)$/;

export function isJunkString(value) {
  if (typeof value !== "string") return true;
  const normalized = value.trim().toLowerCase();
  return normalized === "" || JUNK_STRING_PATTERN.test(normalized);
}

export function sanitizeStringArray(arr) {
  return (Array.isArray(arr) ? arr : []).filter((v) => !isJunkString(v));
}

// Снимает обёртку ```json ... ``` — GPT иногда её добавляет, иногда нет.
function stripJsonFence(raw) {
  return raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
}

// Промпт C-reduce просит модель убрать дубли решений/задач сама ("одно и то
// же может быть сформулировано по-разному"), но lite-модель это не всегда
// соблюдает — детерминированный бэкстоп поверх символьного сходства текста,
// а не точного префикса (точный префикс не ловит "Завершение работы..." vs
// "Завершить работу..." — один и тот же смысл, разное начало).
// Символьные триграммы + коэффициент Дайса вместо стемминга целых слов.
// Предыдущий подход (обрезка префикса/суффикса + словарь чередований корня
// -ня-/-йм-/-ним-) регулярно давал ложные "разные слова" на обычных падежных
// окончаниях, которые не покрывал ни один из hand-written паттернов —
// например "панелями"/"панели" обрезались в "панеля"/"панели", то есть
// оставались разными токенами, и реальный дубль задачи не ловился (ratio
// 0.667 при пороге 0.7). Триграммы устойчивы к произвольному изменению
// окончания слова само по себе, без необходимости перечислять конкретные
// классы словоизменения — не нужен собственный стеммер под русскую
// морфологию. Проверено на 6 реальных парах (3 дубля + 3 явно разных
// задачи, некоторые нарочно похожей структуры "Связаться с X") — 3/3
// дублей поймано, 0/3 ложных слияний на порогах 0.5–0.7 разом (см.
// research/diarization-asr-lab/FINDINGS.md, раздел про дедуп).
function significantWords(text) {
  // String(), не (text ?? "") — GPT иногда кладёт не строку туда, где схема
  // просит строку (тот же класс бага, что и suggestedRemovals ниже);
  // String() безопасно приводит что угодно, (text ?? "") падал на не-null
  // не-строках
  const s = String(text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const grams = new Set();
  for (let i = 0; i <= s.length - 3; i++) grams.add(s.slice(i, i + 3));
  return grams;
}

// Коэффициент Дайса (2×общее / сумма размеров) — не то же самое, что
// overlap/min(|A|,|B|) у прежней версии: не даёт короткой строке-подстроке
// автоматически проходить порог только за счёт малого знаменателя.
function wordOverlapRatio(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const g of a) if (b.has(g)) shared++;
  return (2 * shared) / (a.size + b.size);
}

const NEAR_DUP_THRESHOLD = 0.6;

export function dedupeSimilarStrings(items, threshold = NEAR_DUP_THRESHOLD) {
  const kept = [];
  const keptWords = [];
  for (const item of items) {
    const words = significantWords(item);
    const isDup = keptWords.some((kw) => wordOverlapRatio(kw, words) >= threshold);
    if (!isDup) { kept.push(item); keptWords.push(words); }
  }
  return kept;
}

// decisions и actionItems дедуплицируются каждый сам с собой, но не друг
// с другом — модель нередко кладёт личное обязательство ("Займусь
// Рыбинском") и в decisions (без owner — там его негде хранить), и в
// actionItems тем же текстом с owner. Итог: то же решение "теряет" имя,
// которое всё это время было в actionItems. Решение реального содержания
// без совпадающей задачи остаётся как есть.
export function dropDecisionsOverlappingTasks(decisions, actionItems, threshold = NEAR_DUP_THRESHOLD) {
  const taskWords = (actionItems ?? []).map((a) => significantWords(a.task));
  return (decisions ?? []).filter((d) => {
    const words = significantWords(d);
    return !taskWords.some((tw) => wordOverlapRatio(tw, words) >= threshold);
  });
}

// Строит функцию, приводящую и сырую метку диаризации ("Спикер 01"), и уже
// разрешённое имя ("Семён") к одному каноническому виду — иначе дедуп по
// owner/speaker считает их разными людьми, если разные сэмплы/куски выбрали
// разное написание одного и того же человека.
export function buildSpeakerResolver(speakers) {
  const byLabel = new Map((speakers ?? []).map((s) => [s.label, s.guessedName || s.label]));
  return (value) => byLabel.get(value) ?? value;
}

function isResolvedName(name, resolvedNames) {
  if (!name) return false;
  const words = significantWords(name);
  return resolvedNames.some((rn) => wordOverlapRatio(significantWords(rn), words) >= NEAR_DUP_THRESHOLD);
}

// C1 (extractProtocol) формирует participants отдельным независимым
// вызовом по тексту — не привязан к тому, кого B2 реально сопоставил с
// диаризационной меткой. Итог: сторонние контакты, упомянутые в разговоре
// ("мониторит Романов"), попадают в participants наравне с реально
// говорившими. Фикс: participants/owner сверяются с guessedName из B2 —
// единственным источником "кто реально говорил в ЭТОЙ записи" (в отличие
// от project.team, который про "кто вообще на проекте", не про факт речи
// в конкретной встрече). Если B2 не разрешил НИКОГО и не дал ни одной
// метки — фильтр не применяем, опоры для решения нет, доверяем C1 как есть.
//
// Важно: "не резолвлен по имени" ≠ "выдуман". Если C1 честно приписал
// задачу сырой метке ("Спикер 3" — B2 не смог подобрать имя, но это
// реальный говоривший), это НЕ то же самое, что несуществующий человек
// ("Романов" — упомянут третьим лицом, вообще не сопоставлен ни с одной
// меткой). Раньше оба случая схлопывались в generic "Команда" — задача
// конкретного, просто неопознанного, человека теряла эту специфику.
// Сырые метки из speakers[].label сохраняются как есть, а не заменяются
// на "Команда".
export function reconcileParticipants(protocol, speakers) {
  if (!speakers?.length) return protocol;

  const resolvedNames = speakers.map((s) => s.guessedName).filter(Boolean);
  const rawLabels = new Set(speakers.map((s) => s.label));
  const isGrounded = (value) => isResolvedName(value, resolvedNames) || rawLabels.has(value);

  const participants = (protocol.participants ?? []).filter((p) => isGrounded(p));
  const actionItems = (protocol.actionItems ?? []).map((a) =>
    a.owner && a.owner !== "Команда" && !isGrounded(a.owner)
      ? { ...a, owner: "Команда" }
      : a
  );
  return { ...protocol, participants, actionItems };
}

// ё/е — не опечатка, а два разных code point в JS-строке: если разные
// ensemble-сэмплы (или разные B2-голоса) пишут одно и то же имя то с ё,
// то без ("Семён"/"Семен"), точное сравнение owner/speaker никогда их не
// схлопнёт — найдено на реальном прогоне (встреча 3, --b2-votes 7:
// "Спикер 2=Семён (5/6)" и "Спикер 4=Семен (1/6)" — та же коллизия имён,
// что чинит конфликт-резолвер в preview-protocol.mjs, только здесь на
// уровне owner/speaker-сравнения при дедупе, а не на уровне B2-голосования).
function nameKey(name) {
  return name === null || name === undefined ? name : String(name).toLowerCase().replace(/ё/g, "е");
}

export function dedupeSimilarTasks(items, threshold = NEAR_DUP_THRESHOLD, resolveOwner = (x) => x) {
  const kept = [];
  const keptWords = [];
  for (const item of items) {
    const words = significantWords(item.task);
    // resolveOwner раньше применялся только для сравнения при дедупе —
    // сырая метка (SPEAKER_NN / "Спикер N") утекала в сохранённый item и
    // долетала до финального протокола нерезолвленной (тот же баг, что был
    // в dedupeSimilarHighlights).
    const owner = resolveOwner(item.owner ?? null);
    const isDup = kept.some((k, i) => nameKey(k.owner) === nameKey(owner) && wordOverlapRatio(keptWords[i], words) >= threshold);
    if (!isDup) { kept.push({ ...item, owner }); keptWords.push(words); }
  }
  return kept;
}

// Второй, более дорогой проход поверх dedupeSimilarTasks — для пар, которые
// автодедуп НЕ схлопнул (ratio ниже порога), но и не отклонил бы как явно
// разные (ratio выше нижней границы). Найдено на реальном прогоне
// (--c1-samples 9): триграммы снижают число пропущенных дублей, но не
// убирают полностью на большом числе сэмплов с высоким разнообразием
// формулировок ("Разобраться с отчетом по Харьковской 9 и связаться с
// Романовым" дважды, ratio ниже 0.6). Чисто эвристически эту зону выше
// поднимать нельзя без роста ложных слияний (см. FINDINGS.md, раздел про
// дедуп) — вместо этого спорные пары отдаются на прямой вопрос модели
// "это одна и та же задача?", а не более широкому порогу.
const BORDERLINE_LOW_THRESHOLD = 0.3;

export function findBorderlineTaskPairs(items, threshold = NEAR_DUP_THRESHOLD, lowThreshold = BORDERLINE_LOW_THRESHOLD) {
  const wordsCache = items.map((item) => significantWords(item.task));
  const pairs = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (nameKey(items[i].owner ?? null) !== nameKey(items[j].owner ?? null)) continue;
      const score = wordOverlapRatio(wordsCache[i], wordsCache[j]);
      if (score >= lowThreshold && score < threshold) pairs.push({ i, j, score });
    }
  }
  return pairs;
}

// Именованные сущности задачи — топонимы/номера папок (первое слово задачи
// пропускается: почти всегда глагол с большой буквы в начале — "Направить",
// "Подготовить" — не топоним, иначе он бы шумел как ложная "сущность" в
// каждой паре).
function extractTaskEntities(text) {
  const words = String(text ?? "").split(/\s+/).filter(Boolean);
  const entities = new Set();
  for (let i = 1; i < words.length; i++) {
    const w = words[i].replace(/[^\p{L}\p{N}-]/gu, "");
    // Слово-с-Большой-буквы (топоним/название) ИЛИ КАПС-акроним (УКН,
    // МКД, СОШ) — найдено при ревью: исходный паттерн ловил только
    // первый вид, акронимы без сопутствующего номера папки рядом
    // оставались невидимы для детектора.
    if (/^[А-ЯЁ][а-яё]+(-[А-ЯЁ]?[а-яё]+)?$/.test(w)) entities.add(w.toLowerCase());
    else if (/^[А-ЯЁ]{2,}$/.test(w)) entities.add(w.toLowerCase());
    else if (/^\d{2,}$/.test(w)) entities.add(w);
  }
  return entities;
}

// Найдено на реальном прогоне (research/diarization-asr-lab,
// oktyabrskaya-4-merged, --c1-samples 5): один C1-сэмпл пакует несколько
// объектов в одну задачу ("Направить... по Воронежу, Клинцам, Тонской,
// Северо-Задонску, Сокольникам, Донской"), другой сэмпл описывает те же
// объекты как отдельные задачи по одной. Текст "пачки" и текст одной
// гранулярной задачи почти не пересекаются по триграммам (разные слова
// вокруг общего топонима) — findBorderlineTaskPairs такое не ловит ни при
// каком триграммном пороге, это не паРафраз, а расхождение в грануляр-
// ности. Отдельный детектор по пересечению именованных сущностей: если
// МЕНЬШАЯ по числу сущностей задача почти целиком (доля от size меньшего
// множества, не Дайс) содержится в другой — вероятный дубль/поглощение,
// отдаём туда же, на прямой вопрос модели (resolveBorderlinePairsWithLLM
// сравнивает free-form текст, ей всё равно, откуда взялась пара).
export function findEntityOverlapPairs(items, threshold = 0.5) {
  const entityCache = items.map((item) => extractTaskEntities(item.task));
  const pairs = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (nameKey(items[i].owner ?? null) !== nameKey(items[j].owner ?? null)) continue;
      const a = entityCache[i], b = entityCache[j];
      if (a.size === 0 || b.size === 0) continue;
      let shared = 0;
      for (const e of a) if (b.has(e)) shared++;
      if (shared === 0) continue;
      const score = shared / Math.min(a.size, b.size);
      if (score >= threshold) pairs.push({ i, j, score });
    }
  }
  return pairs;
}

// Объединяет кандидатов от обоих детекторов (текстовое сходство +
// пересечение сущностей) в один список без дублей пар — резолвер
// (resolveBorderlinePairsWithLLM) работает с парами одинаково независимо
// от того, каким детектором они найдены.
export function findAllBorderlinePairs(items) {
  const seen = new Set();
  const pairs = [];
  for (const p of [...findBorderlineTaskPairs(items), ...findEntityOverlapPairs(items)]) {
    const key = `${p.i}:${p.j}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push(p);
  }
  return pairs;
}

// completeBatchFn — обычно this.client.completeBatch.bind(this.client) (или
// b2c1Client) — намеренно не завязано на конкретный класс клиента, чтобы
// функцию можно было тестировать с мок-функцией без реального HTTP.
// Сбой LLM (сеть/парсинг) — не мержим наугад, оставляем items как есть,
// лучше видимый дубль, чем случайно потерянная реальная задача.
export async function resolveBorderlinePairsWithLLM(items, pairs, completeBatchFn) {
  if (pairs.length === 0) return items;
  // Обе формулировки в паре — из независимых ensemble-пересказов ОДНОЙ и той
  // же встречи одним и тем же исполнителем (findBorderlineTaskPairs уже
  // отфильтровал по owner) — почти всегда разный текст с одинаковым смыслом,
  // а не две реально разные задачи. Первая версия промпта ("одна и та же
  // задача, даже если слова разные?") была симметрична и слишком легко
  // отвечала "false" на пары вроде "Подготовить защитные документы для
  // Приморского объекта" / "Взять в работу защитные материалы по
  // Приморскому району" — разный глагол при том же районе модель читала
  // как разные шаги, а не пересказ одного и того же поручения. Явно
  // называем объект/номер папки решающим признаком.
  const requests = pairs.map(({ i, j }) => ({
    system: "Ответь только JSON {\"same\": true} или {\"same\": false}. Обе формулировки — независимые пересказы одного и того же поручения одному и тому же человеку с одной встречи, могут отличаться глаголом и уровнем детализации. Считай их ОДНОЙ задачей (true), если речь об одном и том же объекте/документе/районе/номере папки — разный глагол ('подготовить'/'взять в работу'/'заняться'/'сделать') не делает их разными задачами. Считай РАЗНЫМИ (false) только если это явно разные объекты/папки/номера, или если один пункт — логически следующий отдельный шаг после другого (например 'подготовить документ' и отдельно 'отправить готовый документ заказчику').",
    user: `Задача 1: ${items[i].task}\nЗадача 2: ${items[j].task}`,
    options: { temperature: 0, maxTokens: 20 }
  }));

  let responses;
  try {
    responses = await completeBatchFn(requests);
  } catch (e) {
    // Раньше падало тихо — молчаливый no-op выглядел неотличимо от "модель
    // сочла все пары разными", хотя реальная причина почти всегда квота
    // YC на конкурентные сессии при большом числе спорных пар одним
    // Promise.all (см. research/diarization-asr-lab/FINDINGS.md раздел 18/19).
    logger.warn("resolveBorderlinePairsWithLLM: completeBatchFn failed, keeping items unmerged", {
      pairs: pairs.length,
      error: e.message
    });
    return items;
  }

  const toRemove = new Set();
  for (let k = 0; k < pairs.length; k++) {
    const { i, j } = pairs[k];
    if (toRemove.has(i) || toRemove.has(j)) continue; // уже решено по другой паре в этой же группе
    let same = false;
    try {
      same = JSON.parse(stripJsonFence(String(responses[k] ?? ""))).same === true;
    } catch {
      // не распарсилось — трактуем как "не одно и то же", не мержим наугад
    }
    if (same) toRemove.add(j); // оставляем первый по порядку (i), убираем второй (j)
  }
  return items.filter((_, idx) => !toRemove.has(idx));
}

// transcriptHighlights — та же проблема map-reduce, что и decisions/actionItems:
// куски видят одни и те же яркие цитаты и обе включают их в свою пятёрку
export function dedupeSimilarHighlights(items, threshold = NEAR_DUP_THRESHOLD, resolveSpeaker = (x) => x) {
  const kept = [];
  const keptWords = [];
  for (const item of items) {
    // Найдено на Qwen: иногда вместо {speaker, quote} модель кладёт объект
    // формы actionItem ({owner, task}, без quote вообще) — quote оставался
    // undefined и утекал в текст протокола буквальной строкой "undefined".
    // Целиком пропускаем пункт без настоящей цитаты, а не пытаемся угадать
    // форму — лучше меньше цитат, чем мусорная.
    if (typeof item.quote !== "string" || !item.quote.trim()) continue;
    const words = significantWords(item.quote);
    // resolveSpeaker раньше применялся только для сравнения при дедупе —
    // сырая метка (SPEAKER_NN / "Спикер N") утекала в сохранённый item и
    // долетала до финального протокола нерезолвленной, даже когда сама
    // идентификация спикера отработала верно. isJunkString здесь — потому
    // что GPT кладёт строку "null" вместо настоящего null и в это поле тоже
    // (та же болезнь, что sanitizeTaskArray лечит для owner/deadline).
    const speaker = resolveSpeaker(isJunkString(item.speaker) ? null : item.speaker);
    const isDup = kept.some((k, i) => nameKey(k.speaker) === nameKey(speaker) && wordOverlapRatio(keptWords[i], words) >= threshold);
    if (!isDup) { kept.push({ ...item, speaker }); keptWords.push(words); }
  }
  return kept;
}

export function sanitizeTaskArray(arr) {
  return (Array.isArray(arr) ? arr : [])
    .filter((item) => item && !isJunkString(item.task))
    // deadline/owner страдают тем же — GPT пишет строку "null" вместо
    // настоящего null, и "до null" утекает прямо в текст протокола
    .map((item) => ({
      ...item,
      deadline: isJunkString(item.deadline) ? null : item.deadline,
      owner: isJunkString(item.owner) ? null : item.owner
    }));
}

// ── Валидатор года для дедлайна ─────────────────────────────────────────────
//
// Найденный на реальных протоколах баг: GPT в поле deadline пишет ISO-дату
// с выдуманным годом ("до 2 июня" в реплике → "2023-06-02" в протоколе),
// когда год в разговоре вообще не звучал — встреча при этом датирована
// 2026 годом, год из прошлого для будущей задачи логически бессмысленен.
// Тот же класс проблемы, что уже решён числовым валидатором в refiner.js
// (детерминированная проверка вместо доверия модели), только для года в
// дедлайне протокола, а не для чисел в построчной коррекции текста.
const MONTH_BY_NAME = new Map(Object.entries({
  январь: 1, января: 1,
  февраль: 2, февраля: 2,
  март: 3, марта: 3,
  апрель: 4, апреля: 4,
  май: 5, мая: 5,
  июнь: 6, июня: 6,
  июль: 7, июля: 7,
  август: 8, августа: 8,
  сентябрь: 9, сентября: 9,
  октябрь: 10, октября: 10,
  ноябрь: 11, ноября: 11,
  декабрь: 12, декабря: 12
}));
const MONTH_PATTERN = [...MONTH_BY_NAME.keys()].join("|");
// \b не работает после кириллицы (\w её не включает) — та же ловушка,
// что и в JUNK_STRING_PATTERN выше; вместо неё — отрицательный lookahead
// на следующую кириллическую букву, чтобы не матчить префикс более
// длинного слова (напр. "июньская").
const DAY_MONTH_RE = new RegExp(`(\\d{1,2})(?:-?(?:го|ого|му|е))?\\s+(${MONTH_PATTERN})(?![а-яё])`, "i");
const YEAR_RE = /\b(19|20)\d{2}\b/;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad2(n) {
  return String(n).padStart(2, "0");
}

// Ближайшее будущее (или совпадающее) вхождение день/месяц относительно
// даты встречи — если день/месяц уже прошли в этом году, берём следующий год.
function nearestFutureIsoDate(day, month, meetingDate) {
  const meetingUTC = Date.UTC(meetingDate.getUTCFullYear(), meetingDate.getUTCMonth(), meetingDate.getUTCDate());
  const year = meetingDate.getUTCFullYear();
  const candidateUTC = Date.UTC(year, month - 1, day);
  const finalYear = candidateUTC < meetingUTC ? year + 1 : year;
  return `${finalYear}-${pad2(month)}-${pad2(day)}`;
}

/**
 * Пересчитывает год в дедлайне относительно даты встречи, не доверяя году,
 * который вернула модель — GPT его либо не называет (день/месяц без года
 * в исходной реплике), либо подставляет выдуманный (в т.ч. в уже собранной
 * ISO-дате). День и месяц из ответа модели сохраняются как есть.
 *
 * @param {string|null} deadline
 * @param {string} meetingDateStr - дата встречи, "YYYY-MM-DD"
 * @returns {string|null}
 */
export function resolveDeadlineYear(deadline, meetingDateStr) {
  if (!deadline || typeof deadline !== "string") return deadline;
  const meetingDate = new Date(meetingDateStr);
  if (Number.isNaN(meetingDate.getTime())) return deadline;

  const isoMatch = deadline.match(ISO_DATE_RE);
  if (isoMatch) {
    return nearestFutureIsoDate(Number(isoMatch[3]), Number(isoMatch[2]), meetingDate);
  }

  // Только случай "день/месяц названы, года в тексте нет" — дедлайны вроде
  // "конец недели"/"через две недели" не парсим, это вне области валидатора
  if (!YEAR_RE.test(deadline)) {
    const dm = deadline.match(DAY_MONTH_RE);
    if (dm) {
      const month = MONTH_BY_NAME.get(dm[2].toLowerCase());
      if (month) return nearestFutureIsoDate(Number(dm[1]), month, meetingDate);
    }
  }

  return deadline;
}

export function resolveDeadlineYears(items, meetingDateStr) {
  if (!meetingDateStr || !Array.isArray(items)) return items;
  return items.map((item) => ({ ...item, deadline: resolveDeadlineYear(item.deadline, meetingDateStr) }));
}

// "topics" — дополнительный человекочитаемый слой (тема + связный пересказ),
// аддитивный к существующей схеме протокола. Отсутствие/поломка этого поля
// не должна ронять остальной протокол — на выходе всегда массив, даже пустой.
export function sanitizeTopics(arr) {
  return (Array.isArray(arr) ? arr : [])
    .filter((item) => item && !isJunkString(item.title) && !isJunkString(item.narrative))
    .map((item) => ({ title: String(item.title), narrative: String(item.narrative) }));
}

// C1 иногда (не строго воспроизводимо, замечено на ~1 из N ensemble-сэмплов)
// нарушает плоскую схему протокола и вкладывает participants/topics/decisions/
// actionItems/... внутрь summary вместо верхнего уровня. summary.overview при
// этом остаётся валидной строкой — если такой сэмпл выбирается как "лучший"
// по длине overview (research/diarization-asr-lab/score/preview-protocol.mjs,
// ensemble-ветка), его topics/decisions/... молча пропадают: код читает их
// из protocol.topics (пусто), а не из protocol.summary.topics (где они
// реально лежат). Чиним на входе сразу после JSON.parse, а не точечно по
// полю — так эта же защита работает и для одиночного вызова C1 (см.
// FINDINGS.md раздел 18, "Баг рендера при c1-samples>1").
const NESTED_SUMMARY_FIELDS = [
  "participants", "topics", "decisions", "actionItems",
  "completedFromPrevious", "carriedForward", "openQuestions", "transcriptHighlights"
];

export function repairNestedSummarySchema(protocol) {
  if (!protocol || typeof protocol.summary !== "object" || protocol.summary === null) return protocol;
  const summary = protocol.summary;
  for (const key of NESTED_SUMMARY_FIELDS) {
    const nestedValue = summary[key];
    const topLevelEmpty = protocol[key] === undefined || (Array.isArray(protocol[key]) && protocol[key].length === 0);
    if (nestedValue !== undefined && topLevelEmpty) {
      protocol[key] = nestedValue;
    }
  }
  protocol.summary = { title: summary.title, overview: summary.overview };
  return protocol;
}

export class YcYandexGptGateway {
  constructor({
    folderId,
    model = process.env.GPT_MODEL ?? "yandexgpt-lite",
    // B2 (identifySpeakers)/C1 (extractProtocol/extractProtocolLong) — отдельная
    // модель. Найдено экспериментально (research/diarization-asr-lab): на задаче
    // "сопоставить диаризационную метку с реальным именем по контексту" Qwen3.6
    // 35B резолвит реальные имена там, где YandexGPT (Lite/Pro/5.1) и gpt-oss-120b
    // сдаются и оставляют метку нерезолвленной — см. EVALUATION.md. Не идеальна
    // (изредка сочиняет имя из ASR-шума или приписывает задачу третьему лицу —
    // тот же класс ошибок, что и у YandexGPT, просто реже), но заметно точнее
    // на этой конкретной задаче. Остальные стадии (refine и т.д.) остаются на
    // основной модели — Lite для них откалибрована отдельным бенчмарком
    // (scripts/experiments/llm-refine-bench), переносить не на чем и незачем.
    b2c1Model = process.env.GPT_MODEL_B2C1 ?? "qwen3.6-35b-a3b"
  }) {
    this.folderId = folderId;
    // Lite выбран по бенчмарку (scripts/experiments/llm-refine-bench):
    // WER-восстановление 63% при цене в 6 раз ниже Pro
    this.modelUri = `gpt://${folderId}/${model}/latest`;
    this.client = new YandexGptClient({ modelUri: this.modelUri });
    this.b2c1ModelUri = b2c1Model ? `gpt://${folderId}/${b2c1Model}/latest` : this.modelUri;
    this.b2c1Client = b2c1Model ? new YandexGptClient({ modelUri: this.b2c1ModelUri }) : this.client;
    logger.info("YandexGPT: initialized", { folderId, modelUri: this.modelUri, b2c1ModelUri: this.b2c1ModelUri });
  }

  // ============================================================
  // STAGE A1: GPT Diarization (mono transcripts only)
  // ============================================================

  /**
   * Разбивает mono-транскрипт (1 спикер) на реплики по спикерам через GPT.
   * Пропускается если уже есть >1 спикера (SpeechKit справился сам).
   *
   * @param {object} transcript - { phrases, rawText, ... }
   * @param {string} domain - предметная сфера для промпта
   * @param {string[]} mentionedPeople - имена из B0-анализа для подсказок
   * @returns {object} обновлённый transcript с разбивкой по спикерам
   */
  async diarizeTranscript(transcript, domain, mentionedPeople = []) {
    const speakerIds = new Set((transcript.phrases ?? []).map((p) => p.speakerId));
    if (speakerIds.size > 1) {
      logger.info("GPT A1: skipped (already multi-speaker)", { speakers: speakerIds.size });
      return transcript;
    }

    const rawText = transcript.rawText ?? "";
    if (rawText.trim().length < 200) {
      logger.info("GPT A1: skipped (transcript too short for diarization)");
      return transcript;
    }

    logger.info("GPT A1: diarization", { chars: rawText.length, domain });

    // Убираем метку единственного спикера перед подачей в GPT
    const cleanText = rawText
      .replace(/^Спикер \d+:\s*/gm, "")
      .trim();

    const { system, user, options } = promptDiarization({
      transcriptText: cleanText.slice(0, 20_000),
      domain,
      mentionedPeople
    });

    const raw = await this.client.complete(system, user, options);
    const result = YandexGptClient.parseJson(raw, { segments: [] }, "A1");

    const segments = Array.isArray(result.segments) ? result.segments : [];
    if (segments.length < 2) {
      logger.warn("GPT A1: returned <2 segments, keeping original", {
        segments: segments.length
      });
      return transcript;
    }

    // Собираем уникальных спикеров и маппинг label → id
    const speakerLabels = [...new Set(segments.map((s) => s.speaker).filter(Boolean))];
    const labelToId = new Map(
      speakerLabels.map((label, i) => [label, `speaker-${i + 1}`])
    );

    // Пересчитываем временны́е метки пропорционально длине текста
    const totalDurationMs = Math.max(
      ...((transcript.phrases ?? []).map((p) => p.endTimeMs ?? 0)),
      0
    );
    const totalChars = segments.reduce((s, seg) => s + (seg.text?.length ?? 0), 0) || 1;

    let offsetMs = 0;
    const phrases = segments
      .filter((seg) => seg.text?.trim())
      .map((seg) => {
        const charRatio = (seg.text?.length ?? 0) / totalChars;
        const durationMs = Math.round(totalDurationMs * charRatio);
        const phrase = {
          speakerId: labelToId.get(seg.speaker) ?? "speaker-1",
          speakerLabel: seg.speaker ?? "Спикер 1",
          speakerTag: (seg.speaker ?? "1").replace(/\D/g, "") || "1",
          detectedName: null,
          startTimeMs: offsetMs,
          endTimeMs: offsetMs + durationMs,
          text: seg.text.trim()
        };
        offsetMs += durationMs;
        return phrase;
      });

    const newRawText = phrases
      .map((p) => `${p.speakerLabel}: ${p.text}`)
      .join("\n");

    logger.info("GPT A1: diarization done", {
      segments: phrases.length,
      speakers: speakerLabels.length
    });

    return {
      ...transcript,
      phrases,
      rawText: newRawText,
      diarizedByGpt: true
    };
  }

  // ============================================================
  // REFINE: коррекция чанка по line-ID-протоколу (кнопка «Улучшить»)
  // ============================================================

  /**
   * Извлекает глоссарий встречи и мержит с накопленным проектным.
   * Для коротких текстов возвращает проектный глоссарий как есть.
   */
  async extractGlossary({ rawText, domain, projectGlossary = null }) {
    if ((rawText ?? "").length <= 2000) return projectGlossary;

    const { system, user, options } = promptGlossary({
      correctedText: rawText,
      domain
    });
    const raw = await this.client.complete(system, user, options);
    const meetingGlossary = YandexGptClient.parseJson(raw, { terms: [], abbreviations: {} }, "A3");

    if (!projectGlossary) return meetingGlossary;

    const termMap = new Map((projectGlossary.terms ?? []).map((t) => [t.term, t]));
    for (const t of (meetingGlossary.terms ?? [])) {
      if (!termMap.has(t.term)) termMap.set(t.term, t);
    }
    return {
      terms: [...termMap.values()],
      abbreviations: { ...projectGlossary.abbreviations, ...meetingGlossary.abbreviations }
    };
  }

  /**
   * Исправляет один чанк реплик. Возвращает map id→текст и список
   * ID, на которые модель не ответила (обрыв вывода и т.п.).
   *
   * @param {{ lines: string[], ids: number[], contextLines: string[], domain: string, glossary: object|null }} params
   * @returns {Promise<{ byId: Map<number, string>, missingIds: number[] }>}
   */
  async refineLines({ lines, ids, contextLines = [], domain, glossary = null }) {
    const { system, user, options } = promptTranscriptRefine({
      numberedLines: lines,
      contextLines,
      domain,
      glossary
    });
    const raw = await this.client.complete(system, user, options);
    return parseRefinedLines(raw, ids);
  }

  // ============================================================
  // STAGE B: Understanding
  // ============================================================

  async analyzeContext({ correctedText, projectName }) {
    logger.info("GPT B1: context analysis");
    const { system, user, options } = promptContextAnalysis({ transcriptText: correctedText, projectName });
    const raw = await this.client.complete(system, user, options);
    const result = YandexGptClient.parseJson(raw, {
      meetingType: "прочее",
      domain: "не определено",
      mainTopics: [],
      mentionedEntities: { people: [], organizations: [], places: [], dates: [], amounts: [] },
      transcriptQuality: "fair",
      confidenceNote: null
    }, "B1");

    logger.info("GPT B1: done", {
      type: result.meetingType,
      domain: result.domain,
      quality: result.transcriptQuality,
      topics: result.mainTopics?.length ?? 0
    });

    return result;
  }

  // Голосование большинством по N независимых вызовов B2 — перенесено из
  // research/diarization-asr-lab/score/preview-protocol.mjs (--b2-votes),
  // где найдено и провалидировано на реальных встречах: один вызов B2
  // нестабилен на неоднозначных встречах (три независимых прогона с 3
  // голосами дали три разных распределения имён, включая галлюцинацию
  // "Слава" — упомянутое, но не говорившее лицо принято за спикера). С 7
  // голосами консенсус стабилизировался. См. FINDINGS.md раздел 10.
  //
  // GPT_B2_VOTES=1 (или отсутствие переменной с явным "1") откатывает к
  // одному вызову — по умолчанию используется 7, тот же дефолт, что
  // подтверждён в лабе. Это МЕНЯЕТ стоимость (N вызовов вместо одного,
  // B2 идёт последовательно) — оператор может выставить GPT_B2_VOTES=1
  // в окружении, если нужно вернуть прежнее поведение/стоимость.
  async identifySpeakers({ correctedText, transcript, project, context }) {
    const votes = Number(process.env.GPT_B2_VOTES ?? 7);
    if (!(votes > 1)) {
      return this.identifySpeakersOnce({ correctedText, transcript, project, context });
    }

    logger.info("GPT B2: speaker identification (ensemble)", { votes });
    const samples = [];
    for (let i = 0; i < votes; i++) {
      samples.push(await this.identifySpeakersOnce({ correctedText, transcript, project, context }));
    }

    const byLabel = new Map();
    for (const sample of samples) {
      for (const s of sample) {
        if (!byLabel.has(s.label)) byLabel.set(s.label, []);
        byLabel.get(s.label).push(s);
      }
    }

    // Порог 0.7 — та же марж-эвристика, что в лабе: "4/7, а не 7/7" явно
    // называется слабым консенсусом в живой демонстрации (раздел 10) —
    // 4/7≈0.57 должен попасть в "low", 7/7 и 6/7 — не должны. Не
    // гарантирует поимку каждой галлюцинации (если все N голосов
    // независимо сходятся на одном неверном ответе — не статистически
    // независимые прогоны, все видят один и тот же вводящий в
    // заблуждение текст), но ловит объективный разнобой.
    const CONFIDENCE_MARGIN_THRESHOLD = 0.7;
    const finalDrafts = [...byLabel.entries()].map(([label, labelVotes]) => {
      const nameCounts = new Map();
      for (const v of labelVotes) {
        const name = v.guessedName || null;
        if (!name) continue;
        nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
      }
      const winner = [...nameCounts.entries()].sort((a, b) => b[1] - a[1])[0];
      const bestVote = labelVotes.find((v) => v.guessedName === winner?.[0]) ?? labelVotes[0];
      const votesForWinner = winner?.[1] ?? 0;
      const totalVotes = labelVotes.length;
      const confidence = !winner || votesForWinner / totalVotes < CONFIDENCE_MARGIN_THRESHOLD ? "low" : "high";
      return {
        id: bestVote.id,
        label,
        guessedName: winner ? winner[0] : null,
        guessedRole: bestVote.guessedRole ?? null,
        dialogueRole: bestVote.dialogueRole ?? null,
        reasoning: bestVote.reasoning ?? null,
        votesForWinner,
        totalVotes,
        confidence
      };
    });

    // Конфликт-резолвер — тоже перенесён из лабы (найдено уже сегодня на
    // реальных прогонах): одно и то же имя иногда достаётся ДВУМ разным
    // диаризационным меткам одновременно (одна с сильным консенсусом —
    // вероятно, реальный человек, другая со слабым — вероятно, другой,
    // не опознанный человек, которому B2 при неуверенности "одолжил" уже
    // известное имя из ростера вместо честного null). nameKey() — та же
    // ё/е-нормализация, что и в дедупе (раздел 20) — иначе "Семён"/
    // "Семен" не распознаются как коллизия.
    const byName = new Map();
    for (const s of finalDrafts) {
      if (!s.guessedName) continue;
      const key = nameKey(s.guessedName);
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(s);
    }
    for (const claimants of byName.values()) {
      if (claimants.length < 2) continue;
      claimants.sort((a, b) => (b.votesForWinner / b.totalVotes) - (a.votesForWinner / a.totalVotes));
      const [winner, ...losers] = claimants;
      logger.info("GPT B2: name collision resolved", {
        name: winner.guessedName,
        winner: `${winner.label} (${winner.votesForWinner}/${winner.totalVotes})`,
        losers: losers.map((l) => `${l.label} (${l.votesForWinner}/${l.totalVotes})`)
      });
      for (const loser of losers) {
        loser.guessedName = null;
        loser.confidence = "low";
      }
    }

    logger.info("GPT B2: done (ensemble)", {
      votes,
      identified: finalDrafts.filter((s) => s.guessedName).length,
      total: finalDrafts.length,
      lowConfidence: finalDrafts.filter((s) => s.confidence === "low" && s.guessedName).length
    });

    return finalDrafts;
  }

  async identifySpeakersOnce({ correctedText, transcript, project, context }) {
    const speakerStats = transcript.speakerStats ?? [];
    // transcript.addressedNames считается в postprocessTranscript ДО
    // склейки подряд идущих реплик — если пересчитывать здесь заново на
    // transcript.phrases (уже склеенных), короткие реплики-обращения вроде
    // "Наталья" отдельным сегментом уже слиты с соседней репликой того же
    // спикера и признак "имя — целая реплика" для них не сработает.
    const { system, user, options } = promptSpeakerIdentification({
      transcriptText: correctedText,
      speakerStats,
      projectTeam: project.team ?? [],
      context,
      addressedNames: transcript.addressedNames ?? extractAddressedNames(transcript.phrases ?? [])
    });

    const raw = await this.b2c1Client.complete(system, user, options);
    const speakerIds = [...new Set((transcript.phrases ?? []).map((p) => p.speakerId))];
    const result = YandexGptClient.parseJson(raw, {
      speakerDrafts: speakerIds.map((id, i) => ({
        id,
        label: `Спикер ${i + 1}`,
        guessedName: null,
        guessedRole: null,
        confidence: "low",
        reasoning: "fallback"
      }))
    }, "B2");

    const drafts = result.speakerDrafts ?? [];
    logger.info("GPT B2: done", {
      identified: drafts.filter((s) => s.guessedName).length,
      total: drafts.length
    });

    return drafts;
  }

  // ============================================================
  // STAGE C: Protocol Generation
  // ============================================================

  // Ансамбль из N независимых C1-извлечений + слияние с дедупом — перенесено
  // из research/diarization-asr-lab/score/preview-protocol.mjs (--c1-samples).
  // GPT_C1_SAMPLES=1 откатывает к одному вызову (прежнее поведение);
  // по умолчанию 5 — тот же дефолт, что провалидирован в лабе (см.
  // FINDINGS.md разделы 11, 18-20). Меняет стоимость (N вызовов извлечения
  // + доп. LLM-проверка спорных пар при дедупе вместо одного вызова) —
  // оператор может выставить GPT_C1_SAMPLES=1, если нужно вернуть прежнюю
  // стоимость. Работает и для map-reduce длинных встреч "бесплатно" —
  // extractProtocolLong уже вызывает именно этот метод на каждый кусок.
  async extractProtocol({ correctedText, meeting, project, context, speakers, previousProtocol }) {
    const samples = Number(process.env.GPT_C1_SAMPLES ?? 5);
    if (!(samples > 1)) {
      return this.extractProtocolOnce({ correctedText, meeting, project, context, speakers, previousProtocol });
    }
    return this.extractProtocolEnsemble({ correctedText, meeting, project, context, speakers, previousProtocol, samples });
  }

  async extractProtocolEnsemble({ correctedText, meeting, project, context, speakers, previousProtocol, samples }) {
    logger.info("GPT C1: protocol extraction (ensemble)", { samples });
    const resolveSpeaker = buildSpeakerResolver(speakers);

    const allSamples = [];
    for (let i = 0; i < samples; i++) {
      allSamples.push(await this.extractProtocolOnce({ correctedText, meeting, project, context, speakers, previousProtocol }));
    }

    // topics — связная проза, не факт-список: fuzzy-дедуп под неё не заведён,
    // поэтому не сливаем темы всех сэмплов (получится каша повторов), а
    // берём темы того же сэмпла, что выиграл по длине summary.overview —
    // внутренне consistent пара (порт из лабы, тот же приём).
    const bestSample = [...allSamples].sort((a, b) => (b.summary?.overview?.length ?? 0) - (a.summary?.overview?.length ?? 0))[0];

    let mergedActionItems = resolveDeadlineYears(
      dedupeSimilarTasks(sanitizeTaskArray(allSamples.flatMap((s) => s.actionItems ?? [])), NEAR_DUP_THRESHOLD, resolveSpeaker),
      meeting.date
    );
    // Второй проход поверх автодедупа — при N сэмплов разнообразие
    // формулировок растёт, часть настоящих дублей не ловится порогом
    // триграмм (см. FINDINGS.md раздел 11 — "Харьковской 9" дважды при
    // N=9) или относится к разной грануляции (findEntityOverlapPairs —
    // раздел 19, "пачка объектов" vs гранулярные задачи). Спорные пары
    // отдаются на прямой вопрос модели — тот же b2c1Client (Qwen), что
    // делал само извлечение, не общий Lite-клиент.
    const borderlinePairs = findAllBorderlinePairs(mergedActionItems);
    if (borderlinePairs.length > 0) {
      // Fail-safe уже внутри resolveBorderlinePairsWithLLM (сбой
      // completeBatchFn → items без изменений, не мержим наугад)
      mergedActionItems = await resolveBorderlinePairsWithLLM(
        mergedActionItems,
        borderlinePairs,
        this.b2c1Client.completeBatch.bind(this.b2c1Client)
      );
    }

    let protocol = {
      summary: bestSample?.summary ?? { title: meeting.titleDraft ?? project.name, overview: "" },
      topics: bestSample?.topics ?? [],
      participants: dedupeSimilarStrings([...new Set(allSamples.flatMap((s) => s.participants ?? []))]),
      decisions: dropDecisionsOverlappingTasks(
        dedupeSimilarStrings(allSamples.flatMap((s) => s.decisions ?? [])),
        mergedActionItems
      ),
      actionItems: mergedActionItems,
      completedFromPrevious: allSamples.flatMap((s) => s.completedFromPrevious ?? []),
      carriedForward: allSamples.flatMap((s) => s.carriedForward ?? []),
      openQuestions: dedupeSimilarStrings(allSamples.flatMap((s) => s.openQuestions ?? [])),
      transcriptHighlights: dedupeSimilarHighlights(allSamples.flatMap((s) => s.transcriptHighlights ?? []), NEAR_DUP_THRESHOLD, resolveSpeaker).slice(0, 5)
    };
    protocol = reconcileParticipants(protocol, speakers);

    logger.info("GPT C1: done (ensemble)", {
      samples,
      title: protocol.summary.title,
      decisions: protocol.decisions.length,
      actions: protocol.actionItems.length,
      openQuestions: protocol.openQuestions.length
    });

    return protocol;
  }

  async extractProtocolOnce({ correctedText, meeting, project, context, speakers, previousProtocol }) {
    logger.info("GPT C1: protocol extraction");

    const resolveSpeaker = buildSpeakerResolver(speakers);
    const speakerMap = speakers
      .map((s) => `- ${s.label} = ${s.guessedName || "неизвестен"}${s.guessedRole ? ` (${s.guessedRole})` : ""}`)
      .join("\n");

    const { system, user, options } = promptProtocolExtraction({
      transcriptText: correctedText,
      domain: context.domain,
      meetingType: context.meetingType,
      mainTopics: context.mainTopics ?? [],
      speakerMap,
      prevActionItems: previousProtocol?.actionItems ?? null,
      meetingDate: meeting.date ?? "не указана",
      projectName: project.name,
      organizations: context.mentionedEntities?.organizations ?? []
    });

    const defaultProtocol = {
      summary: { title: meeting.titleDraft ?? project.name, overview: "" },
      participants: [], topics: [], decisions: [], actionItems: [],
      completedFromPrevious: [], carriedForward: [],
      openQuestions: [], transcriptHighlights: []
    };

    // Невалидный JSON (в т.ч. отказ модели отвечать по теме) молча ронял
    // весь кусок текста из протокола — один retry перед тем, как сдаться,
    // тот же паттерн, что уже есть для missingIds в refineLines
    let protocol = null;
    for (let attempt = 0; attempt < 2 && protocol === null; attempt++) {
      const raw = await this.b2c1Client.complete(system, user, options);
      try {
        protocol = repairNestedSummarySchema(JSON.parse(stripJsonFence(raw)));
      } catch (e) {
        if (attempt === 0) {
          logger.warn("GPT C1: invalid JSON, retrying once", { error: e.message, preview: raw.slice(0, 200) });
        } else {
          logger.error("GPT C1: invalid JSON after retry, using default", { error: e.message, preview: raw.slice(0, 300) });
          protocol = defaultProtocol;
        }
      }
    }

    // Гарантируем все поля и чистим заглушки вроде "null", которые GPT
    // иногда возвращает вместо пустого массива
    protocol.summary ??= { title: meeting.titleDraft ?? project.name, overview: "" };
    // dedupeSimilarStrings и для participants, и для openQuestions — не
    // только decisions: без него "Александр"/"Александр Ильин" остаются
    // двумя разными участниками, а почти дословно повторённый открытый
    // вопрос (другая формулировка того же) не ловится
    protocol.participants = dedupeSimilarStrings(sanitizeStringArray(protocol.participants));
    protocol.topics = sanitizeTopics(protocol.topics);
    protocol.decisions = dedupeSimilarStrings(sanitizeStringArray(protocol.decisions));
    protocol.actionItems = resolveDeadlineYears(
      dedupeSimilarTasks(sanitizeTaskArray(protocol.actionItems), NEAR_DUP_THRESHOLD, resolveSpeaker),
      meeting.date
    );
    protocol.decisions = dropDecisionsOverlappingTasks(protocol.decisions, protocol.actionItems);
    protocol.completedFromPrevious = sanitizeTaskArray(protocol.completedFromPrevious);
    protocol.carriedForward = sanitizeTaskArray(protocol.carriedForward);
    protocol.openQuestions = dedupeSimilarStrings(sanitizeStringArray(protocol.openQuestions));
    protocol.transcriptHighlights = dedupeSimilarHighlights(protocol.transcriptHighlights ?? [], NEAR_DUP_THRESHOLD, resolveSpeaker);
    protocol = reconcileParticipants(protocol, speakers);

    logger.info("GPT C1: done", {
      title: protocol.summary.title,
      decisions: protocol.decisions.length,
      actions: protocol.actionItems.length,
      openQuestions: protocol.openQuestions.length
    });

    return protocol;
  }

  // ============================================================
  // STAGE D: Quality Assurance (optional)
  // ============================================================

  /**
   * Проверяет достоверность и полноту протокола.
   * Запускается только если качество транскрипта "fair" или "poor".
   * Возвращает доработанный протокол.
   */
  async qaProtocol({ protocol, correctedText, context, speakers = [], meetingDate = null }) {
    if (context.transcriptQuality === "good") {
      logger.info("GPT D: skipped (quality=good)");
      return protocol;
    }
    const resolveSpeaker = buildSpeakerResolver(speakers);

    logger.info("GPT D1+D2: qa check");

    // D1 и D2 параллельно
    const [faithfulnessRaw, completenessRaw] = await this.client.completeBatch([
      (() => {
        const { system, user, options } = promptFaithfulnessCheck({
          protocol,
          transcriptText: correctedText
        });
        return { system, user, options };
      })(),
      (() => {
        const { system, user, options } = promptCompletenessCheck({
          protocol,
          transcriptText: correctedText,
          domain: context.domain
        });
        return { system, user, options };
      })()
    ]);

    const faithfulness = YandexGptClient.parseJson(
      faithfulnessRaw,
      { suggestedRemovals: [] },
      "D1"
    );
    const completeness = YandexGptClient.parseJson(
      completenessRaw,
      { missedActions: [], missedDecisions: [], missedRisks: [], overallCompleteness: "medium" },
      "D2"
    );

    logger.info("GPT D: done", {
      suggestedRemovals: faithfulness.suggestedRemovals?.length ?? 0,
      missedActions: completeness.missedActions?.length ?? 0,
      overallCompleteness: completeness.overallCompleteness
    });

    // Применяем результаты QA
    const patchedProtocol = { ...protocol };

    // Удаляем выдуманные пункты (fabricated). Схема просит строки, но GPT
    // иногда кладёт объекты вместо строк — .toLowerCase() падал на этом
    // (TypeError: r.toLowerCase is not a function), нестроковые элементы
    // просто пропускаем, а не пытаемся угадать их форму
    if (faithfulness.suggestedRemovals?.length) {
      const removals = new Set(
        faithfulness.suggestedRemovals
          .filter((r) => typeof r === "string")
          .map((r) => r.toLowerCase().slice(0, 50))
      );
      patchedProtocol.decisions = protocol.decisions.filter(
        (d) => !removals.has(d.toLowerCase().slice(0, 50))
      );
      patchedProtocol.actionItems = protocol.actionItems.filter(
        (a) => !removals.has(a.task?.toLowerCase().slice(0, 50))
      );
    }

    // Добавляем пропущенные задачи/решения, затем нечёткий дедуп по всему
    // набору разом — D2 иногда находит "пропущенным" то, что C1 уже добавил
    // другой формулировкой ("Завершить работу..." vs "Завершение работы...")
    if (completeness.missedActions?.length) {
      const validMissed = completeness.missedActions.filter((a) => a.task && a.owner);
      let mergedBack = dedupeSimilarTasks(
        sanitizeTaskArray([...patchedProtocol.actionItems, ...validMissed]), NEAR_DUP_THRESHOLD, resolveSpeaker
      );
      // Строгий автодедуп выше ловит только пары с ratio>=0.6 — то, что D2
      // "нашёл пропущенным", часто пересказ уже существующей задачи другими
      // словами (ratio в серой зоне) или та же задача с другим набором
      // затронутых объектов при разной грануляции (findEntityOverlapPairs).
      // Без повторной LLM-проверки здесь такие пары не мержились — эта
      // добавка единственная во всём extractProtocol/qaProtocol, которая
      // раньше не проходила через resolveBorderlinePairsWithLLM (см.
      // research/diarization-asr-lab/FINDINGS.md, раздел 18).
      const borderlinePairs = findAllBorderlinePairs(mergedBack);
      if (borderlinePairs.length > 0) {
        // Fail-safe уже внутри resolveBorderlinePairsWithLLM (сбой
        // completeBatchFn → items без изменений, не мержим наугад)
        mergedBack = await resolveBorderlinePairsWithLLM(
          mergedBack,
          borderlinePairs,
          this.client.completeBatch.bind(this.client)
        );
      }
      patchedProtocol.actionItems = resolveDeadlineYears(mergedBack, meetingDate);
    }
    if (completeness.missedDecisions?.length) {
      patchedProtocol.decisions = dropDecisionsOverlappingTasks(
        dedupeSimilarStrings(sanitizeStringArray([...patchedProtocol.decisions, ...completeness.missedDecisions])),
        patchedProtocol.actionItems
      );
    }
    // missedRisks — упомянутые в разговоре риски/незакрытые моменты, которые
    // не оформлены как решение или задача. По смыслу ближе всего к уже
    // существующим openQuestions (то, что требует внимания, но не решено) —
    // раньше это поле запрашивалось у модели, но нигде не читалось и молча
    // терялось.
    if (completeness.missedRisks?.length) {
      patchedProtocol.openQuestions = dedupeSimilarStrings(
        sanitizeStringArray([...(patchedProtocol.openQuestions ?? []), ...completeness.missedRisks])
      );
    }

    patchedProtocol.qaNote = completeness.note ?? null;
    patchedProtocol.completenessScore = completeness.overallCompleteness;

    return patchedProtocol;
  }

  // ============================================================
  // PUBLIC API
  // ============================================================

  /**
   * Stage C+D: генерация финального протокола.
   * Вызывается после подтверждения черновика пользователем.
   */
  async generateProtocol({ meeting, project, transcript, previousProtocol = null, projectGlossary = null, refinedText = null }) {
    // Источник текста по приоритету:
    //   refined (кнопка «Улучшить», если не инвалидирован) >
    //   gptContext.correctedText (ручная правка / legacy) >
    //   сырой rawText — БЕЗ обрезания: длинные тексты идут через map-reduce
    const correctedText = refinedText
      ?? meeting.gptContext?.correctedText
      ?? transcript.rawText;

    // Контекст из meeting (если refine уже его посчитал) или анализируем
    const context = meeting.gptContext?.domain
      ? meeting.gptContext
      : await this.analyzeContext({
          correctedText: correctedText.slice(0, 20_000),
          projectName: project.name
        });

    const speakers = (meeting.speakerDrafts ?? []).map((s) => ({
      id: s.id,
      label: s.label,
      guessedName: s.guessedName,
      guessedRole: null,
      confidence: s.confidence
    }));

    let protocol;
    if (correctedText.length <= MAX_TRANSCRIPT_CHARS) {
      // C1: одним вызовом
      protocol = await this.extractProtocol({
        correctedText,
        meeting,
        project,
        context,
        speakers,
        previousProtocol
      });
    } else {
      // Map-reduce: длинная встреча — хвост больше не теряется
      protocol = await this.extractProtocolLong({
        correctedText,
        meeting,
        project,
        context,
        speakers,
        previousProtocol
      });
    }
    // D1+D2: QA (только для fair/poor транскриптов) — раньше пропускался для
    // длинных встреч (map-reduce), хотя именно там пропуски вероятнее всего
    // (каждый кусок видит только часть разговора)
    //
    // Сбой D1/D2 (квота/сеть — YandexGptClient.complete уже ретраит 429/500
    // и сетевые ошибки несколько раз, но после исчерпания попыток всё равно
    // бросает) раньше ронял весь generateProtocol целиком, теряя уже готовый
    // protocol из extractProtocol/extractProtocolLong — который для длинных
    // встреч мог стоить нескольких map-reduce LLM-вызовов. QA — это
    // улучшение уже готового протокола, а не обязательное условие для его
    // существования, поэтому сбой здесь не должен откатывать всю генерацию
    // (см. research/diarization-asr-lab/FINDINGS.md раздел 19, тот же баг
    // был исправлен в лабораторном скрипте раньше прода).
    try {
      protocol = await this.qaProtocol({ protocol, correctedText, context, speakers, meetingDate: meeting.date ?? null });
    } catch (e) {
      logger.warn("GPT D1/D2 (qaProtocol) failed, keeping protocol without QA", { error: e.message });
    }

    const protocolText = buildProtocolText(protocol, meeting, project, context);
    // Возвращаем глоссарий из meeting.gptContext чтобы pipeline мог его накопить
    const glossary = meeting.gptContext?.glossary ?? null;
    return { protocol, protocolText, glossary };
  }

  /**
   * Map-reduce извлечение протокола для длинных встреч (> 22k символов).
   * Map: C1-извлечение на каждом куске. Reduce: программное слияние массивов
   * + один LLM-вызов для консолидации (дедупликация, сводка). При сбое
   * reduce-вызова остаётся программное слияние — протокол не теряется.
   */
  async extractProtocolLong({ correctedText, meeting, project, context, speakers, previousProtocol }) {
    // Режем по строкам (репликам), не по символам
    const pieces = [];
    let buf = [];
    let bufLen = 0;
    for (const line of correctedText.split("\n")) {
      if (bufLen + line.length > 18_000 && buf.length > 0) {
        pieces.push(buf.join("\n"));
        buf = [];
        bufLen = 0;
      }
      buf.push(line);
      bufLen += line.length + 1;
    }
    if (buf.length > 0) pieces.push(buf.join("\n"));

    logger.info("GPT C map: extracting from pieces", { pieces: pieces.length });

    const resolveSpeaker = buildSpeakerResolver(speakers);
    const partials = [];
    for (let i = 0; i < pieces.length; i++) {
      // previousProtocol передаём только в первый кусок (сверка статусов задач
      // консолидируется в reduce); последовательность сохраняет порядок тем
      const partial = await this.extractProtocol({
        correctedText: pieces[i],
        meeting,
        project,
        context,
        speakers,
        previousProtocol: i === 0 ? previousProtocol : null
      });
      partials.push(partial);
    }

    // Программное слияние — безопасный базовый результат
    const merged = {
      summary: {
        title: partials[0]?.summary?.title ?? meeting.titleDraft ?? project.name,
        overview: partials.map((p) => p.summary?.overview).filter(Boolean).join(" ")
      },
      participants: dedupeSimilarStrings([...new Set(partials.flatMap((p) => p.participants ?? []))]),
      topics: partials.flatMap((p) => p.topics ?? []),
      decisions: partials.flatMap((p) => p.decisions ?? []),
      actionItems: partials.flatMap((p) => p.actionItems ?? []),
      completedFromPrevious: partials.flatMap((p) => p.completedFromPrevious ?? []),
      carriedForward: partials.flatMap((p) => p.carriedForward ?? []),
      openQuestions: dedupeSimilarStrings(partials.flatMap((p) => p.openQuestions ?? [])),
      transcriptHighlights: dedupeSimilarHighlights(partials.flatMap((p) => p.transcriptHighlights ?? []), NEAR_DUP_THRESHOLD, resolveSpeaker).slice(0, 5)
    };

    // Reduce: LLM-консолидация (дедуп решений/задач, цельная сводка)
    try {
      const { system, user, options } = promptProtocolReduce({
        merged,
        meetingDate: meeting.date ?? "не указана",
        projectName: project.name,
        domain: context.domain
      });
      const raw = await this.b2c1Client.complete(system, user, options);
      const reduced = YandexGptClient.parseJson(raw, null, "C-reduce");
      if (reduced?.summary) {
        // Сохраняем структуру: отсутствующие поля добираем из merged.
        // reduced.actionItems/decisions — сырой вывод отдельного LLM-вызова,
        // никогда не проходивший через sanitize (только merged проходил
        // построчно в extractProtocol) — санитайзим и дедупим заново, а не
        // только дедупим, иначе "null"-заглушки из reduce-вызова утекают
        const combined = { ...merged, ...reduced, summary: { ...merged.summary, ...reduced.summary } };
        combined.participants = dedupeSimilarStrings(sanitizeStringArray(combined.participants));
        combined.actionItems = resolveDeadlineYears(
          dedupeSimilarTasks(sanitizeTaskArray(combined.actionItems), NEAR_DUP_THRESHOLD, resolveSpeaker),
          meeting.date
        );
        combined.decisions = dropDecisionsOverlappingTasks(
          dedupeSimilarStrings(sanitizeStringArray(combined.decisions)),
          combined.actionItems
        );
        combined.openQuestions = dedupeSimilarStrings(sanitizeStringArray(combined.openQuestions));
        combined.transcriptHighlights = dedupeSimilarHighlights(combined.transcriptHighlights ?? [], NEAR_DUP_THRESHOLD, resolveSpeaker).slice(0, 5);
        // Партиалы уже прошли reconcileParticipants внутри extractProtocol,
        // но reduce-вызов иногда игнорирует "не добавляй ничего нового" —
        // подчищаем ещё раз на всякий случай на финальном результате
        return reconcileParticipants(combined, speakers);
      }
    } catch (e) {
      logger.warn("GPT C reduce failed, using programmatic merge", { error: e.message });
    }
    merged.actionItems = resolveDeadlineYears(
      dedupeSimilarTasks(sanitizeTaskArray(merged.actionItems), NEAR_DUP_THRESHOLD, resolveSpeaker),
      meeting.date
    );
    merged.decisions = dropDecisionsOverlappingTasks(
      dedupeSimilarStrings(sanitizeStringArray(merged.decisions)),
      merged.actionItems
    );
    return reconcileParticipants(merged, speakers);
  }

  _deriveDraftTitle(context, project) {
    if (context.mainTopics?.length) {
      return context.mainTopics.slice(0, 2).join(", ");
    }
    return `${project.name} — ${context.meetingType ?? "встреча"}`;
  }
}

// ============================================================
// Protocol text formatter
// ============================================================

function buildProtocolText(protocol, meeting, project, context) {
  const lines = [
    "═══════════════════════════════════════════",
    "       ПРОТОКОЛ ВСТРЕЧИ",
    "═══════════════════════════════════════════",
    "",
    `Проект:   ${project.name}`,
    `Встреча:  ${protocol.summary.title}`,
    `Дата:     ${meeting.date ?? "—"}`,
    `Тип:      ${context?.meetingType ?? "—"}`,
    `Сфера:    ${context?.domain ?? "—"}`,
    `Участники: ${protocol.participants.join(", ") || "—"}`,
    ""
  ];

  if (protocol.summary.overview) {
    lines.push("── КРАТКАЯ СВОДКА ─────────────────────────");
    lines.push(protocol.summary.overview);
    lines.push("");
  }

  if (protocol.topics?.length > 0) {
    lines.push("── ТЕМЫ ВСТРЕЧИ ────────────────────────────");
    protocol.topics.forEach((t, i) => {
      lines.push(`  ${i + 1}. ${t.title}`);
      lines.push(`     ${t.narrative}`);
    });
    lines.push("");
  }

  if (protocol.decisions.length > 0) {
    lines.push("── ПРИНЯТЫЕ РЕШЕНИЯ ────────────────────────");
    protocol.decisions.forEach((d, i) => lines.push(`  ${i + 1}. ${d}`));
    lines.push("");
  }

  if (protocol.actionItems.length > 0) {
    lines.push("── ЗАДАЧИ ──────────────────────────────────");
    protocol.actionItems.forEach((a, i) =>
      lines.push(`  ${i + 1}. [${a.owner ?? "—"}] ${a.task}  →  до ${a.deadline ?? "—"}`)
    );
    lines.push("");
  }

  if (protocol.openQuestions?.length > 0) {
    lines.push("── ОТКРЫТЫЕ ВОПРОСЫ ────────────────────────");
    protocol.openQuestions.forEach((q, i) => lines.push(`  ${i + 1}. ${q}`));
    lines.push("");
  }

  if (protocol.completedFromPrevious?.length > 0) {
    lines.push("── ВЫПОЛНЕНО С ПРОШЛОЙ ВСТРЕЧИ ─────────────");
    protocol.completedFromPrevious.forEach((a, i) =>
      lines.push(`  ${i + 1}. ✓  [${a.owner ?? "—"}] ${a.task}`)
    );
    lines.push("");
  }

  if (protocol.carriedForward?.length > 0) {
    lines.push("── ПЕРЕНЕСЕНО ──────────────────────────────");
    protocol.carriedForward.forEach((a, i) =>
      lines.push(`  ${i + 1}. ➜  [${a.owner ?? "—"}] ${a.task}  →  до ${a.deadline ?? "—"}`)
    );
    lines.push("");
  }

  if (protocol.transcriptHighlights?.length > 0) {
    lines.push("── КЛЮЧЕВЫЕ МОМЕНТЫ ────────────────────────");
    protocol.transcriptHighlights.forEach((h) =>
      lines.push(`  — ${h.speaker ?? "—"}: «${h.quote}»`)
    );
    lines.push("");
  }

  if (protocol.qaNote) {
    lines.push(`  ℹ  ${protocol.qaNote}`);
    lines.push("");
  }

  lines.push("═══════════════════════════════════════════");

  return lines.join("\n");
}
