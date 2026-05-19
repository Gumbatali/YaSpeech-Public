import { markMeetingUploaded } from "../domain/meeting.js";

export class MarkUploadCompletedUseCase {
  constructor(meetingRepository, clock) {
    this.meetingRepository = meetingRepository;
    this.clock = clock;
  }

  async execute({ meetingId, sizeBytes, durationSeconds }) {
    const meeting = await this.meetingRepository.getById(meetingId);
    if (!meeting) {
      throw new Error(`Meeting not found: ${meetingId}`);
    }

    const updated = markMeetingUploaded(
      meeting,
      sizeBytes,
      this.clock.now().toISOString(),
      durationSeconds ?? null
    );
    await this.meetingRepository.save(updated);
    return updated;
  }
}
