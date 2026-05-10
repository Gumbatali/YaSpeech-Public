import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { createTestServer } from "../src/test-server.js";

async function withServer(options, run) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "yaspeech-"));
  const server = await createTestServer({ dataDir, ...options });

  try {
    await server.start();
    await run(server);
  } finally {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function requestJson(server, pathname, init) {
  const response = await fetch(`${server.baseUrl}${pathname}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  const body = await response.json();
  return { response, body };
}

test("project CRUD, draft confirmation, processing history, and protocol download work end-to-end", async () => {
  await withServer({}, async (server) => {
    const createdProject = await requestJson(server, "/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name: "Еженедельный продуктовый",
        members: [
          { id: "member-001", name: "Иванов И.И.", role: "Продакт-менеджер" }
        ]
      })
    });

    assert.equal(createdProject.response.status, 201);
    assert.equal(createdProject.body.project.id, "ezhenedelnyy-produktovyy");

    const updatedTeam = await requestJson(
      server,
      `/api/projects/${createdProject.body.project.id}/team`,
      {
        method: "PUT",
        body: JSON.stringify({
          members: [
            { id: "member-001", name: "Иванов И.И.", role: "Продакт-менеджер" },
            { id: "member-002", name: "Сидорова А.В.", role: "Дизайнер" }
          ]
        })
      }
    );

    assert.equal(updatedTeam.body.project.team.length, 2);

    const meetingCreated = await requestJson(server, "/api/meetings", {
      method: "POST",
      body: JSON.stringify({
        projectId: createdProject.body.project.id,
        date: "2026-05-10",
        participantIds: ["member-001", "member-002"],
        guests: [{ name: "Козлов К.К.", role: "Эксперт" }],
        fileName: "Октябрьская улица 2.m4a",
        contentType: "audio/mp4"
      })
    });

    assert.equal(meetingCreated.response.status, 201);
    assert.equal(meetingCreated.body.meeting.status, "uploading");

    const uploadResponse = await fetch(
      `${server.baseUrl}${meetingCreated.body.upload.uploadUrl}`,
      {
        method: "PUT",
        headers: {
          "content-type": "audio/mp4"
        },
        body: Buffer.from("fake-audio-content")
      }
    );

    assert.equal(uploadResponse.status, 200);

    const markUploaded = await requestJson(
      server,
      `/api/meetings/${meetingCreated.body.meeting.id}/upload-complete`,
      {
        method: "POST",
        body: JSON.stringify({ sizeBytes: 18 })
      }
    );
    const markUploadedAgain = await requestJson(
      server,
      `/api/meetings/${meetingCreated.body.meeting.id}/upload-complete`,
      {
        method: "POST",
        body: JSON.stringify({ sizeBytes: 18 })
      }
    );

    assert.equal(markUploaded.body.meeting.status, "uploaded");
    assert.equal(markUploadedAgain.body.meeting.status, "uploaded");

    await server.waitForIdle();

    const meetingDraft = await requestJson(
      server,
      `/api/meetings/${meetingCreated.body.meeting.id}`
    );

    assert.equal(meetingDraft.body.meeting.status, "draft_ready");
    assert.match(meetingDraft.body.meeting.titleDraft, /Еженедельный продуктовый/);
    assert.equal(meetingDraft.body.meeting.speakerDrafts.length, 3);
    assert.match(meetingDraft.body.meeting.transcriptPreview, /Спикер 1/);

    const confirmed = await requestJson(
      server,
      `/api/meetings/${meetingCreated.body.meeting.id}/confirm-draft`,
      {
        method: "POST",
        body: JSON.stringify({
          titleDraft: "Еженедельный продуктовый — статусы и решения",
          speakerDrafts: meetingDraft.body.meeting.speakerDrafts
        })
      }
    );

    assert.equal(confirmed.body.meeting.status, "protocol_generating");

    await server.waitForIdle();

    const meetingState = await requestJson(
      server,
      `/api/meetings/${meetingCreated.body.meeting.id}`
    );

    assert.equal(meetingState.body.meeting.status, "done");
    assert.equal(
      meetingState.body.meeting.protocol.summary.title,
      "Еженедельный продуктовый — статусы и решения"
    );
    assert.equal(meetingState.body.meeting.protocol.actionItems.length, 2);

    const projectMeetings = await requestJson(
      server,
      `/api/projects/${createdProject.body.project.id}/meetings`
    );

    assert.equal(projectMeetings.body.meetings.length, 1);
    assert.equal(projectMeetings.body.meetings[0].id, meetingCreated.body.meeting.id);

    const protocolText = await fetch(
      `${server.baseUrl}/api/meetings/${meetingCreated.body.meeting.id}/protocol.txt`
    );
    const protocolTextBody = await protocolText.text();

    assert.equal(protocolText.status, 200);
    assert.match(protocolTextBody, /Протокол встречи/);
    assert.match(protocolTextBody, /Сидорова А\.В\./);
  });
});

test("failed AI generation can be retried to completion", async () => {
  await withServer({ failAiStudioAttempts: 1 }, async (server) => {
    const createdProject = await requestJson(server, "/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name: "Архитектурный комитет",
        members: [
          { id: "member-001", name: "Иванов И.И.", role: "Архитектор" }
        ]
      })
    });

    const meetingCreated = await requestJson(server, "/api/meetings", {
      method: "POST",
      body: JSON.stringify({
        projectId: createdProject.body.project.id,
        date: "2026-05-10",
        participantIds: ["member-001"],
        guests: [],
        fileName: "committee.m4a",
        contentType: "audio/mp4"
      })
    });

    await fetch(`${server.baseUrl}${meetingCreated.body.upload.uploadUrl}`, {
      method: "PUT",
      headers: { "content-type": "audio/mp4" },
      body: Buffer.from("committee-audio")
    });

    await requestJson(
      server,
      `/api/meetings/${meetingCreated.body.meeting.id}/upload-complete`,
      {
        method: "POST",
        body: JSON.stringify({ sizeBytes: 15 })
      }
    );

    await server.waitForIdle();

    const draft = await requestJson(
      server,
      `/api/meetings/${meetingCreated.body.meeting.id}`
    );

    assert.equal(draft.body.meeting.status, "draft_ready");

    await requestJson(
      server,
      `/api/meetings/${meetingCreated.body.meeting.id}/confirm-draft`,
      {
        method: "POST",
        body: JSON.stringify({
          titleDraft: draft.body.meeting.titleDraft,
          speakerDrafts: draft.body.meeting.speakerDrafts
        })
      }
    );

    await server.waitForIdle();

    const failed = await requestJson(
      server,
      `/api/meetings/${meetingCreated.body.meeting.id}`
    );

    assert.equal(failed.body.meeting.status, "failed");
    assert.equal(failed.body.meeting.error.code, "AI_STUDIO_ERROR");

    const retried = await requestJson(
      server,
      `/api/meetings/${meetingCreated.body.meeting.id}/retry`,
      {
        method: "POST",
        body: JSON.stringify({})
      }
    );

    assert.equal(retried.body.meeting.status, "uploaded");

    await server.waitForIdle();

    const done = await requestJson(
      server,
      `/api/meetings/${meetingCreated.body.meeting.id}`
    );

    assert.equal(done.body.meeting.status, "done");
    assert.equal(done.body.meeting.error, undefined);
  });
});
