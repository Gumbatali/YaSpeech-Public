import {
  FinalizeProtocolUseCase,
  RetryMeetingUseCase
} from "../../../../packages/core/src/index.js";

export class MeetingPipelineService {
  constructor({
    meetingRepository,
    projectRepository,
    artifactStorage,
    speechSenseGateway,
    aiStudioGateway,
    queueRunner,
    clock
  }) {
    this.meetingRepository = meetingRepository;
    this.projectRepository = projectRepository;
    this.artifactStorage = artifactStorage;
    this.speechSenseGateway = speechSenseGateway;
    this.aiStudioGateway = aiStudioGateway;
    this.queueRunner = queueRunner;
    this.clock = clock;
  }

  enqueueProcessing(meetingId) {
    this.queueRunner.enqueue(`meeting:${meetingId}`, async () => {
      await this.processMeeting(meetingId);
    });
  }

  async retry(meetingId) {
    const failedMeeting = await this.meetingRepository.getById(meetingId);
    const meeting = await new RetryMeetingUseCase(
      this.meetingRepository,
      this.clock
    ).execute({ meetingId });

    if (failedMeeting?.currentStage === "protocol_generating") {
      await this.meetingRepository.save({
        ...meeting,
        status: "protocol_generating",
        currentStage: "protocol_generating",
        updatedAt: this.clock.now().toISOString()
      });
    }

    this.enqueueProcessing(meetingId);
    return meeting;
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
      return;
    }

    const project = await this.projectRepository.getById(meeting.projectId);
    if (!project) {
      throw new Error(`Project not found for meeting ${meetingId}`);
    }

    try {
      if (meeting.status === "uploaded") {
        await this.prepareDraft(meeting, project);
        return;
      }

      await this.generateProtocol(meeting, project);
    } catch (error) {
      const failedMeeting = await this.meetingRepository.getById(meetingId);
      if (!failedMeeting) {
        throw error;
      }

      const code =
        error.code ??
        (failedMeeting.currentStage === "protocol_generating"
          ? "AI_STUDIO_ERROR"
          : "SPEECHSENSE_ERROR");

      await this.meetingRepository.save({
        ...failedMeeting,
        status: "failed",
        updatedAt: this.clock.now().toISOString(),
        error: {
          code,
          message: error.message
        }
      });
    }
  }

  async prepareDraft(meeting, project) {
    await this.meetingRepository.save({
      ...meeting,
      status: "speechsense_processing",
      currentStage: "speechsense_processing",
      updatedAt: this.clock.now().toISOString()
    });

    const { talkId, transcript } = await this.speechSenseGateway.processMeeting({
      meeting,
      project
    });

    await this.artifactStorage.writeJson(meeting.artifacts.transcriptKey, transcript);

    const draft = await this.aiStudioGateway.generateDraft({
      meeting,
      project,
      transcript
    });

    const draftMeeting = {
      ...(await this.meetingRepository.getById(meeting.id)),
      speechSenseTalkId: talkId,
      titleDraft: draft.titleDraft,
      speakerDrafts: draft.speakerDrafts,
      transcriptPreview: draft.transcriptPreview,
      transcriptSegments: draft.transcriptSegments,
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

    const { protocol, protocolText } = await this.aiStudioGateway.generateProtocol({
      meeting,
      project,
      transcript
    });

    await this.artifactStorage.writeJson(meeting.artifacts.protocolJsonKey, protocol);
    await this.artifactStorage.writeText(meeting.artifacts.protocolTextKey, protocolText);

    const finalized = await new FinalizeProtocolUseCase(
      this.meetingRepository,
      this.clock
    ).execute({
      meetingId: meeting.id,
      talkId: meeting.speechSenseTalkId,
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
