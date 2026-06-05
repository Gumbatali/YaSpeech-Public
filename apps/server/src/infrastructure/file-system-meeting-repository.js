import path from "node:path";
import { listDirectories, readJsonFile, writeJsonFile } from "../shared/fs.js";

export class FileSystemMeetingRepository {
  constructor(dataDirectory) {
    this.dataDirectory = dataDirectory;
  }

  meetingsIndexPath(projectId) {
    return path.join(
      this.dataDirectory,
      "projects",
      projectId,
      "meetings",
      "index.json"
    );
  }

  manifestPath(projectId, meetingId) {
    return path.join(
      this.dataDirectory,
      "projects",
      projectId,
      "meetings",
      meetingId,
      "meeting.json"
    );
  }

  async listByProject(projectId) {
    const meetings = await readJsonFile(this.meetingsIndexPath(projectId), []);
    return meetings.sort((left, right) => right.date.localeCompare(left.date));
  }

  async getById(meetingId) {
    const projectIds = await listDirectories(path.join(this.dataDirectory, "projects"));

    for (const projectId of projectIds) {
      const meetingsIndex = await readJsonFile(this.meetingsIndexPath(projectId), []);
      const found = meetingsIndex.find((meeting) => meeting.id === meetingId);
      if (!found) {
        continue;
      }

      return readJsonFile(this.manifestPath(projectId, meetingId), null);
    }

    return null;
  }

  async save(meeting) {
    await writeJsonFile(this.manifestPath(meeting.projectId, meeting.id), meeting);

    const index = await readJsonFile(this.meetingsIndexPath(meeting.projectId), []);
    const nextIndex = index.filter((entry) => entry.id !== meeting.id);
    nextIndex.push({
      id: meeting.id,
      projectId: meeting.projectId,
      projectName: meeting.projectName,
      date: meeting.date,
      status: meeting.status,
      currentStage: meeting.currentStage,
      updatedAt: meeting.updatedAt,
      speechKitJobId: meeting.speechKitJobId,
      summaryTitle: meeting.protocol?.summary?.title ?? meeting.titleDraft
    });
    nextIndex.sort((left, right) => right.date.localeCompare(left.date));

    await writeJsonFile(this.meetingsIndexPath(meeting.projectId), nextIndex);
  }

  async delete(meetingId) {
    const meeting = await this.getById(meetingId);
    if (!meeting) return;

    const index = await readJsonFile(this.meetingsIndexPath(meeting.projectId), []);
    const nextIndex = index.filter((entry) => entry.id !== meetingId);
    await writeJsonFile(this.meetingsIndexPath(meeting.projectId), nextIndex);
  }
}
