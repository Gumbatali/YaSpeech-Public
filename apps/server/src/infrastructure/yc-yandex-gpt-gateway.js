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
  // STAGE A: ASR Correction
  // ============================================================

  /**
   * Исправляет ASR-ошибки путём параллельной обработки чанков.
   * Возвращает исправленный rawText и обогащённые phrases.
   */
  async correctTranscript(transcript, domain) {
    const chunks = chunkPhrases(transcript.phrases ?? []);

    if (chunks.length === 1 && chunks[0].text.length < 2000) {
      // Очень короткий транскрипт — пропускаем коррекцию, не стоит токенов
      logger.info("GPT A2: skipped (transcript too short)", { chars: chunks[0].text.length });
      return { correctedText: chunks[0].text, glossary: null };
    }

    logger.info("GPT A2: correcting", { chunks: chunks.length, domain });

    // Параллельная коррекция всех чанков
    const correctionRequests = chunks.map((chunk) => {
      const { system, user, options } = promptAsrCorrection({
        chunkText: chunk.text,
        domain,
        chunkIndex: chunk.index,
        totalChunks: chunk.total
      });
      return { system, user, options };
    });

    const rawResults = await this.client.completeBatch(correctionRequests);

    // Разбираем ответы
    const chunkResults = rawResults.map((raw, i) => {
      const parsed = YandexGptClient.parseJson(raw, { correctedLines: [] }, `A2 chunk ${i}`);
      const lines = Array.isArray(parsed.correctedLines) ? parsed.correctedLines : [];
      return { phrases: chunks[i].phrases, correctedLines: lines };
    });

    const correctedText = mergeChunkResults(chunkResults);

    // Pass A3: глоссарий (только если длинный транскрипт)
    let glossary = null;
    if (chunks.length > 1) {
      logger.info("GPT A3: extracting glossary");
      const { system, user, options } = promptGlossary({ correctedText, domain });
      const glossaryRaw = await this.client.complete(system, user, options);
      glossary = YandexGptClient.parseJson(glossaryRaw, { terms: [], abbreviations: {} }, "A3");
      logger.info("GPT A3: done", { terms: glossary.terms?.length ?? 0 });
    }

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

    let protocol;
    try {
      protocol = JSON.parse(raw);
    } catch (e) {
      logger.error("GPT C1: invalid JSON", { error: e.message, preview: raw.slice(0, 500) });
      throw new Error(`YandexGPT вернул некорректный JSON для протокола: ${e.message}`);
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
  async generateDraft({ project, transcript, meeting }) {
    // B0: предварительный контекст для определения домена (нужен для A2)
    const quickContext = await this.analyzeContext({
      correctedText: transcript.rawText.slice(0, 8000),
      projectName: project.name
    });

    // A2+A3: коррекция с учётом домена
    const domain = quickContext.domain || "общий";
    const { correctedText, glossary } = await this.correctTranscript(transcript, domain);

    // B1: полный контекст уже на исправленном тексте
    const context = correctedText !== transcript.rawText
      ? await this.analyzeContext({ correctedText, projectName: project.name })
      : quickContext;

    // B2: идентификация спикеров
    const speakerDrafts = await this.identifySpeakers({
      correctedText,
      transcript,
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
      transcriptSegments: (transcript.phrases ?? []).map((p) => {
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
  async generateProtocol({ meeting, project, transcript, previousProtocol = null }) {
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
    return { protocol, protocolText };
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
