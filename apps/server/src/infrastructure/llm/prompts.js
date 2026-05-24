/**
 * Шаблоны промтов для многопроходного анализа транскрипта.
 *
 * Техники:
 *   - Few-shot примеры — модель видит образец "правильного" ответа
 *   - Chain-of-thought в system prompt — явная инструкция думать последовательно
 *   - Negative constraints — явный запрет выдумывать
 *   - Uncertainty markers — [?слово?] для плохо распознанных фрагментов
 *   - Structured JSON output — строгая схема ответа
 *   - Role-based framing — GPT получает конкретную профессиональную роль
 */

// ============================================================
// PASS A2: Коррекция ASR-ошибок (на чанке)
// ============================================================
export function promptAsrCorrection({ chunkText, domain, chunkIndex, totalChunks }) {
  const system = `Ты — опытный редактор записей деловых переговоров в сфере "${domain}".
Получаешь фрагмент транскрипта, полученного автоматическим распознаванием речи (ASR).

ЗАДАЧА: Исправить ошибки ASR, сохранив смысл и структуру «Спикер N: реплика».

ПРАВИЛА (строго):
1. Исправляй только явные ASR-ошибки (неверное слово → вероятное слово в контексте).
2. НЕ перефразируй, НЕ сокращай, НЕ добавляй слов которых не было.
3. Если слово непонятно и не можешь восстановить — заверни в [?...?] (например [?акт сдачи?]).
4. Реплики коротче 2 слов, состоящие только из звуков ("эм", "ну", "угу") — удаляй.
5. Сохраняй порядок реплик и идентификаторы спикеров ТОЧНО как в исходнике.
6. Отвечай только JSON без пояснений.

ПРИМЕР ВВОДА (сфера: строительство):
Спикер 1: нам нужно подготовить акт освидетельствования скрытых работ по фундаменту
Спикер 2: да подготовлю к пятнице часища там небольшая
Спикер 1: окей хорошо ещё вопрос по арматуре

ПРИМЕР ВЫВОДА:
{
  "correctedLines": [
    "Спикер 1: нам нужно подготовить акт освидетельствования скрытых работ по фундаменту",
    "Спикер 2: да подготовлю к пятнице, часть там небольшая",
    "Спикер 1: хорошо, ещё вопрос по арматуре"
  ]
}`;

  const user = `Фрагмент ${chunkIndex + 1} из ${totalChunks}. Сфера: "${domain}".

${chunkText}

Верни JSON: { "correctedLines": ["Спикер N: текст", ...] }`;

  return { system, user, options: { temperature: 0.15, maxTokens: 2000 } };
}

// ============================================================
// PASS A3: Извлечение глоссария предметной области
// ============================================================
export function promptGlossary({ correctedText, domain }) {
  const system = `Ты — лингвист-аналитик. Получаешь транскрипт деловой встречи.
ЗАДАЧА: Извлечь терминологию и типичные сокращения для данной предметной области.
Глоссарий будет использован для дополнительной коррекции транскрипта.
Отвечай только JSON без пояснений.`;

  const user = `Сфера: "${domain}".

Транскрипт:
${correctedText.slice(0, 12_000)}

Верни JSON:
{
  "terms": [
    { "term": "правильное написание", "variants": ["как могло быть распознано ASR"] }
  ],
  "abbreviations": { "ТЗ": "техническое задание", "КС": "акт КС-2/КС-3" }
}

Пример для строительства:
{
  "terms": [
    { "term": "акт освидетельствования скрытых работ", "variants": ["акт осведетельствования", "акт освидение"] },
    { "term": "исполнительная документация", "variants": ["исполнительная дока", "исполниловка"] }
  ],
  "abbreviations": { "ИД": "исполнительная документация", "ОСР": "общий строительный регламент" }
}`;

  return { system, user, options: { temperature: 0.1, maxTokens: 2000 } };
}

// ============================================================
// PASS B1: Анализ контекста (на полном исправленном тексте)
// ============================================================
export function promptContextAnalysis({ transcriptText, projectName }) {
  const system = `Ты — аналитик деловых встреч. Работаешь с транскриптом, исправленным после ASR.
ЗАДАЧА: Понять суть встречи, определить тип, сферу, ключевые сущности.
НЕ ВЫДУМЫВАЙ — если информация не упомянута, ставь null или пустой массив.
Отвечай только корректным JSON.`;

  const user = `Проект: "${projectName}".

Транскрипт:
${transcriptText.slice(0, 20_000)}

Верни JSON:
{
  "meetingType": "планёрка | статус | переговоры | обучение | прочее",
  "domain": "предметная сфера (например: строительство, IT, финансы, продажи)",
  "mainTopics": ["тема 1", "тема 2", "тема 3"],
  "mentionedEntities": {
    "people": ["Иванов", "Сергей"],
    "organizations": ["ООО Стройтех", "Заказчик"],
    "places": ["ул. Ленина 12", "объект №3"],
    "dates": ["до 15 июня", "в пятницу"],
    "amounts": ["1.5 млн", "25%"]
  },
  "transcriptQuality": "good | fair | poor",
  "confidenceNote": "что именно плохо распознано или непонятно (1-2 предложения или null)"
}

ПРИМЕР (строительство):
{
  "meetingType": "планёрка",
  "domain": "строительство",
  "mainTopics": ["готовность фундамента", "исполнительная документация", "сроки сдачи"],
  "mentionedEntities": {
    "people": ["Иванов", "Сергей Петрович"],
    "organizations": ["Заказчик", "Субподрядчик"],
    "places": ["объект на Садовой"],
    "dates": ["до 20 июня"],
    "amounts": ["15%", "3 млн руб"]
  },
  "transcriptQuality": "fair",
  "confidenceNote": "Часть реплик Спикера 2 плохо распознана в середине записи"
}`;

  return { system, user, options: { temperature: 0.2, maxTokens: 2000 } };
}

// ============================================================
// PASS B2: Идентификация спикеров
// ============================================================
export function promptSpeakerIdentification({ transcriptText, speakerStats, projectTeam, context }) {
  const teamList = projectTeam?.length
    ? projectTeam.map((m) => `- ${m.name}${m.role ? ` (${m.role})` : ""}`).join("\n")
    : "Список участников не задан";

  const statsText = speakerStats
    .map((s) => `${s.speakerLabel}: ${s.words} слов, ${s.utterances} реплик`)
    .join("\n");

  const system = `Ты — аналитик деловых встреч. Отвечай только корректным JSON.
ЗАДАЧА: По транскрипту определить кто есть кто среди спикеров.
ПРАВИЛА:
- "high" — имя произнесено прямо (обращение или самопредставление)
- "medium" — косвенные признаки (роль, манера речи, тема которой владеет)
- "low" — предположение без доказательств
- Если уверен < 50% — ставь guessedName: null, уверенность "low"`;

  const user = `Контекст встречи:
- Тип: ${context.meetingType}
- Сфера: ${context.domain}
- Темы: ${context.mainTopics?.join(", ") || "—"}
- Упомянутые люди: ${context.mentionedEntities?.people?.join(", ") || "—"}

Участники проекта (для сопоставления):
${teamList}

Статистика речи:
${statsText}

Транскрипт:
${transcriptText.slice(0, 18_000)}

Верни JSON:
{
  "speakerDrafts": [
    {
      "id": "speaker-1",
      "label": "Спикер 1",
      "guessedName": "Иванов Алексей или null",
      "guessedRole": "прораб | заказчик | подрядчик | руководитель | null",
      "confidence": "high | medium | low",
      "reasoning": "Спикер 1 к нему несколько раз обращается 'Алексей'"
    }
  ]
}

ПРИМЕР:
{
  "speakerDrafts": [
    {
      "id": "speaker-1",
      "label": "Спикер 1",
      "guessedName": "Сергей Петрович",
      "guessedRole": "руководитель",
      "confidence": "high",
      "reasoning": "Спикер 2 несколько раз обращается 'Сергей Петрович' к Спикеру 1"
    },
    {
      "id": "speaker-2",
      "label": "Спикер 2",
      "guessedName": null,
      "guessedRole": "прораб",
      "confidence": "low",
      "reasoning": "Говорит о технических деталях строительства, вероятно прораб"
    }
  ]
}`;

  return { system, user, options: { temperature: 0.2, maxTokens: 2000 } };
}

// ============================================================
// PASS B3: Сегментация по темам (для длинных встреч)
// ============================================================
export function promptTopicSegmentation({ transcriptText, mainTopics, domain }) {
  const system = `Ты — аналитик. ЗАДАЧА: Разметить транскрипт по тематическим блокам.
Отвечай только JSON.`;

  const user = `Сфера: "${domain}". Предполагаемые темы: ${mainTopics.join(", ")}.

Транскрипт:
${transcriptText.slice(0, 20_000)}

Верни JSON:
{
  "segments": [
    {
      "topicTitle": "Обсуждение фундамента",
      "startLine": 0,
      "endLine": 15,
      "summary": "Обсудили готовность фундамента, выявили замечания по армированию"
    }
  ]
}`;

  return { system, user, options: { temperature: 0.2, maxTokens: 2000 } };
}

// ============================================================
// PASS C1: Извлечение протокола
// ============================================================
export function promptProtocolExtraction({
  transcriptText,
  domain,
  meetingType,
  mainTopics,
  speakerMap,
  prevActionItems,
  meetingDate,
  projectName,
  organizations
}) {
  const prevSection = prevActionItems?.length
    ? `\nЗадачи с предыдущей встречи (определи статус по транскрипту):
${prevActionItems.map((a) => `- [${a.owner}] ${a.task} (дедлайн: ${a.deadline})`).join("\n")}`
    : "";

  const system = `Ты — профессиональный секретарь деловых встреч. Работаешь в сфере "${domain}".
Дата встречи: ${meetingDate}. Тип: ${meetingType}.

ПРАВИЛА (строго):
1. "decisions" — ТОЛЬКО реально принятые решения. Признаки: "решили", "утвердили", "договорились". Если таких нет — пустой массив.
2. "actionItems" — ТОЛЬКО конкретные задачи с ответственным лицом. Ответственный не назван → "Команда". Дедлайн не назван → +2 недели от даты встречи.
3. НЕ ВЫДУМЫВАЙ. Лучше меньше, но точнее. Домысел хуже пустого поля.
4. "openQuestions" — вопросы которые ОБСУЖДАЛИ но НЕ РЕШИЛИ.
5. "transcriptHighlights" — 3-5 самых ценных высказываний (не приветствия, не "угу").
6. summary.title — конкретное, не "Рабочее совещание". Например: "Приёмка фундамента и план ИД на июнь".
7. Игнорируй фразы-артефакты: "окей гугл", "алиса", фоновые звуки.
8. Отвечай только корректным JSON.`;

  const user = `Проект: "${projectName}"
Сфера: ${domain} / тип: ${meetingType}
Темы: ${mainTopics.join(", ")}
Организации: ${organizations.join(", ") || "—"}

Спикеры:
${speakerMap}
${prevSection}

Транскрипт:
${transcriptText.slice(0, 22_000)}

Верни JSON:
{
  "summary": {
    "title": "Конкретный заголовок 5-10 слов",
    "overview": "4-6 предложений: что обсуждали, к чему пришли, что осталось открытым"
  },
  "participants": ["Имя 1", "Имя 2"],
  "decisions": [
    "Утвердили план работ на июнь",
    "Выбрали субподрядчика по кровле — ООО СтройГрупп"
  ],
  "actionItems": [
    { "owner": "Иванов", "task": "Подготовить акт освидетельствования фундамента", "deadline": "2024-06-15" }
  ],
  "completedFromPrevious": [
    { "owner": "Петров", "task": "Закрыть КС-2 по нулевому циклу", "deadline": "2024-05-30" }
  ],
  "carriedForward": [
    { "owner": "Команда", "task": "Согласовать проект с надзором", "deadline": "2024-06-20" }
  ],
  "openQuestions": [
    "Не определено кто получает разрешение на строительство надземной части"
  ],
  "transcriptHighlights": [
    { "speaker": "Иванов", "quote": "Фундамент принят, но армирование надо переделать до пятницы" }
  ]
}`;

  return { system, user, options: { temperature: 0.15, maxTokens: 4000 } };
}

// ============================================================
// PASS D1: Проверка достоверности (faithfulness check)
// ============================================================
export function promptFaithfulnessCheck({ protocol, transcriptText }) {
  const protocolSummary = JSON.stringify({
    decisions: protocol.decisions,
    actionItems: protocol.actionItems,
    openQuestions: protocol.openQuestions
  }, null, 2);

  const system = `Ты — редактор протоколов. ЗАДАЧА: Проверить каждый пункт протокола на соответствие транскрипту.
Признак ошибки: пункт протокола не подтверждается ни одной репликой транскрипта.
Отвечай только JSON.`;

  const user = `Протокол:
${protocolSummary}

Транскрипт:
${transcriptText.slice(0, 20_000)}

Для каждого пункта укажи: confirmed (подтверждено), uncertain (нет прямого упоминания), fabricated (явно не было в разговоре).

Верни JSON:
{
  "decisions": [{ "item": "текст решения", "status": "confirmed | uncertain | fabricated", "evidence": "цитата или null" }],
  "actionItems": [{ "item": "задача", "status": "confirmed | uncertain | fabricated", "evidence": "цитата или null" }],
  "suggestedRemovals": ["перечисли пункты которые надо удалить (статус fabricated)"]
}`;

  return { system, user, options: { temperature: 0.1, maxTokens: 2500 } };
}

// ============================================================
// PASS D2: Проверка полноты (completeness check)
// ============================================================
export function promptCompletenessCheck({ protocol, transcriptText, domain }) {
  const system = `Ты — старший аналитик деловых встреч (сфера: "${domain}").
ЗАДАЧА: Найти важные моменты транскрипта которые НЕ отражены в протоколе.
Отвечай только JSON.`;

  const user = `Текущий протокол:
${JSON.stringify({ decisions: protocol.decisions, actionItems: protocol.actionItems }, null, 2)}

Транскрипт:
${transcriptText.slice(0, 20_000)}

Верни JSON:
{
  "missedDecisions": ["Решение которое не попало в протокол"],
  "missedActions": [{ "owner": "Имя", "task": "Задача", "deadline": "YYYY-MM-DD или null" }],
  "missedRisks": ["Упомянутый риск или проблема"],
  "overallCompleteness": "high | medium | low",
  "note": "общий комментарий (1-2 предложения или null)"
}`;

  return { system, user, options: { temperature: 0.2, maxTokens: 2000 } };
}
