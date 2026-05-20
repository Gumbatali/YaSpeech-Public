import { createMeeting } from "../domain/meeting.js";

export class CreateMeetingUseCase {
  constructor(projectRepository, meetingRepository, artifactStorage, clock, idGenerator) {
    this.projectRepository = projectRepository;
    this.meetingRepository = meetingRepository;
    this.artifactStorage = artifactStorage;
    this.clock = clock;
    this.idGenerator = idGenerator;
  }

  async execute({ projectId, date, startTime, endTime, participantIds, guests, fileName, contentType }) {
    const project = await this.projectRepository.getById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const meeting = createMeeting({
      meetingId: this.idGenerator.next(),
      project,
      date,
      startTime: startTime ?? null,
      endTime: endTime ?? null,
      participantIds,
      guests,
      fileName,
      contentType,
      createdAt: this.clock.now().toISOString()
    });

    const upload = await this.artifactStorage.issueMeetingUpload(meeting);
    const enrichedMeeting = {
      ...meeting,
      upload
    };

    await this.meetingRepository.save(enrichedMeeting);

    return {
      meeting: enrichedMeeting,
      upload
    };
  }
}
