import { markMeetingUploaded } from "../domain/meeting.js";

export class MarkUploadCompletedUseCase {
  constructor(meetingRepository, clock) {
    this.meetingRepository = meetingRepository;
    this.clock = clock;
  }

  async execute({ meetingId, sizeBytes }) {
    const meeting = await this.meetingRepository.getById(meetingId);
    if (!meeting) {
      throw new Error(`Meeting not found: ${meetingId}`);
    }

    const updated = markMeetingUploaded(
      meeting,
      sizeBytes,
      this.clock.now().toISOString()
    );
    await this.meetingRepository.save(updated);
    return updated;
  }
}
