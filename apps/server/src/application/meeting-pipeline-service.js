import {
  FinalizeProtocolUseCase,
  RetryMeetingUseCase
} from "../../../../packages/core/src/index.js";
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
      await this.processMeeting(meetingId);
    });
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

  async processMeeting(meetingId) {
    const meeting = await this.meetingRepository.getById(meetingId);
    if (!meeting || !["uploaded", "protocol_generating"].includes(meeting.status)) {
      logger.warn("processMeeting: skipped", { meetingId, status: meeting?.status });
      return;
    }

    const project = await this.projectRepository.getById(meeting.projectId);
    if (!project) {
      throw new Error(`Project not found for meeting ${meetingId}`);
    }

    logger.info("processMeeting: start", { meetingId, status: meeting.status, projectId: meeting.projectId });

    try {
      if (meeting.status === "uploaded") {
        await this.prepareDraft(meeting, project);
        logger.info("processMeeting: draft ready", { meetingId });
        return;
      }

      await this.generateProtocol(meeting, project);
      logger.info("processMeeting: protocol done", { meetingId });
    } catch (error) {
      const failedMeeting = await this.meetingRepository.getById(meetingId);
      if (!failedMeeting) throw error;

      const code = error.code ??
        (failedMeeting.currentStage === "protocol_generating" ? "YANDEX_GPT_ERROR" : "SPEECHKIT_ERROR");

      logger.error("processMeeting: failed", { meetingId, code, error: error.message });

      await this.meetingRepository.save({
        ...failedMeeting,
        status: "failed",
        updatedAt: this.clock.now().toISOString(),
        error: { code, message: error.message }
      });
    }
  }

  async prepareDraft(meeting, project) {
    await this.meetingRepository.save({
      ...meeting,
      status: "speechkit_processing",
      currentStage: "speechkit_processing",
      updatedAt: this.clock.now().toISOString()
    });

    const { jobId, transcript: rawTranscript } = await this.speechKitGateway.processMeeting({
      meeting,
      project
    });

    // Postprocessing — чистим, склеиваем, переименовываем спикеров
    const transcript = postprocessTranscript(rawTranscript);

    // Сохраняем и сырой, и обработанный — для отладки и retry
    await this.artifactStorage.writeJson(meeting.artifacts.transcriptKey, transcript);
    const rawKey = meeting.artifacts.transcriptKey.replace(/\.json$/, ".raw.json");
    await this.artifactStorage.writeJson(rawKey, rawTranscript);

    const draft = await this.yandexGptGateway.generateDraft({
      meeting,
      project,
      transcript
    });

    const draftMeeting = {
      ...(await this.meetingRepository.getById(meeting.id)),
      speechKitJobId: jobId,
      titleDraft: draft.titleDraft,
      speakerDrafts: draft.speakerDrafts,
      transcriptPreview: draft.transcriptPreview,
      transcriptSegments: draft.transcriptSegments,
      gptContext: {
        ...draft.context,
        correctedText: draft.correctedText // сохраняем исправленный текст для pass C
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

    // Загружаем последний завершённый протокол проекта для сверки задач
    let previousProtocol = null;
    try {
      const allMeetings = await this.meetingRepository.listByProject(meeting.projectId);
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

    const { protocol, protocolText } = await this.yandexGptGateway.generateProtocol({
      meeting,
      project,
      transcript,
      previousProtocol
    });

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
