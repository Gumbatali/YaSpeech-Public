import { finalizeMeetingProtocol } from "../domain/meeting.js";

export class FinalizeProtocolUseCase {
  constructor(meetingRepository, clock) {
    this.meetingRepository = meetingRepository;
    this.clock = clock;
  }

  async execute({ meetingId, talkId, transcriptKey, protocolJsonKey, protocolTextKey }) {
    const meeting = await this.meetingRepository.getById(meetingId);
    if (!meeting) {
      throw new Error(`Meeting not found: ${meetingId}`);
    }

    const updated = finalizeMeetingProtocol(
      meeting,
      { talkId, transcriptKey, protocolJsonKey, protocolTextKey },
      this.clock.now().toISOString()
    );
    await this.meetingRepository.save(updated);
    return updated;
  }
}
