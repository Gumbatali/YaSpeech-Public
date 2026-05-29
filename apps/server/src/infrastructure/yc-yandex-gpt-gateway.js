/**
 * YandexGPT Gateway — многопроходной анализ транскрипта.
 *
 * Стадии:
 *   A  — коррекция ASR:    A2 (коррекция чанков), A3 (глоссарий)
 *   B  — понимание:        B1 (контекст), B2 (спикеры)
 *   C  — генерация:        C1 (протокол)
 *   D  — QA:               D1 (достоверность), D2 (полнота)  [только при хорошем качестве]
 *
 * Оптимизации:
 *   - Чанки A2 обрабатываются параллельно
 *   - Стадии D пропускаются при quality="good" (нет смысла тратить токены)
 *   - Сохраняем context в meeting.gptContext для retry без повторных вызовов
 */

import { YandexGptClient } from "./llm/yandex-gpt-client.js";
import { chunkPhrases, mergeChunkResults } from "../application/transcription/chunker.js";
import {
  promptDiarization,
  promptAsrCorrection,
  promptGlossary,
  promptContextAnalysis,
  promptSpeakerIdentification,
  promptProtocolExtraction,
  promptFaithfulnessCheck,
  promptCompletenessCheck
} from "./llm/prompts.js";
import { logger } from "../shared/logger.js";

const MAX_TRANSCRIPT_CHARS = 22_000;

export class YcYandexGptGateway {
  constructor({ folderId }) {
    this.folderId = folderId;
    this.modelUri = `gpt://${folderId}/yandexgpt/latest`;
    this.client = new YandexGptClient({ modelUri: this.modelUri });
    logger.info("YandexGPT: initialized", { folderId, modelUri: this.modelUri });
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
  // STAGE A: ASR Correction
  // ============================================================

  /**
   * Исправляет ASR-ошибки путём параллельной обработки чанков.
   * Возвращает исправленный rawText и обогащённые phrases.
   */
  async correctTranscript(transcript, domain, projectGlossary = null) {
    const chunks = chunkPhrases(transcript.phrases ?? []);

    if (chunks.length === 1 && chunks[0].text.length < 2000) {
      // Очень короткий транскрипт — пропускаем коррекцию, не стоит токенов
      logger.info("GPT A2: skipped (transcript too short)", { chars: chunks[0].text.length });
      return { correctedText: chunks[0].text, glossary: null };
    }

    logger.info("GPT A2+A3: correcting", { chunks: chunks.length, domain });

    // Pass A3 СНАЧАЛА: глоссарий на сыром тексте
    // Если есть накопленный глоссарий проекта — используем его как основу
    let glossary = projectGlossary ?? null;
    const rawTranscriptText = chunks.map((c) => c.text).join("\n");

    if (rawTranscriptText.length > 2000) {
      logger.info("GPT A3: extracting glossary from raw transcript", {
        hasProjectGlossary: !!projectGlossary,
        projectTerms: projectGlossary?.terms?.length ?? 0
      });
      const { system: gSys, user: gUsr, options: gOpts } = promptGlossary({
        correctedText: rawTranscriptText,
        domain
      });
      const glossaryRaw = await this.client.complete(gSys, gUsr, gOpts);
      const meetingGlossary = YandexGptClient.parseJson(glossaryRaw, { terms: [], abbreviations: {} }, "A3");
      logger.info("GPT A3: done", { terms: meetingGlossary.terms?.length ?? 0 });

      // Мержим глоссарий встречи с накопленным проектным
      if (projectGlossary) {
        const termMap = new Map(projectGlossary.terms.map((t) => [t.term, t]));
        for (const t of (meetingGlossary.terms ?? [])) {
          if (!termMap.has(t.term)) termMap.set(t.term, t);
        }
        glossary = {
          terms: [...termMap.values()],
          abbreviations: { ...projectGlossary.abbreviations, ...meetingGlossary.abbreviations }
        };
      } else {
        glossary = meetingGlossary;
      }
    }

    // Pass A2: коррекция чанков с объединённым глоссарием
    const correctionRequests = chunks.map((chunk) => {
      const { system, user, options } = promptAsrCorrection({
        chunkText: chunk.text,
        domain,
        chunkIndex: chunk.index,
        totalChunks: chunk.total,
        glossary
      });
      return { system, user, options };
    });

    const rawResults = await this.client.completeBatch(correctionRequests);

    // Разбираем ответы
    const chunkResults = rawResults.map((raw, i) => {
      const parsed = YandexGptClient.parseJson(raw, { correctedLines: [] }, `A2 chunk ${i}`);
      let lines = Array.isArray(parsed.correctedLines) ? parsed.correctedLines : [];
      // Если LLM вернул пустой список — fallback на исходный текст чанка
      if (lines.length === 0) {
        logger.warn("GPT A2: empty correctedLines, using raw chunk text", { chunkIndex: i });
        lines = chunks[i].text.split("\n").filter(Boolean);
      }
      return { phrases: chunks[i].phrases, correctedLines: lines };
    });

    const correctedText = mergeChunkResults(chunkResults);

    return { correctedText, glossary };
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
   * Stage A+B: коррекция ASR + контекстный анализ + идентификация спикеров.
   * Вызывается после SpeechKit, до показа черновика пользователю.
   */
  async generateDraft({ project, transcript, meeting, projectGlossary = null }) {
    // B0: предварительный контекст для определения домена (нужен для A1 и A2)
    const quickContext = await this.analyzeContext({
      correctedText: transcript.rawText.slice(0, 8000),
      projectName: project.name
    });

    const domain = quickContext.domain || "общий";
    const mentionedPeople = quickContext.mentionedEntities?.people ?? [];

    // A1: GPT-диаризация (только если mono — всё в 1 спикере)
    const diarizedTranscript = await this.diarizeTranscript(transcript, domain, mentionedPeople);

    // A2+A3: коррекция с учётом домена + накопленный глоссарий проекта
    const { correctedText, glossary } = await this.correctTranscript(diarizedTranscript, domain, projectGlossary);

    // B1: полный контекст уже на исправленном тексте
    const context = correctedText !== diarizedTranscript.rawText
      ? await this.analyzeContext({ correctedText, projectName: project.name })
      : quickContext;

    // При poor quality — продолжаем, но логируем. Предупреждение попадёт в context.
    if (context.transcriptQuality === "poor") {
      logger.warn("GPT B1: poor transcript quality, continuing with best effort", {
        note: context.confidenceNote
      });
    }

    // B2: идентификация спикеров (используем diarizedTranscript — уже с несколькими спикерами)
    const speakerDrafts = await this.identifySpeakers({
      correctedText,
      transcript: diarizedTranscript,
      project,
      context
    });

    return {
      titleDraft: this._deriveDraftTitle(context, project),
      speakerDrafts: speakerDrafts.map((s) => ({
        id: s.id,
        label: s.label,
        guessedName: s.guessedName,
        confidence: s.confidence ?? "low"
      })),
      context,
      correctedText,
      glossary: glossary ?? undefined,
      transcriptPreview: correctedText.slice(0, 2000),
      transcriptSegments: (diarizedTranscript.phrases ?? []).map((p) => {
        const draft = speakerDrafts.find((s) => s.id === p.speakerId);
        return {
          speakerId: p.speakerId,
          speakerLabel: p.speakerLabel,
          guessedName: draft?.guessedName ?? null,
          text: p.text
        };
      })
    };
  }

  /**
   * Stage C+D: генерация финального протокола.
   * Вызывается после подтверждения черновика пользователем.
   */
  async generateProtocol({ meeting, project, transcript, previousProtocol = null, projectGlossary = null }) {
    // Используем correctedText из meeting если есть (был сохранён в gptContext)
    const correctedText = meeting.gptContext?.correctedText
      ?? transcript.rawText.slice(0, MAX_TRANSCRIPT_CHARS);

    // Контекст из meeting или анализируем заново
    const context = meeting.gptContext ?? await this.analyzeContext({
      correctedText,
      projectName: project.name
    });

    const speakers = (meeting.speakerDrafts ?? []).map((s) => ({
      id: s.id,
      label: s.label,
      guessedName: s.guessedName,
      guessedRole: null,
      confidence: s.confidence
    }));

    // C1: базовый протокол
    let protocol = await this.extractProtocol({
      correctedText,
      meeting,
      project,
      context,
      speakers,
      previousProtocol
    });

    // D1+D2: QA (только для fair/poor транскриптов)
    protocol = await this.qaProtocol({ protocol, correctedText, context });

    const protocolText = buildProtocolText(protocol, meeting, project, context);
    // Возвращаем глоссарий из meeting.gptContext чтобы pipeline мог его накопить
    const glossary = meeting.gptContext?.glossary ?? null;
    return { protocol, protocolText, glossary };
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
      lines.push(`  ${i + 1}. [${a.owner}] ${a.task}  →  до ${a.deadline}`)
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
      lines.push(`  ${i + 1}. ➜  [${a.owner}] ${a.task}  →  до ${a.deadline}`)
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
