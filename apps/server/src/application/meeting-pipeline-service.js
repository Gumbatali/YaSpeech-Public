import {
  FinalizeProtocolUseCase,
  RetryMeetingUseCase
} from "../../../../packages/core/src/index.js";
import {
  markAsrStarted,
  incrementAsrPoll
} from "../../../../packages/core/src/domain/meeting.js";
import { logger } from "../shared/logger.js";
import { postprocessTranscript } from "./transcript-postprocessor.js";

export class MeetingPipelineService {
  constructor({
    meetingRepository,
    projectRepository,
    artifactStorage,
    speechKitGateway,
    yandexGptGateway,
    queueRunner,
    clock
  }) {
    this.meetingRepository = meetingRepository;
    this.projectRepository = projectRepository;
    this.artifactStorage = artifactStorage;
    this.speechKitGateway = speechKitGateway;
    this.yandexGptGateway = yandexGptGateway;
    this.queueRunner = queueRunner;
    this.clock = clock;
  }

  async enqueueProcessing(meetingId) {
    await this.queueRunner.enqueue(`meeting:${meetingId}`, async () => {
      await this.processMeeting(meetingId, null);
    });
  }

  /**
   * Enqueue конкретной фазы с задержкой (для split-ASR поллинга).
   */
  async _enqueuePhase(meetingId, phase, delaySeconds = 0) {
    await this.queueRunner.enqueue(
      `meeting:${meetingId}:${phase}`,
      async () => { await this.processMeeting(meetingId, phase); },
      { delaySeconds, phase, meetingId }
    );
  }

  async retry(meetingId) {
    const failedMeeting = await this.meetingRepository.getById(meetingId);

    const meeting = await new RetryMeetingUseCase(
      this.meetingRepository,
      this.clock
    ).execute({ meetingId });

    // Если предыдущий сбой был на стадии генерации протокола — пропускаем SpeechKit
    let savedMeeting = meeting;
    if (failedMeeting?.currentStage === "protocol_generating") {
      savedMeeting = {
        ...meeting,
        status: "protocol_generating",
        currentStage: "protocol_generating",
        updatedAt: this.clock.now().toISOString()
      };
      await this.meetingRepository.save(savedMeeting);
    }

    await this.enqueueProcessing(meetingId);
    logger.info("Meeting retry enqueued", { meetingId, stage: savedMeeting.currentStage });
    return savedMeeting; // возвращаем актуальный объект (#7 fix)
  }

  async confirmDraft(meetingId, { titleDraft, speakerDrafts }) {
    const meeting = await this.meetingRepository.getById(meetingId);
    if (!meeting) {
      throw new Error(`Meeting not found: ${meetingId}`);
    }

    const updatedMeeting = {
      ...meeting,
      titleDraft: titleDraft?.trim() || meeting.titleDraft,
      speakerDrafts: Array.isArray(speakerDrafts) && speakerDrafts.length > 0
        ? speakerDrafts.map((speaker) => ({
            id: speaker.id,
            label: speaker.label,
            guessedName: speaker.guessedName?.trim() || null,
            confidence: speaker.confidence ?? "unknown"
          }))
        : meeting.speakerDrafts,
      status: "protocol_generating",
      currentStage: "protocol_generating",
      updatedAt: this.clock.now().toISOString(),
      error: undefined
    };

    await this.meetingRepository.save(updatedMeeting);
    this.enqueueProcessing(meetingId);
    return updatedMeeting;
  }

  /**
   * Главный роутер. Вызывается воркером, принимает phase из сообщения очереди.
   *
   * Маршрутизация по статусу meeting + phase:
   *   "uploaded"              + (null | "start")  → startAsrPhase
   *   "speechkit_processing"  + "poll-asr"        → pollAsrPhase
   *   "protocol_generating"   + any               → generateProtocol
   */
  async processMeeting(meetingId, phase = null) {
    const meeting = await this.meetingRepository.getById(meetingId);
    const VALID_STATUSES = ["uploaded", "speechkit_processing", "protocol_generating"];
    if (!meeting || !VALID_STATUSES.includes(meeting.status)) {
      logger.warn("processMeeting: skipped", { meetingId, status: meeting?.status, phase });
      return;
    }

    const project = await this.projectRepository.getById(meeting.projectId);
    if (!project) {
      throw new Error(`Project not found for meeting ${meetingId}`);
    }

    logger.info("processMeeting: start", { meetingId, status: meeting.status, phase, projectId: meeting.projectId });

    try {
      if (meeting.status === "uploaded" && (phase === null || phase === "start")) {
        await this.startAsrPhase(meeting, project);
        logger.info("processMeeting: ASR started, poll enqueued", { meetingId });
        return;
      }

      if (meeting.status === "speechkit_processing" && phase === "poll-asr") {
        await this.pollAsrPhase(meeting, project);
        return;
      }

      if (meeting.status === "protocol_generating") {
        await this.generateProtocol(meeting, project);
        logger.info("processMeeting: protocol done", { meetingId });
        return;
      }

      logger.warn("processMeeting: unhandled state", { meetingId, status: meeting.status, phase });
    } catch (error) {
      const failedMeeting = await this.meetingRepository.getById(meetingId);
      if (!failedMeeting) throw error;

      const code = error.code ??
        (failedMeeting.currentStage === "protocol_generating" ? "YANDEX_GPT_ERROR" : "SPEECHKIT_ERROR");

      logger.error(`processMeeting: failed [${code}] ${error.message}`, { meetingId });

      await this.meetingRepository.save({
        ...failedMeeting,
        status: "failed",
        updatedAt: this.clock.now().toISOString(),
        error: { code, message: error.message }
      });
    }
  }

  /**
   * Фаза 1 — запускаем ASR и немедленно выходим.
   * Время работы: секунды (только HTTP-запрос к SpeechKit).
   */
  async startAsrPhase(meeting, project) {
    await this.meetingRepository.save({
      ...meeting,
      status: "speechkit_processing",
      currentStage: "speechkit_processing",
      updatedAt: this.clock.now().toISOString()
    });

    const { operationId } = await this.speechKitGateway.startRecognition({ meeting, project });

    const updatedMeeting = markAsrStarted(meeting, operationId, this.clock.now().toISOString());
    await this.meetingRepository.save(updatedMeeting);

    // Ставим poll в очередь с задержкой 15 сек
    await this._enqueuePhase(meeting.id, "poll-asr", 15);
    logger.info("startAsrPhase: done", { meetingId: meeting.id, operationId });
  }

  /**
   * Фаза 2 — однократный опрос ASR.
   * Не готово → re-enqueue; готово → продолжаем в prepareDraft.
   * Время работы: секунды (один HTTP-запрос).
   */
  async pollAsrPhase(meeting, project) {
    const operationId  = meeting.asrOperationId;
    const asrStartedAt = meeting.asrStartedAt ? new Date(meeting.asrStartedAt) : null;
    const ASR_TIMEOUT_MS = 40 * 60 * 1000; // 40 минут — hard ceiling

    if (!operationId) {
      throw new Error(`pollAsrPhase: no asrOperationId on meeting ${meeting.id}`);
    }

    // Timeout-защита: если ASR зависло — фейлим встречу
    if (asrStartedAt && Date.now() - asrStartedAt.getTime() > ASR_TIMEOUT_MS) {
      const err = new Error("SpeechKit: recognition timed out after 40 minutes");
      err.code = "SPEECHKIT_TIMEOUT";
      throw err;
    }

    const result = await this.speechKitGateway.pollRecognitionOnce({ meeting, project, operationId });

    if (!result.done) {
      // Не готово — incrementируем счётчик и перепланируем через 15 сек
      const polled = incrementAsrPoll(meeting, this.clock.now().toISOString());
      await this.meetingRepository.save(polled);
      logger.info("pollAsrPhase: not ready, re-enqueue", {
        meetingId: meeting.id, pollCount: polled.asrPollCount
      });
      await this._enqueuePhase(meeting.id, "poll-asr", 15);
      return;
    }

    // ASR готов — передаём управление в prepareDraftFromTranscript
    logger.info("pollAsrPhase: ASR done, continuing to draft", { meetingId: meeting.id });
    await this.prepareDraftFromTranscript(meeting, project, result.jobId, result.transcript);
  }

  /**
   * Продолжение после получения транскрипта от ASR.
   * Вызывается из pollAsrPhase когда ASR готов.
   */
  async prepareDraftFromTranscript(meeting, project, jobId, rawTranscript) {

    // Postprocessing — чистим, склеиваем, переименовываем спикеров
    const transcript = postprocessTranscript(rawTranscript);

    // ── Hard gate: проверка качества расшифровки ─────────────────────────────
    const wordCount = (rawTranscript.rawText ?? "").trim().split(/\s+/).filter(Boolean).length;
    if (rawTranscript.phrases.length === 0 || wordCount < 20) {
      const err = new Error(
        "Не удалось распознать речь в записи. " +
        "Проверьте: запись не пустая, звук достаточно громкий, язык — русский."
      );
      err.code = "POOR_TRANSCRIPT";
      throw err;
    }
    // ────────────────────────────────────────────────────────────────────────

    // Сохраняем и сырой, и обработанный — для отладки и retry
    await this.artifactStorage.writeJson(meeting.artifacts.transcriptKey, transcript);
    const rawKey = meeting.artifacts.transcriptKey.replace(/\.json$/, ".raw.json");
    await this.artifactStorage.writeJson(rawKey, rawTranscript);
    logger.info("prepareDraft: transcript saved", {
      phrases: rawTranscript.phrases.length,
      wordCount: (rawTranscript.rawText ?? "").trim().split(/\s+/).filter(Boolean).length,
      rawTextPreview: rawTranscript.rawText.slice(0, 200)
    });

    // Загружаем накопленный глоссарий проекта для улучшения A2-коррекции
    const projectGlossary = await this.projectRepository.getGlossary(meeting.projectId).catch((err) => {
      logger.warn("pipeline: failed to load project glossary, continuing without it", {
        projectId: meeting.projectId,
        error: err.message
      });
      return null;
    });

    const draft = await this.yandexGptGateway.generateDraft({
      meeting,
      project,
      transcript,
      projectGlossary
    });

    // Если GPT-диаризация сработала — перезаписываем transcript.json с разбивкой по спикерам
    if (draft.transcriptSegments?.length > 0) {
      const speakerIds = new Set(draft.transcriptSegments.map((s) => s.speakerId));
      if (speakerIds.size > 1) {
        const diarizedPhrases = draft.transcriptSegments.map((seg) => ({
          speakerId: seg.speakerId,
          speakerLabel: seg.speakerLabel,
          detectedName: seg.guessedName ?? null,
          startTimeMs: 0,
          endTimeMs: 0,
          text: seg.text
        }));
        const diarizedRawText = diarizedPhrases
          .map((p) => `${p.speakerLabel}: ${p.text}`)
          .join("\n");
        await this.artifactStorage.writeJson(meeting.artifacts.transcriptKey, {
          ...transcript,
          phrases: diarizedPhrases,
          rawText: diarizedRawText,
          diarizedByGpt: true
        });
        logger.info("prepareDraft: transcript updated with GPT diarization", {
          speakers: speakerIds.size,
          segments: diarizedPhrases.length
        });
      }
    }

    const draftMeeting = {
      ...(await this.meetingRepository.getById(meeting.id)),
      speechKitJobId: jobId,
      titleDraft: draft.titleDraft,
      speakerDrafts: draft.speakerDrafts,
      transcriptPreview: draft.transcriptPreview,
      transcriptSegments: draft.transcriptSegments,
      // Сырые сегменты из SpeechKit (до LLM-коррекции) — для вкладки "Дословно" в UI
      rawTranscriptSegments: rawTranscript.phrases ?? [],
      gptContext: {
        ...draft.context,
        correctedText: draft.correctedText, // сохраняем исправленный текст для pass C
        glossary: draft.glossary ?? null    // сохраняем глоссарий для накопления в проекте
      },
      status: "draft_ready",
      currentStage: "draft_ready",
      updatedAt: this.clock.now().toISOString()
    };

    await this.meetingRepository.save(draftMeeting);
  }

  async generateProtocol(meeting, project) {
    const transcript = await this.artifactStorage.readJson(meeting.artifacts.transcriptKey);
    if (!transcript) {
      throw new Error("Transcript not found for protocol generation.");
    }

    // Загружаем предыдущий протокол и накопленный глоссарий проекта параллельно
    let previousProtocol = null;
    let projectGlossary = null;
    try {
      const [allMeetings, glossary] = await Promise.all([
        this.meetingRepository.listByProject(meeting.projectId),
        this.projectRepository.getGlossary(meeting.projectId)
      ]);

      projectGlossary = glossary;

      const prevMeeting = allMeetings
        .filter((m) => m.id !== meeting.id && m.status === "done")
        .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];

      if (prevMeeting) {
        const prevFull = await this.meetingRepository.getById(prevMeeting.id);
        if (prevFull?.artifacts?.protocolJsonKey) {
          previousProtocol = await this.artifactStorage.readJson(
            prevFull.artifacts.protocolJsonKey
          );
        }
      }
    } catch {
      // не критично — продолжаем без предыдущего протокола
    }

    const { protocol, protocolText, glossary: newGlossary } = await this.yandexGptGateway.generateProtocol({
      meeting,
      project,
      transcript,
      previousProtocol,
      projectGlossary
    });

    // Сохраняем обновлённый глоссарий проекта в фоне (не блокируем сохранение протокола)
    if (newGlossary) {
      this.projectRepository.mergeGlossary(meeting.projectId, newGlossary).catch((err) => {
        logger.error("pipeline: failed to merge glossary (background)", {
          projectId: meeting.projectId,
          error: err.message
        });
      });
    }

    await this.artifactStorage.writeJson(meeting.artifacts.protocolJsonKey, protocol);
    await this.artifactStorage.writeText(meeting.artifacts.protocolTextKey, protocolText);

    const finalized = await new FinalizeProtocolUseCase(
      this.meetingRepository,
      this.clock
    ).execute({
      meetingId: meeting.id,
      talkId: meeting.speechKitJobId,
      transcriptKey: meeting.artifacts.transcriptKey,
      protocolJsonKey: meeting.artifacts.protocolJsonKey,
      protocolTextKey: meeting.artifacts.protocolTextKey
    });

    await this.meetingRepository.save({
      ...finalized,
      titleDraft: meeting.titleDraft,
      speakerDrafts: meeting.speakerDrafts,
      transcriptPreview: meeting.transcriptPreview,
      transcriptSegments: meeting.transcriptSegments,
      protocol
    });
  }
}
