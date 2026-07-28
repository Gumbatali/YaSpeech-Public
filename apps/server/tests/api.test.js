import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { createTestServer } from "../src/test-server.js";

async function withServer(options, run) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "yaspeech-"));
  const server = await createTestServer({ dataDir, ...options });

  try {
    await server.start();
    await run(server, dataDir);
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
    // Дубль-вызов гоняется с фоновым (мок) пайплайном, который уже поставлен
    // в очередь первым вызовом: к моменту повторного execute() встреча могла
    // уйти в speechkit_processing. markMeetingUploaded не откатывает статус
    // назад в уже устаревшем случае — так и должно быть, важна лишь
    // идемпотентность (повторный вызов не падает и не дублирует обработку).
    assert.ok(
      ["uploaded", "speechkit_processing"].includes(markUploadedAgain.body.meeting.status),
      `неожиданный статус: ${markUploadedAgain.body.meeting.status}`
    );

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
    assert.equal(failed.body.meeting.error.code, "YANDEX_GPT_ERROR");

    const retried = await requestJson(
      server,
      `/api/meetings/${meetingCreated.body.meeting.id}/retry`,
      {
        method: "POST",
        body: JSON.stringify({})
      }
    );

    // Сбой был на стадии генерации протокола — retry возобновляет именно с неё,
    // пропуская повторный ASR (оптимизация: не гоняем SpeechKit заново).
    assert.equal(retried.body.meeting.status, "protocol_generating");

    await server.waitForIdle();

    const done = await requestJson(
      server,
      `/api/meetings/${meetingCreated.body.meeting.id}`
    );

    assert.equal(done.body.meeting.status, "done");
    assert.equal(done.body.meeting.error, undefined);
  });
});

test("old meeting (legacy path, no global index) can be opened via GET /api/meetings/:id", async () => {
  await withServer({}, async (server, dataDir) => {
    // Заранее засеваем в dataDir встречу в СТАРОМ формате:
    //   projects/{projectId}/meetings/{meetingId}/meeting.json
    // без глобального meetings/index.json

    const projectId = "legacy-project";
    const meetingId = "legacy-meeting-001";
    const meetingDir = path.join(dataDir, "projects", projectId, "meetings", meetingId);
    await mkdir(meetingDir, { recursive: true });

    const legacyMeeting = {
      id: meetingId,
      projectId,
      projectName: "Legacy проект",
      date: "2025-01-15",
      status: "done",
      currentStage: "done",
      updatedAt: "2025-01-15T10:00:00.000Z",
      protocol: {
        summary: { title: "Старый протокол", text: "Обсудили архитектуру." },
        participants: ["Иванов"],
        decisions: [{ text: "Перейти на микросервисы" }],
        actionItems: []
      },
      artifacts: {
        audioOriginalKey: `projects/${projectId}/meetings/${meetingId}/audio-original.mp3`,
        transcriptKey:    `projects/${projectId}/meetings/${meetingId}/transcript.json`,
        protocolJsonKey:  `projects/${projectId}/meetings/${meetingId}/protocol.json`,
        protocolTextKey:  `projects/${projectId}/meetings/${meetingId}/protocol.txt`,
        manifestKey:      `projects/${projectId}/meetings/${meetingId}/meeting.json`,
        // baseKey намеренно ОТСУТСТВУЕТ — это legacy формат
      }
    };

    await writeFile(
      path.join(meetingDir, "meeting.json"),
      JSON.stringify(legacyMeeting, null, 2)
    );

    // Проектный индекс — есть (содержит краткую запись)
    const projectMeetingsDir = path.join(dataDir, "projects", projectId, "meetings");
    await writeFile(
      path.join(projectMeetingsDir, "index.json"),
      JSON.stringify([{ id: meetingId, projectId, date: "2025-01-15", status: "done" }])
    );

    // Проект-уровневый индекс
    const projectsDir = path.join(dataDir, "projects");
    await writeFile(
      path.join(projectsDir, "index.json"),
      JSON.stringify([{ id: projectId, name: "Legacy проект" }])
    );

    // Глобального meetings/index.json НЕТ — имитируем старое состояние

    // Открываем встречу через API
    const { response, body } = await requestJson(
      server,
      `/api/meetings/${meetingId}`
    );

    assert.equal(response.status, 200, "должна открыться с 200");
    assert.equal(body.meeting.id, meetingId, "id совпадает");
    assert.equal(body.meeting.status, "done", "статус done");
    assert.equal(body.meeting.protocol.summary.title, "Старый протокол", "протокол доступен");
  });
});
