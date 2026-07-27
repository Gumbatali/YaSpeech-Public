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
import { buildRefineChunks, applyRefinedLines, applyDialogueLines } from "./transcription/refiner.js";
import { splitWavBySeconds } from "./audio-splitting.js";
import { mergeChunkTranscripts } from "./asr-merge.js";

// Бюджет одного вызова worker-функции: при приближении к таймауту
// refine/dialogue чекпоинтится и пере-enqueue'ится (любая длина аудио).
// Держим запас (execution-timeout функции — 300s, см. scripts/deploy.sh):
// бюджет проверяется ПОСЛЕ каждого чанка, поэтому нужен зазор на сам
// последний вызов LLM + финализацию (identifySpeakers и т.п.), а не только
// на сумму уже выполненных чанков.
const REFINE_TIME_BUDGET_MS = 200_000;

// Лимит на время ОБРАБОТКИ записи (SpeechKit-распознавание), а не на длину
// самого аудиофайла — файл принимается любой длины. Если распознавание не
// укладывается в лимит (зависание, перегрузка сервиса) — встреча падает
// с понятной ошибкой вместо бесконечного поллинга каждые 15 сек.
const PROCESSING_TIME_LIMIT_MS = 20 * 60 * 1000;

// DIALOGUE зовёт Pro-модель (медленнее и дороже Lite, см. yc-yandex-gpt-gateway.js) —
// чанки режем вдвое мельче, чем у REFINE (буфер CHUNK_CHARS в refiner.js),
// чтобы единичный вызов не рисковал сам по себе упереться в таймаут функции
// ДО того, как цикл вообще успеет проверить бюджет времени.
const DIALOGUE_CHUNK_CHARS = 4_000;

// Как подписывать реплики в промпте DIALOGUE — так модель пишет живее,
// чем видя голые "Спикер 1/2/3"
function dialoguePromptLabel(speakerLabel, speakerDraft) {
  if (!speakerDraft?.guessedName) return speakerLabel;
  return speakerDraft.guessedRole
    ? `${speakerDraft.guessedName} (${speakerDraft.guessedRole})`
    : speakerDraft.guessedName;
}

// Записи длиннее этого порога распознаются НЕСКОЛЬКИМИ параллельными
// запросами к SpeechKit (по CHUNK_TARGET_SECONDS каждый) вместо одного
// длинного — так большой файл не рискует упереться в PROCESSING_TIME_LIMIT_MS
// и обрабатывается за время одного чанка, а не суммарно всех.
// Байты, не секунды: размер уже известен на upload-complete (audioFile.sizeBytes),
// а точная длительность — нет (клиент присылает её отдельно, не всегда точно).
// 16kHz mono 16-bit PCM = 32000 байт/сек (см. audio-splitting.js) →
// 30 минут ≈ 57.6 MB.
const PARALLEL_SPLIT_THRESHOLD_BYTES = 30 * 60 * 32_000;
const CHUNK_TARGET_SECONDS = 10 * 60;

export class MeetingPipelineService {
  constructor({
    meetingRepository,
    projectRepository,
    artifactStorage,
    speechKitGateway,
    yandexGptGateway,
    queueRunner,
    clock,
    parallelSplitThresholdBytes = PARALLEL_SPLIT_THRESHOLD_BYTES,
    chunkTargetSeconds = CHUNK_TARGET_SECONDS
  }) {
    this.meetingRepository = meetingRepository;
    this.projectRepository = projectRepository;
    this.artifactStorage = artifactStorage;
    this.speechKitGateway = speechKitGateway;
    this.yandexGptGateway = yandexGptGateway;
    this.queueRunner = queueRunner;
    this.clock = clock;
    // Настраиваемо для тестов — гонять реальные 57 MB буферы в юнит-тестах
    // непрактично, тесты подставляют маленькие пороги.
    this.parallelSplitThresholdBytes = parallelSplitThresholdBytes;
    this.chunkTargetSeconds = chunkTargetSeconds;
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

  /**
   * Ставит в очередь LLM-улучшение расшифровки (кнопка «Улучшить с помощью ИИ»).
   * Ортогонально статусу встречи: не меняет meeting.status.
   */
  async enqueueRefine(meetingId) {
    const meeting = await this.meetingRepository.getById(meetingId);
    if (!meeting) throw new Error(`Meeting not found: ${meetingId}`);

    const updated = {
      ...meeting,
      llmRefine: {
        status: "queued",
        done: 0,
        total: 0,
        requestedAt: this.clock.now().toISOString()
      },
      updatedAt: this.clock.now().toISOString()
    };
    await this.meetingRepository.save(updated);
    await this._enqueuePhase(meetingId, "refine", 0);
    logger.info("Refine enqueued", { meetingId });
    return updated;
  }

  /**
   * Ставит в очередь литературную запись диалога («Собрать диалог»).
   * Требует завершённого REFINE — DIALOGUE переписывает уже точный текст,
   * а не сырой ASR-вывод. Ортогонально статусу встречи, как и enqueueRefine.
   */
  async enqueueDialogue(meetingId) {
    const meeting = await this.meetingRepository.getById(meetingId);
    if (!meeting) throw new Error(`Meeting not found: ${meetingId}`);

    const updated = {
      ...meeting,
      llmDialogue: {
        status: "queued",
        done: 0,
        total: 0,
        requestedAt: this.clock.now().toISOString()
      },
      updatedAt: this.clock.now().toISOString()
    };
    await this.meetingRepository.save(updated);
    await this._enqueuePhase(meetingId, "dialogue", 0);
    logger.info("Dialogue enqueued", { meetingId });
    return updated;
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
            guessedRole: speaker.guessedRole?.trim() || null,
            dialogueRole: speaker.dialogueRole?.trim() || null,
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

    // Refine — ортогональный процесс со своим error-контуром:
    // его сбой помечает llmRefine.status=failed, а НЕ статус встречи
    if (phase === "refine") {
      if (!meeting || !["draft_ready", "done", "failed"].includes(meeting.status)) {
        logger.warn("processMeeting: refine skipped", { meetingId, status: meeting?.status });
        return;
      }
      const project = await this.projectRepository.getById(meeting.projectId);
      try {
        await this.runRefinePhase(meeting, project);
      } catch (error) {
        logger.error(`refine failed: ${error.message}`, { meetingId });
        const fresh = await this.meetingRepository.getById(meetingId);
        if (fresh) {
          await this.meetingRepository.save({
            ...fresh,
            llmRefine: {
              ...(fresh.llmRefine ?? {}),
              status: "failed",
              error: error.message,
              finishedAt: this.clock.now().toISOString()
            },
            updatedAt: this.clock.now().toISOString()
          });
        }
      }
      return;
    }

    // Dialogue — тот же независимый контур, что и refine, но со своим полем
    // llmDialogue и требованием "refine уже завершён" (проверяется в маршруте)
    if (phase === "dialogue") {
      if (!meeting || !["draft_ready", "done", "failed"].includes(meeting.status)) {
        logger.warn("processMeeting: dialogue skipped", { meetingId, status: meeting?.status });
        return;
      }
      const project = await this.projectRepository.getById(meeting.projectId);
      try {
        await this.runDialoguePhase(meeting, project);
      } catch (error) {
        logger.error(`dialogue failed: ${error.message}`, { meetingId });
        const fresh = await this.meetingRepository.getById(meetingId);
        if (fresh) {
          await this.meetingRepository.save({
            ...fresh,
            llmDialogue: {
              ...(fresh.llmDialogue ?? {}),
              status: "failed",
              error: error.message,
              finishedAt: this.clock.now().toISOString()
            },
            updatedAt: this.clock.now().toISOString()
          });
        }
      }
      return;
    }

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
   * Большие записи (см. parallelSplitThresholdBytes) режутся на куски по
   * chunkTargetSeconds и распознаются НЕСКОЛЬКИМИ параллельными запросами —
   * так длинная запись обрабатывается за время одного куска, а не суммарно
   * всех. Короткие записи — как раньше, один запрос.
   * Время работы: секунды-минуты (HTTP-запрос(ы) к SpeechKit + опционально
   * скачивание/разрезание/заливка чанков).
   */
  async startAsrPhase(meeting, project) {
    await this.meetingRepository.save({
      ...meeting,
      status: "speechkit_processing",
      currentStage: "speechkit_processing",
      updatedAt: this.clock.now().toISOString()
    });

    const sizeBytes = meeting.audioFile?.sizeBytes ?? 0;
    const jobs = sizeBytes > this.parallelSplitThresholdBytes
      ? await this._startParallelRecognition(meeting, project)
      : await this._startSingleRecognition(meeting, project);

    const updatedMeeting = markAsrStarted(meeting, jobs, this.clock.now().toISOString());
    await this.meetingRepository.save(updatedMeeting);

    // Ставим poll в очередь с задержкой 15 сек
    await this._enqueuePhase(meeting.id, "poll-asr", 15);
    logger.info("startAsrPhase: done", { meetingId: meeting.id, jobs: jobs.length });
  }

  async _startSingleRecognition(meeting, project) {
    const { operationId } = await this.speechKitGateway.startRecognition({ meeting, project });
    return [{ operationId, offsetSeconds: 0 }];
  }

  /**
   * Скачивает аудио из S3, режет на WAV-чанки по chunkTargetSeconds, заливает
   * каждый обратно в S3 и запускает распознавание ВСЕХ чанков ОДНОВРЕМЕННО
   * (Promise.all — не по очереди). Чанки хранятся рядом с оригиналом
   * (parts/chunk-N.wav), их можно удалить после успешной обработки, но
   * оставлять безвредно (артефакт для отладки).
   */
  async _startParallelRecognition(meeting, project) {
    const audioBuffer = await this.artifactStorage.readBuffer(meeting.artifacts.audioOriginalKey);
    if (!audioBuffer) {
      throw new Error(`startAsrPhase: audio not found at ${meeting.artifacts.audioOriginalKey}`);
    }

    const chunks = splitWavBySeconds(audioBuffer, this.chunkTargetSeconds);
    logger.info("startAsrPhase: splitting for parallel ASR", {
      meetingId: meeting.id, sizeBytes: audioBuffer.length, chunks: chunks.length
    });

    if (chunks.length === 1) {
      // Разрезать не потребовалось (короткая, но большая по sizeBytes из-за
      // формата запись) — не плодим лишний файл в S3, шлём оригинал как есть
      return this._startSingleRecognition(meeting, project);
    }

    const jobs = await Promise.all(chunks.map(async (chunk, index) => {
      const audioKey = `${meeting.artifacts.baseKey}/parts/chunk-${index}.wav`;
      await this.artifactStorage.writeBuffer(audioKey, chunk.wavBuffer, "audio/wav");
      const { operationId } = await this.speechKitGateway.startRecognition({ meeting, project, audioKey });
      return { operationId, offsetSeconds: chunk.offsetSeconds, audioKey };
    }));

    return jobs;
  }

  /**
   * Фаза 2 — однократный опрос ВСЕХ ASR-задач записи (параллельно).
   * Хотя бы одна не готова → re-enqueue; все готовы → сливаем транскрипты
   * (см. asr-merge.js) и продолжаем в prepareDraft.
   * Время работы: секунды (параллельные HTTP-запросы, не последовательные).
   */
  async pollAsrPhase(meeting, project) {
    const jobs = meeting.asrJobs;
    const asrStartedAt = meeting.asrStartedAt ? new Date(meeting.asrStartedAt) : null;

    if (!jobs?.length) {
      throw new Error(`pollAsrPhase: no asrJobs on meeting ${meeting.id}`);
    }

    // Лимит — на время ОБРАБОТКИ (распознавания), а не на длину аудио: файл
    // может быть любой длины (большие режутся на параллельные чанки выше),
    // но если SpeechKit не управился за отведённое время (завис, перегружен,
    // аномально долгая обработка) — фейлим встречу с понятной ошибкой
    // вместо бесконечного поллинга.
    // this.clock.now(), НЕ Date.now(): asrStartedAt записан через инжектируемые
    // часы (RuntimeClock в проде, FakeClock в тестах) — сравнение с реальным
    // Date.now() в тестах молча расходится с ходом реального времени сессии
    // и рано или поздно ложно превышает порог.
    const elapsedMs = asrStartedAt ? this.clock.now().getTime() - asrStartedAt.getTime() : 0;
    if (asrStartedAt && elapsedMs > PROCESSING_TIME_LIMIT_MS) {
      const limitMinutes = Math.round(PROCESSING_TIME_LIMIT_MS / 60000);
      const err = new Error(
        `Обработка записи не уложилась в лимит времени (${limitMinutes} мин). ` +
        "Попробуйте позже — возможно, сервис распознавания сейчас перегружен."
      );
      err.code = "PROCESSING_TIME_LIMIT_EXCEEDED";
      throw err;
    }

    const results = await Promise.all(jobs.map((job) =>
      this.speechKitGateway.pollRecognitionOnce({ meeting, project, operationId: job.operationId })
    ));

    if (results.some((r) => !r.done)) {
      // Хотя бы один чанк ещё не готов — incrementируем счётчик и перепланируем
      const polled = incrementAsrPoll(meeting, this.clock.now().toISOString());
      await this.meetingRepository.save(polled);
      logger.info("pollAsrPhase: not all ready, re-enqueue", {
        meetingId: meeting.id, pollCount: polled.asrPollCount,
        done: results.filter((r) => r.done).length, total: jobs.length
      });
      await this._enqueuePhase(meeting.id, "poll-asr", 15);
      return;
    }

    // Все чанки готовы — сливаем в один транскрипт (offset + сквозная
    // нумерация спикеров по границам чанков, см. asr-merge.js)
    const merged = jobs.length > 1
      ? mergeChunkTranscripts(jobs.map((job, i) => ({
          offsetSeconds: job.offsetSeconds,
          transcript: results[i].transcript
        })))
      : results[0].transcript;
    const jobId = jobs.length > 1 ? `merged:${meeting.id}` : results[0].jobId;

    logger.info("pollAsrPhase: ASR done, continuing to draft", { meetingId: meeting.id, chunks: jobs.length });
    await this.prepareDraftFromTranscript(meeting, project, jobId, merged);
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

    // LLM в draft-фазе НЕ вызывается (решение 2026-06-10: все LLM-вызовы —
    // только по кнопке пользователя). Черновик собирается из сырых данных
    // SpeechKit; обогащение — кнопкой «Улучшить с помощью ИИ» (runRefinePhase).
    const phrases = transcript.phrases ?? [];

    // Спикеры — как их разделил SpeechKit
    const speakerIds = [...new Set(phrases.map((p) => p.speakerId))];
    const speakerDrafts = speakerIds.map((id, i) => {
      const sample = phrases.find((p) => p.speakerId === id);
      return {
        id,
        label: sample?.speakerLabel ?? `Спикер ${i + 1}`,
        guessedName: sample?.detectedName ?? null,
        guessedRole: null,
        dialogueRole: null,
        confidence: sample?.detectedName ? "high" : "low"
      };
    });

    const transcriptSegments = phrases.map((p) => ({
      speakerId: p.speakerId,
      speakerLabel: p.speakerLabel,
      guessedName: p.detectedName ?? null,
      text: p.text,
      startTimeMs: p.startTimeMs ?? null,
      endTimeMs: p.endTimeMs ?? null
    }));

    const draftMeeting = {
      ...(await this.meetingRepository.getById(meeting.id)),
      speechKitJobId: jobId,
      titleDraft: `${project.name} — ${meeting.date ?? "встреча"}`,
      speakerDrafts,
      transcriptPreview: (transcript.rawText ?? "").slice(0, 2000),
      transcriptSegments,
      // Сырые сегменты из SpeechKit — для вкладки "Дословно" в UI
      rawTranscriptSegments: rawTranscript.phrases ?? [],
      status: "draft_ready",
      currentStage: "draft_ready",
      updatedAt: this.clock.now().toISOString()
    };

    await this.meetingRepository.save(draftMeeting);
  }

  /**
   * Refine-job: LLM-улучшение расшифровки (запускается ТОЛЬКО по кнопке).
   *
   * Шаги: контекст (домен) → диаризация (если моно) → глоссарий →
   * почанковая коррекция line-ID с валидатором чисел → имена спикеров →
   * артефакт transcript.refined.json + сегменты в meeting.
   *
   * Resumable: чекпоинт после каждого чанка; при исчерпании бюджета
   * времени пере-enqueue'ит сам себя — длина аудио не ограничена.
   */
  async runRefinePhase(meeting, project) {
    const startedMs = Date.now();
    const refinedKey = meeting.artifacts.transcriptKey.replace(/\.json$/, ".refined.json");

    const transcript = await this.artifactStorage.readJson(meeting.artifacts.transcriptKey);
    if (!transcript?.phrases?.length) {
      throw new Error("Расшифровка не найдена — улучшение невозможно.");
    }

    // ── Resume или старт ───────────────────────────────────────────────────
    let checkpoint = null;
    if (meeting.llmRefine?.status === "processing") {
      checkpoint = await this.artifactStorage.readJson(refinedKey).catch(() => null);
      if (checkpoint && checkpoint.completed) checkpoint = null; // прошлый успешный — начинаем заново
    }

    let phrases, domain, glossary, context, nextChunk, stats;

    if (checkpoint?.checkpoint) {
      ({ phrases, domain, glossary, context, nextChunk, stats } = checkpoint);
      logger.info("refine: resuming from checkpoint", { meetingId: meeting.id, nextChunk });
    } else {
      // B0: домен нужен для качества промптов
      context = await this.yandexGptGateway.analyzeContext({
        correctedText: (transcript.rawText ?? "").slice(0, 8000),
        projectName: project?.name ?? ""
      });
      domain = context.domain || "общий";

      // A1: диаризация, если SpeechKit слил всё в одного спикера
      const diarized = await this.yandexGptGateway.diarizeTranscript(
        transcript, domain, context.mentionedEntities?.people ?? []
      );
      phrases = diarized.phrases ?? [];

      // Если диаризация разделила спикеров — обновляем рабочий транскрипт
      if (diarized.diarizedByGpt) {
        await this.artifactStorage.writeJson(meeting.artifacts.transcriptKey, diarized);
      }

      // A3: глоссарий — накопленный проектный + извлечённый из этой встречи
      const projectGlossary = await this.projectRepository
        .getGlossary(meeting.projectId).catch(() => null);
      glossary = await this.yandexGptGateway
        .extractGlossary({ rawText: transcript.rawText ?? "", domain, projectGlossary })
        .catch(() => projectGlossary);

      nextChunk = 0;
      stats = { applied: 0, rejectedByValidator: 0, retries: 0 };
    }

    const chunks = buildRefineChunks(phrases);
    const total = chunks.length;

    // Маркер поколения джобы: если пользователь отредактировал текст во время
    // работы (PATCH ставит llmRefine.status="stale" и сбрасывает requestedAt),
    // джоба обязана выбросить результат — он посчитан по устаревшему тексту
    const jobRequestedAt = meeting.llmRefine?.requestedAt ?? null;
    const isJobSuperseded = (fresh) =>
      fresh?.llmRefine?.status === "stale" ||
      (jobRequestedAt && fresh?.llmRefine?.requestedAt !== jobRequestedAt);

    const saveProgress = async (status, extra = {}) => {
      const fresh = await this.meetingRepository.getById(meeting.id);
      if (isJobSuperseded(fresh)) return false;
      await this.meetingRepository.save({
        ...fresh,
        llmRefine: {
          ...(fresh.llmRefine ?? {}),
          status,
          done: nextChunk,
          total,
          ...extra
        },
        updatedAt: this.clock.now().toISOString()
      });
      return true;
    };

    if (!(await saveProgress("processing"))) {
      logger.info("refine: superseded before start, aborting", { meetingId: meeting.id });
      return;
    }

    // ── Цикл по чанкам ─────────────────────────────────────────────────────
    for (; nextChunk < total; nextChunk++) {
      const chunk = chunks[nextChunk];

      let result = await this.yandexGptGateway.refineLines({
        lines: chunk.lines,
        ids: chunk.ids,
        contextLines: chunk.contextLines,
        domain,
        glossary
      });

      // Обрыв вывода → один retry; остаток остаётся сырым (НЕ молча — с пометкой)
      if (result.missingIds.length > 0) {
        stats.retries++;
        logger.warn("refine: missing ids, retrying chunk", {
          meetingId: meeting.id, chunk: nextChunk, missing: result.missingIds.length
        });
        const retry = await this.yandexGptGateway.refineLines({
          lines: chunk.lines, ids: chunk.ids,
          contextLines: chunk.contextLines, domain, glossary
        });
        for (const [id, text] of retry.byId) {
          if (!result.byId.has(id)) result.byId.set(id, text);
        }
      }

      const appliedResult = applyRefinedLines(phrases, result.byId);
      phrases = appliedResult.phrases;
      stats.applied += appliedResult.applied;
      stats.rejectedByValidator += appliedResult.rejectedByValidator;

      // Чекпоинт после каждого чанка — переживаем таймаут функции
      await this.artifactStorage.writeJson(refinedKey, {
        checkpoint: true,
        phrases, domain, glossary, context,
        nextChunk: nextChunk + 1,
        stats
      });
      if (!(await saveProgress("processing"))) {
        logger.info("refine: superseded mid-job (transcript edited), aborting", {
          meetingId: meeting.id, done: nextChunk + 1, total
        });
        return;
      }

      if (Date.now() - startedMs > REFINE_TIME_BUDGET_MS && nextChunk + 1 < total) {
        logger.info("refine: time budget exhausted, re-enqueueing", {
          meetingId: meeting.id, done: nextChunk + 1, total
        });
        await this._enqueuePhase(meeting.id, "refine", 1);
        return;
      }
    }

    // ── Финализация: имена спикеров + заголовок ────────────────────────────
    const refinedText = phrases
      .map((p) => `${p.speakerLabel}: ${p.text}`)
      .join("\n");

    const speakerDrafts = await this.yandexGptGateway.identifySpeakers({
      correctedText: refinedText,
      transcript: { ...transcript, phrases },
      project: project ?? { team: [] },
      context
    }).catch((err) => {
      logger.warn("refine: speaker identification failed, keeping current", { error: err.message });
      return null;
    });

    const changedRatio = phrases.length > 0 ? stats.applied / phrases.length : 0;

    await this.artifactStorage.writeJson(refinedKey, {
      completed: true,
      phrases,
      domain,
      stats,
      changedRatio,
      refinedAt: this.clock.now().toISOString()
    });

    const draftByid = new Map((speakerDrafts ?? []).map((s) => [s.id, s]));
    const llmTranscriptSegments = phrases.map((p) => ({
      speakerId: p.speakerId,
      speakerLabel: p.speakerLabel,
      guessedName: draftByid.get(p.speakerId)?.guessedName ?? p.detectedName ?? null,
      text: p.text,
      originalText: p.originalText ?? null,
      refined: p.refined === true,
      startTimeMs: p.startTimeMs ?? null,
      endTimeMs: p.endTimeMs ?? null
    }));

    const fresh = await this.meetingRepository.getById(meeting.id);
    if (isJobSuperseded(fresh)) {
      logger.info("refine: superseded at finalization (transcript edited), discarding result", {
        meetingId: meeting.id
      });
      return;
    }
    const updated = {
      ...fresh,
      llmTranscriptSegments,
      // Имена/роли спикеров — только если LLM их определил
      ...(speakerDrafts?.length
        ? {
            speakerDrafts: speakerDrafts.map((s) => ({
              id: s.id,
              label: s.label,
              guessedName: s.guessedName ?? null,
              guessedRole: s.guessedRole ?? null,
              dialogueRole: s.dialogueRole ?? null,
              confidence: s.confidence ?? "low"
            }))
          }
        : {}),
      // Заголовок-черновик — только пока черновик не подтверждён
      ...(fresh.status === "draft_ready" && context.mainTopics?.length
        ? { titleDraft: context.mainTopics.slice(0, 2).join(", ") }
        : {}),
      // Протокол будет собран по улучшенному тексту
      gptContext: {
        ...(fresh.gptContext ?? {}),
        ...context,
        correctedText: refinedText,
        glossary: glossary ?? null
      },
      llmRefine: {
        ...(fresh.llmRefine ?? {}),
        status: "done",
        done: total,
        total,
        changedRatio,
        finishedAt: this.clock.now().toISOString()
      },
      // Новый refine делает старый «Диалог» устаревшим — построен на другом тексте
      ...(fresh.llmDialogue ? { llmDialogue: { status: "stale" } } : {}),
      updatedAt: this.clock.now().toISOString()
    };
    await this.meetingRepository.save(updated);

    // Глоссарий — в копилку проекта (фоном)
    if (glossary) {
      this.projectRepository.mergeGlossary(meeting.projectId, glossary).catch((err) => {
        logger.error("refine: glossary merge failed (background)", { error: err.message });
      });
    }

    logger.info("refine: done", {
      meetingId: meeting.id,
      chunks: total,
      applied: stats.applied,
      rejectedByValidator: stats.rejectedByValidator,
      changedRatio: changedRatio.toFixed(2)
    });
  }

  /**
   * DIALOGUE-job: литературная запись реплик поверх уже исправленного
   * (REFINE) текста. Структура — намеренная копия runRefinePhase: тот же
   * resumable чекпоинт, тот же бюджет времени, та же supersede-логика,
   * только источник данных (transcript.refined.json вместо raw) и
   * validator (applyDialogueLines вместо applyRefinedLines).
   */
  async runDialoguePhase(meeting, project) {
    const startedMs = Date.now();
    const refinedKey = meeting.artifacts.transcriptKey.replace(/\.json$/, ".refined.json");
    const dialogueKey = meeting.artifacts.transcriptKey.replace(/\.json$/, ".dialogue.json");

    if (meeting.llmRefine?.status !== "done") {
      throw new Error("Сначала нужно улучшить расшифровку («Улучшить с помощью ИИ») — диалог строится поверх неё.");
    }

    const refined = await this.artifactStorage.readJson(refinedKey);
    if (!refined?.completed || !refined.phrases?.length) {
      throw new Error("Улучшенная расшифровка не найдена — запустите улучшение заново.");
    }

    const domain = meeting.gptContext?.domain || "общий";
    const glossary = meeting.gptContext?.glossary ?? null;
    const speakerById = new Map((meeting.speakerDrafts ?? []).map((s) => [s.id, s]));

    // ── Resume или старт ───────────────────────────────────────────────────
    let checkpoint = null;
    if (meeting.llmDialogue?.status === "processing") {
      checkpoint = await this.artifactStorage.readJson(dialogueKey).catch(() => null);
      if (checkpoint && checkpoint.completed) checkpoint = null;
    }

    let phrases, nextChunk, stats;
    if (checkpoint?.checkpoint) {
      ({ phrases, nextChunk, stats } = checkpoint);
      logger.info("dialogue: resuming from checkpoint", { meetingId: meeting.id, nextChunk });
    } else {
      phrases = refined.phrases;
      nextChunk = 0;
      stats = { applied: 0, rejectedByValidator: 0, retries: 0 };
    }

    // Отдельные "промпт-фразы" с именами вместо "Спикер N" — только для построения
    // строк запроса, на исходные phrases (и их порядок/ID) не влияет
    const promptPhrases = phrases.map((p) => ({
      ...p,
      speakerLabel: dialoguePromptLabel(p.speakerLabel, speakerById.get(p.speakerId))
    }));
    const chunks = buildRefineChunks(promptPhrases, { chunkChars: DIALOGUE_CHUNK_CHARS });
    const total = chunks.length;

    const jobRequestedAt = meeting.llmDialogue?.requestedAt ?? null;
    const isJobSuperseded = (fresh) =>
      fresh?.llmDialogue?.status === "stale" ||
      fresh?.llmRefine?.status !== "done" || // текст переоткрыт заново (правка/restore)
      (jobRequestedAt && fresh?.llmDialogue?.requestedAt !== jobRequestedAt);

    const saveProgress = async (status, extra = {}) => {
      const fresh = await this.meetingRepository.getById(meeting.id);
      if (isJobSuperseded(fresh)) return false;
      await this.meetingRepository.save({
        ...fresh,
        llmDialogue: { ...(fresh.llmDialogue ?? {}), status, done: nextChunk, total, ...extra },
        updatedAt: this.clock.now().toISOString()
      });
      return true;
    };

    if (!(await saveProgress("processing"))) {
      logger.info("dialogue: superseded before start, aborting", { meetingId: meeting.id });
      return;
    }

    // ── Цикл по чанкам ─────────────────────────────────────────────────────
    for (; nextChunk < total; nextChunk++) {
      const chunk = chunks[nextChunk];

      let result = await this.yandexGptGateway.rewriteDialogueLines({
        lines: chunk.lines,
        ids: chunk.ids,
        contextLines: chunk.contextLines,
        domain,
        glossary
      });

      if (result.missingIds.length > 0) {
        stats.retries++;
        logger.warn("dialogue: missing ids, retrying chunk", {
          meetingId: meeting.id, chunk: nextChunk, missing: result.missingIds.length
        });
        const retry = await this.yandexGptGateway.rewriteDialogueLines({
          lines: chunk.lines, ids: chunk.ids,
          contextLines: chunk.contextLines, domain, glossary
        });
        for (const [id, text] of retry.byId) {
          if (!result.byId.has(id)) result.byId.set(id, text);
        }
      }

      const appliedResult = applyDialogueLines(phrases, result.byId);
      phrases = appliedResult.phrases;
      stats.applied += appliedResult.applied;
      stats.rejectedByValidator += appliedResult.rejectedByValidator;

      await this.artifactStorage.writeJson(dialogueKey, {
        checkpoint: true, phrases, nextChunk: nextChunk + 1, stats
      });
      if (!(await saveProgress("processing"))) {
        logger.info("dialogue: superseded mid-job, aborting", {
          meetingId: meeting.id, done: nextChunk + 1, total
        });
        return;
      }

      if (Date.now() - startedMs > REFINE_TIME_BUDGET_MS && nextChunk + 1 < total) {
        logger.info("dialogue: time budget exhausted, re-enqueueing", {
          meetingId: meeting.id, done: nextChunk + 1, total
        });
        await this._enqueuePhase(meeting.id, "dialogue", 1);
        return;
      }
    }

    // ── Финализация ──────────────────────────────────────────────────────
    const changedRatio = phrases.length > 0 ? stats.applied / phrases.length : 0;

    await this.artifactStorage.writeJson(dialogueKey, {
      completed: true, phrases, stats, changedRatio,
      dialogueAt: this.clock.now().toISOString()
    });

    const llmDialogueSegments = phrases.map((p) => ({
      speakerId: p.speakerId,
      speakerLabel: p.speakerLabel,
      guessedName: speakerById.get(p.speakerId)?.guessedName ?? p.detectedName ?? null,
      text: p.text,
      originalText: p.dialogueOriginalText ?? null,
      refined: p.dialogueRewritten === true,
      startTimeMs: p.startTimeMs ?? null,
      endTimeMs: p.endTimeMs ?? null
    }));

    const fresh = await this.meetingRepository.getById(meeting.id);
    if (isJobSuperseded(fresh)) {
      logger.info("dialogue: superseded at finalization, discarding result", { meetingId: meeting.id });
      return;
    }

    await this.meetingRepository.save({
      ...fresh,
      llmDialogueSegments,
      llmDialogue: {
        ...(fresh.llmDialogue ?? {}),
        status: "done", done: total, total, changedRatio,
        finishedAt: this.clock.now().toISOString()
      },
      updatedAt: this.clock.now().toISOString()
    });

    // applied=0 на непустой встрече обычно значит отказ модели/сплошной
    // missing (см. logIfTotalMiss в yc-yandex-gpt-gateway.js) — job технически
    // "done", но пользователь получил исходный (refine) текст без переписывания.
    // warn, а не info — чтобы это было видно в логах без ручного репро.
    const logLevel = stats.applied === 0 && total > 0 ? "warn" : "info";
    logger[logLevel]("dialogue: done", {
      meetingId: meeting.id, chunks: total,
      applied: stats.applied, rejectedByValidator: stats.rejectedByValidator,
      changedRatio: changedRatio.toFixed(2)
    });
  }

  async generateProtocol(meeting, project) {
    const transcript = await this.artifactStorage.readJson(meeting.artifacts.transcriptKey);
    if (!transcript) {
      throw new Error("Transcript not found for protocol generation.");
    }

    // Улучшенная расшифровка — приоритетный источник для протокола,
    // но только если её не инвалидировала ручная правка (status=stale)
    let refinedText = null;
    if (meeting.llmRefine?.status === "done") {
      const refinedKey = meeting.artifacts.transcriptKey.replace(/\.json$/, ".refined.json");
      const refined = await this.artifactStorage.readJson(refinedKey).catch(() => null);
      if (refined?.completed && refined.phrases?.length) {
        refinedText = refined.phrases
          .map((p) => `${p.speakerLabel}: ${p.text}`)
          .join("\n");
      }
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
      projectGlossary,
      refinedText
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
