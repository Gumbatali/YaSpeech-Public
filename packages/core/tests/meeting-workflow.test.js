import test from "node:test";
import assert from "node:assert/strict";
import {
  CreateMeetingUseCase,
  CreateProjectUseCase,
  FinalizeProtocolUseCase,
  MarkUploadCompletedUseCase,
  RetryMeetingUseCase,
  UpdateProjectTeamUseCase
} from "../src/index.js";

class InMemoryProjectRepository {
  constructor() {
    this.projects = new Map();
  }

  async list() {
    return Array.from(this.projects.values());
  }

  async getById(projectId) {
    return this.projects.get(projectId) ?? null;
  }

  async save(project) {
    this.projects.set(project.id, project);
  }
}

class InMemoryMeetingRepository {
  constructor() {
    this.meetings = new Map();
  }

  async listByProject(projectId) {
    return Array.from(this.meetings.values()).filter(
      (meeting) => meeting.projectId === projectId
    );
  }

  async getById(meetingId) {
    return this.meetings.get(meetingId) ?? null;
  }

  async save(meeting) {
    this.meetings.set(meeting.id, meeting);
  }
}

class DeterministicIdGenerator {
  constructor() {
    this.ids = ["project-001", "meeting-001", "member-003"];
  }

  next() {
    const next = this.ids.shift();
    if (!next) {
      throw new Error("No more ids");
    }

    return next;
  }
}

class FixedClock {
  now() {
    return new Date("2026-05-10T10:30:00.000Z");
  }
}

class StubArtifactStorage {
  async issueMeetingUpload(meeting) {
    return {
      method: "PUT",
      uploadUrl: `https://storage.example/${meeting.id}`,
      artifactKey: `projects/${meeting.projectId}/meetings/${meeting.id}/audio-original.m4a`
    };
  }
}

test("creates a project with a stable slug and team members", async () => {
  const projects = new InMemoryProjectRepository();
  const createProject = new CreateProjectUseCase(
    projects,
    new FixedClock(),
    new DeterministicIdGenerator()
  );

  const project = await createProject.execute({
    name: "Еженедельный продуктовый",
    members: [
      { id: "member-001", name: "Иванов И.И.", role: "Продакт-менеджер" },
      { id: "member-002", name: "Петров П.П.", role: "Разработчик" }
    ]
  });

  assert.equal(project.id, "ezhenedelnyy-produktovyy");
  assert.equal(project.team.length, 2);
  assert.equal(project.createdAt, "2026-05-10T10:30:00.000Z");
});

test("creates a meeting with upload metadata and keeps status transitions idempotent", async () => {
  const projects = new InMemoryProjectRepository();
  const meetings = new InMemoryMeetingRepository();
  const clock = new FixedClock();
  const ids = new DeterministicIdGenerator();

  const createProject = new CreateProjectUseCase(projects, clock, ids);
  const project = await createProject.execute({
    name: "Еженедельный продуктовый",
    members: [
      { id: "member-001", name: "Иванов И.И.", role: "Продакт-менеджер" },
      { id: "member-002", name: "Петров П.П.", role: "Разработчик" }
    ]
  });

  const createMeeting = new CreateMeetingUseCase(
    projects,
    meetings,
    new StubArtifactStorage(),
    clock,
    ids
  );

  const created = await createMeeting.execute({
    projectId: project.id,
    date: "2026-05-10",
    participantIds: ["member-001"],
    guests: [{ name: "Козлов К.К.", role: "Эксперт" }],
    fileName: "oct-meeting.m4a",
    contentType: "audio/mp4"
  });

  assert.equal(created.meeting.status, "uploading");
  assert.match(created.upload.uploadUrl, /meeting-001/);
  assert.equal(
    created.meeting.artifacts.audioOriginalKey,
    "projects/ezhenedelnyy-produktovyy/2026-05-10_meeting-001/audio.m4a"
  );

  const markUploadCompleted = new MarkUploadCompletedUseCase(meetings, clock);
  const uploaded = await markUploadCompleted.execute({
    meetingId: created.meeting.id,
    sizeBytes: 17811426
  });
  const uploadedAgain = await markUploadCompleted.execute({
    meetingId: created.meeting.id,
    sizeBytes: 17811426
  });

  assert.equal(uploaded.status, "uploaded");
  assert.equal(uploaded.audioFile?.sizeBytes, 17811426);
  assert.equal(uploadedAgain.status, "uploaded");
});

test("allows team updates, protocol completion, and retry after failure", async () => {
  const projects = new InMemoryProjectRepository();
  const meetings = new InMemoryMeetingRepository();
  const clock = new FixedClock();
  const ids = new DeterministicIdGenerator();

  const createProject = new CreateProjectUseCase(projects, clock, ids);
  const project = await createProject.execute({
    name: "Еженедельный продуктовый",
    members: [{ id: "member-001", name: "Иванов И.И.", role: "Продакт-менеджер" }]
  });

  const updateTeam = new UpdateProjectTeamUseCase(projects, clock);
  const updatedProject = await updateTeam.execute({
    projectId: project.id,
    members: [
      { id: "member-001", name: "Иванов И.И.", role: "Продакт-менеджер" },
      { id: "member-002", name: "Сидорова А.В.", role: "Дизайнер" }
    ]
  });

  assert.equal(updatedProject.team.length, 2);

  const createMeeting = new CreateMeetingUseCase(
    projects,
    meetings,
    new StubArtifactStorage(),
    clock,
    ids
  );

  const created = await createMeeting.execute({
    projectId: project.id,
    date: "2026-05-10",
    participantIds: ["member-001", "member-002"],
    guests: [],
    fileName: "oct-meeting.m4a",
    contentType: "audio/mp4"
  });

  const uploaded = await new MarkUploadCompletedUseCase(meetings, clock).execute({
    meetingId: created.meeting.id,
    sizeBytes: 17811426
  });

  const finalized = await new FinalizeProtocolUseCase(meetings, clock).execute({
    meetingId: uploaded.id,
    talkId: "talk-123",
    transcriptKey: "projects/ezhenedelnyy-produktovyy/meetings/meeting-001/transcript.json",
    protocolJsonKey: "projects/ezhenedelnyy-produktovyy/meetings/meeting-001/protocol.json",
    protocolTextKey: "projects/ezhenedelnyy-produktovyy/meetings/meeting-001/protocol.txt"
  });

  assert.equal(finalized.status, "done");
  assert.equal(finalized.speechKitJobId, "talk-123");

  await meetings.save({
    ...finalized,
    status: "failed",
    currentStage: "protocol_generating",
    error: {
      code: "YANDEX_GPT_ERROR",
      message: "Temporary issue"
    }
  });

  const retried = await new RetryMeetingUseCase(meetings, clock).execute({
    meetingId: finalized.id
  });

  assert.equal(retried.status, "uploaded");
  assert.equal(retried.error, undefined);
});
