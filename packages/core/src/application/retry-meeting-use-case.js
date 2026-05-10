import { retryMeeting } from "../domain/meeting.js";

export class RetryMeetingUseCase {
  constructor(meetingRepository, clock) {
    this.meetingRepository = meetingRepository;
    this.clock = clock;
  }

  async execute({ meetingId }) {
    const meeting = await this.meetingRepository.getById(meetingId);
    if (!meeting) {
      throw new Error(`Meeting not found: ${meetingId}`);
    }

    const updated = retryMeeting(meeting, this.clock.now().toISOString());
    await this.meetingRepository.save(updated);
    return updated;
  }
}
