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
  promptDiarizationByTeam,
  promptGlossary,
  promptContextAnalysis,
  promptSpeakerIdentification,
  promptProtocolExtraction,
  promptProtocolReduce,
  promptFaithfulnessCheck,
  promptCompletenessCheck,
  promptTranscriptRefine,
  promptDialogueRewrite
} from "./llm/prompts.js";
import { parseRefinedLines } from "../application/transcription/refiner.js";
import { logger } from "../shared/logger.js";

const MAX_TRANSCRIPT_CHARS = 22_000;

// Полный промах (ни одной строки "[N] текст" в ответе) чаще всего значит не
// "модель ошиблась форматом", а отказ модерации ("не могу обсуждать эту
// тему") — parseRefinedLines такой ответ тоже помечает как missingIds=все,
// и снаружи это неотличимо от обрыва вывода без сырого текста в логах.
// Не бросаем ошибку (это ортогонально к самому REFINE/DIALOGUE — уже
// обработанный chunk просто останется неизменным, applyRefinedLines/
// applyDialogueLines это переживают), но логируем, иначе причину нулевого
// changedRatio на проде не продиагностировать без ручного репро.
function logIfTotalMiss(pass, raw, { byId, missingIds }, ids) {
  if (byId.size > 0 || missingIds.length !== ids.length) return;
  logger.warn(`${pass}: total miss — модель не вернула ни одной строки в ожидаемом формате`, {
    idsCount: ids.length,
    rawPreview: (raw ?? "").slice(0, 300)
  });
}

export class YcYandexGptGateway {
  constructor({
    folderId,
    model = process.env.GPT_MODEL ?? "yandexgpt-lite",
    // Диалог зовётся редко (по кнопке, раз на встречу) и требует лучшего
    // владения языком, чем термин-ориентированный REFINE — Pro оправдан.
    dialogueModel = process.env.GPT_DIALOGUE_MODEL ?? "yandexgpt"
  }) {
    this.folderId = folderId;
    // Lite выбран по бенчмарку (scripts/experiments/llm-refine-bench):
    // WER-восстановление 63% при цене в 6 раз ниже Pro
    this.modelUri = `gpt://${folderId}/${model}/latest`;
    this.client = new YandexGptClient({ modelUri: this.modelUri });
    this.dialogueModelUri = `gpt://${folderId}/${dialogueModel}/latest`;
    this.dialogueClient = new YandexGptClient({ modelUri: this.dialogueModelUri });
    logger.info("YandexGPT: initialized", {
      folderId, modelUri: this.modelUri, dialogueModelUri: this.dialogueModelUri
    });
  }

  // ============================================================
  // STAGE A1: GPT Diarization
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
    return this._segmentsToTranscript(result.segments, transcript, "A1");
  }

  /**
   * Разбивает ЛЮБОЙ транскрипт (не только mono) на реплики по спикерам через
   * GPT, опираясь на известный состав участников встречи (команда проекта +
   * гости). Вызывается ВСЕГДА кнопкой «Разметить аудио с ИИ» — диаризация
   * SpeechKit (channelTag) на реальных записях часто ошибается (одноканальная
   * запись, перегородки, шум), поэтому не считаем её достаточной сама по себе.
   *
   * @param {object} transcript - { phrases, rawText, ... }
   * @param {string} domain - предметная сфера для промпта
   * @param {string[]} participants - имена участников встречи (команда + гости)
   * @returns {object} обновлённый transcript с разбивкой по спикерам
   */
  async diarizeByProjectTeam(transcript, domain, participants = []) {
    const rawText = transcript.rawText ?? "";
    if (rawText.trim().length < 50) {
      logger.info("GPT A1b: skipped (transcript too short for diarization)");
      return transcript;
    }

    logger.info("GPT A1b: diarization by project team", {
      chars: rawText.length, domain, participants: participants.length
    });

    // Убираем метки спикеров SpeechKit И склеиваем текст в один сплошной
    // поток без переносов строк. Просто убрать префиксы "Спикер N:" мало:
    // rawText собран из phrases построчно (см. postprocessTranscript), и эти
    // границы строк — уже ошибочная диаризация SpeechKit по каналу/паузам
    // (на реальных записях канал общий на нескольких говорящих, поэтому
    // SpeechKit режет одну фразу на "спикеров" через каждые несколько слов).
    // Если оставить построчную структуру, модель в среднем просто повторяет
    // эти же ложные границы вместо того, чтобы заново собрать текст в реплики
    // по смыслу — что и есть весь смысл этого прохода.
    const cleanText = rawText
      .replace(/^Спикер \d+:\s*/gm, "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    const { system, user, options } = promptDiarizationByTeam({
      transcriptText: cleanText.slice(0, 20_000),
      domain,
      participants
    });

    const raw = await this.client.complete(system, user, options);
    const result = YandexGptClient.parseJson(raw, { segments: [] }, "A1b");
    return this._segmentsToTranscript(result.segments, transcript, "A1b");
  }

  /**
   * Общий постпроцессинг ответа диаризации (A1/A1b): валидация, назначение
   * speakerId по порядку появления, пропорциональный пересчёт временных меток.
   */
  _segmentsToTranscript(rawSegments, transcript, passLabel) {
    const segments = Array.isArray(rawSegments) ? rawSegments : [];
    if (segments.length < 2) {
      logger.warn(`GPT ${passLabel}: returned <2 segments, keeping original`, {
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

    logger.info(`GPT ${passLabel}: diarization done`, {
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
    const result = parseRefinedLines(raw, ids);
    logIfTotalMiss("refine", raw, result, ids);
    return result;
  }

  /**
   * Литературная запись чанка реплик (проход «Диалог», после REFINE).
   * На Pro-модели (см. конструктор) — вызывается редко, качество важнее цены.
   *
   * @param {{ lines: string[], ids: number[], contextLines: string[], domain: string, glossary: object|null }} params
   * @returns {Promise<{ byId: Map<number, string>, missingIds: number[] }>}
   */
  async rewriteDialogueLines({ lines, ids, contextLines = [], domain, glossary = null }) {
    const { system, user, options } = promptDialogueRewrite({
      numberedLines: lines,
      contextLines,
      domain,
      glossary
    });
    const raw = await this.dialogueClient.complete(system, user, options);
    const result = parseRefinedLines(raw, ids);
    logIfTotalMiss("dialogue", raw, result, ids);
    return result;
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

  async identifySpeakers({ correctedText, transcript, project, context }) {
    logger.info("GPT B2: speaker identification");

    const speakerStats = transcript.speakerStats ?? [];
    const { system, user, options } = promptSpeakerIdentification({
      transcriptText: correctedText,
      speakerStats,
      projectTeam: project.team ?? [],
      context
    });

    const raw = await this.client.complete(system, user, options);
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

  async extractProtocol({ correctedText, meeting, project, context, speakers, previousProtocol }) {
    logger.info("GPT C1: protocol extraction");

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

    const raw = await this.client.complete(system, user, options);

    // Пытаемся вытащить JSON из markdown-блока или напрямую
    const jsonCandidate = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();

    const defaultProtocol = {
      summary: { title: meeting.titleDraft ?? project.name, overview: "" },
      participants: [], decisions: [], actionItems: [],
      completedFromPrevious: [], carriedForward: [],
      openQuestions: [], transcriptHighlights: []
    };

    let protocol;
    try {
      protocol = JSON.parse(jsonCandidate);
    } catch (e) {
      logger.error("GPT C1: invalid JSON, using default", { error: e.message, preview: raw.slice(0, 300) });
      protocol = defaultProtocol;
    }

    // Гарантируем все поля
    protocol.summary ??= { title: meeting.titleDraft ?? project.name, overview: "" };
    protocol.participants ??= [];
    protocol.decisions ??= [];
    protocol.actionItems ??= [];
    protocol.completedFromPrevious ??= [];
    protocol.carriedForward ??= [];
    protocol.openQuestions ??= [];
    protocol.transcriptHighlights ??= [];

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
  async qaProtocol({ protocol, correctedText, context }) {
    if (context.transcriptQuality === "good") {
      logger.info("GPT D: skipped (quality=good)");
      return protocol;
    }

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
      { missedActions: [], missedDecisions: [], overallCompleteness: "medium" },
      "D2"
    );

    logger.info("GPT D: done", {
      suggestedRemovals: faithfulness.suggestedRemovals?.length ?? 0,
      missedActions: completeness.missedActions?.length ?? 0,
      overallCompleteness: completeness.overallCompleteness
    });

    // Применяем результаты QA
    const patchedProtocol = { ...protocol };

    // Удаляем выдуманные пункты (fabricated)
    if (faithfulness.suggestedRemovals?.length) {
      const removals = new Set(faithfulness.suggestedRemovals.map((r) => r.toLowerCase().slice(0, 50)));
      patchedProtocol.decisions = protocol.decisions.filter(
        (d) => !removals.has(d.toLowerCase().slice(0, 50))
      );
      patchedProtocol.actionItems = protocol.actionItems.filter(
        (a) => !removals.has(a.task?.toLowerCase().slice(0, 50))
      );
    }

    // Добавляем пропущенные задачи
    if (completeness.missedActions?.length) {
      for (const action of completeness.missedActions) {
        if (action.task && action.owner) {
          patchedProtocol.actionItems = [...patchedProtocol.actionItems, action];
        }
      }
    }

    // Добавляем пропущенные решения
    if (completeness.missedDecisions?.length) {
      patchedProtocol.decisions = [...patchedProtocol.decisions, ...completeness.missedDecisions];
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
      // D1+D2: QA (только для fair/poor транскриптов)
      protocol = await this.qaProtocol({ protocol, correctedText, context });
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
      logger.info("GPT C: map-reduce used, QA skipped", { chars: correctedText.length });
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
      participants: [...new Set(partials.flatMap((p) => p.participants ?? []))],
      decisions: partials.flatMap((p) => p.decisions ?? []),
      actionItems: partials.flatMap((p) => p.actionItems ?? []),
      completedFromPrevious: partials.flatMap((p) => p.completedFromPrevious ?? []),
      carriedForward: partials.flatMap((p) => p.carriedForward ?? []),
      openQuestions: partials.flatMap((p) => p.openQuestions ?? []),
      transcriptHighlights: partials.flatMap((p) => p.transcriptHighlights ?? []).slice(0, 5)
    };

    // Reduce: LLM-консолидация (дедуп решений/задач, цельная сводка)
    try {
      const { system, user, options } = promptProtocolReduce({
        merged,
        meetingDate: meeting.date ?? "не указана",
        projectName: project.name,
        domain: context.domain
      });
      const raw = await this.client.complete(system, user, options);
      const reduced = YandexGptClient.parseJson(raw, null, "C-reduce");
      if (reduced?.summary) {
        // Сохраняем структуру: отсутствующие поля добираем из merged
        return {
          ...merged,
          ...reduced,
          summary: { ...merged.summary, ...reduced.summary }
        };
      }
    } catch (e) {
      logger.warn("GPT C reduce failed, using programmatic merge", { error: e.message });
    }
    return merged;
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

  if (protocol.decisions.length > 0) {
    lines.push("── ПРИНЯТЫЕ РЕШЕНИЯ ────────────────────────");
    protocol.decisions.forEach((d, i) => lines.push(`  ${i + 1}. ${d}`));
    lines.push("");
  }

  if (protocol.actionItems.length > 0) {
    lines.push("── ЗАДАЧИ ──────────────────────────────────");
    protocol.actionItems.forEach((a, i) =>
      lines.push(`  ${i + 1}. [${a.owner}] ${a.task}  →  до ${a.deadline ?? "—"}`)
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
      lines.push(`  ${i + 1}. ✓  [${a.owner}] ${a.task}`)
    );
    lines.push("");
  }

  if (protocol.carriedForward?.length > 0) {
    lines.push("── ПЕРЕНЕСЕНО ──────────────────────────────");
    protocol.carriedForward.forEach((a, i) =>
      lines.push(`  ${i + 1}. ➜  [${a.owner}] ${a.task}  →  до ${a.deadline ?? "—"}`)
    );
    lines.push("");
  }

  if (protocol.transcriptHighlights?.length > 0) {
    lines.push("── КЛЮЧЕВЫЕ МОМЕНТЫ ────────────────────────");
    protocol.transcriptHighlights.forEach((h) =>
      lines.push(`  — ${h.speaker}: «${h.quote}»`)
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
