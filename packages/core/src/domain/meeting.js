function resolveExtension(fileName, contentType) {
  const fileExtension = fileName.includes(".")
    ? fileName.slice(fileName.lastIndexOf("."))
    : "";

  if (fileExtension) {
    return fileExtension.toLowerCase();
  }

  if (contentType === "audio/mp4") {
    return ".m4a";
  }

  if (contentType === "audio/mpeg") {
    return ".mp3";
  }

  return ".bin";
}

export function createMeeting({
  meetingId,
  project,
  date,
  startTime,
  endTime,
  participantIds,
  guests,
  fileName,
  contentType,
  createdAt
}) {
  const extension = resolveExtension(fileName, contentType);
  const datePart = date ? String(date).replace(/[^0-9-]/g, "").slice(0, 10) : "0000-00-00";
  const baseKey = `projects/${project.id}/${datePart}_${meetingId}`;

  return {
    id: meetingId,
    projectId: project.id,
    projectName: project.name,
    date,
    startTime: startTime ?? null,
    endTime: endTime ?? null,
    participantIds: [...participantIds],
    guests: guests.map((guest) => ({ ...guest })),
    status: "uploading",
    currentStage: "uploading",
    createdAt,
    updatedAt: createdAt,
    audioFile: {
      originalFileName: fileName,
      contentType
    },
    artifacts: {
      audioOriginalKey: `${baseKey}/audio${extension}`,
      transcriptKey: `${baseKey}/transcript.json`,
      protocolJsonKey: `${baseKey}/protocol.json`,
      protocolTextKey: `${baseKey}/protocol.txt`,
      manifestKey: `${baseKey}/meeting.json`,
      baseKey
    }
  };
}

/**
 * Встреча переходит в режим поллинга ASR.
 * Сохраняем operationId и момент старта для timeout-защиты.
 */
export function markAsrStarted(meeting, operationId, updatedAt) {
  return {
    ...meeting,
    status: "speechkit_processing",
    currentStage: "speechkit_processing",
    asrOperationId: operationId,
    asrStartedAt: updatedAt,
    asrPollCount: 0,
    updatedAt
  };
}

export function incrementAsrPoll(meeting, updatedAt) {
  return {
    ...meeting,
    asrPollCount: (meeting.asrPollCount ?? 0) + 1,
    updatedAt
  };
}

// Загрузка идёт браузер → Object Storage напрямую, сервер видит её только по
// heartbeat'ам. Нет heartbeat дольше таймаута — считаем загрузку брошенной.
export const UPLOAD_STALL_TIMEOUT_MS = 10 * 60 * 1000;

export function touchUploadHeartbeat(meeting, progressPct, updatedAt) {
  if (meeting.status !== "uploading") {
    return meeting;
  }

  const pct = Math.max(0, Math.min(100, Math.round(Number(progressPct) || 0)));
  return {
    ...meeting,
    uploadProgress: pct,
    updatedAt
  };
}

export function isUploadStalled(meeting, nowIso, timeoutMs = UPLOAD_STALL_TIMEOUT_MS) {
  if (meeting?.status !== "uploading") {
    return false;
  }

  const lastActivity = Date.parse(meeting.updatedAt ?? meeting.createdAt ?? "");
  if (!Number.isFinite(lastActivity)) {
    return false;
  }

  return Date.parse(nowIso) - lastActivity > timeoutMs;
}

export function markUploadStalled(meeting, updatedAt) {
  if (meeting.status !== "uploading") {
    return meeting;
  }

  return {
    ...meeting,
    status: "failed",
    updatedAt,
    error: {
      code: "UPLOAD_STALLED",
      message:
        "Загрузка записи прервалась — файл не был передан до конца. " +
        "Обычно это закрытая вкладка или обрыв сети. Загрузите файл заново."
    }
  };
}

export function reopenMeetingUpload(meeting, updatedAt) {
  return {
    ...meeting,
    status: "uploading",
    currentStage: "uploading",
    uploadProgress: 0,
    error: undefined,
    updatedAt
  };
}

export function markMeetingUploaded(meeting, sizeBytes, updatedAt, durationSeconds) {
  if (meeting.status !== "uploading" && meeting.status !== "draft_ready") {
    return {
      ...meeting,
      audioFile: {
        ...meeting.audioFile,
        sizeBytes: meeting.audioFile?.sizeBytes ?? sizeBytes
      }
    };
  }

  return {
    ...meeting,
    status: "uploaded",
    currentStage: "uploaded",
    updatedAt,
    audioFile: {
      ...meeting.audioFile,
      sizeBytes,
      uploadedAt: updatedAt,
      ...(durationSeconds != null ? { durationSeconds } : {})
    }
  };
}

export function finalizeMeetingProtocol(
  meeting,
  { talkId, transcriptKey, protocolJsonKey, protocolTextKey },
  updatedAt
) {
  return {
    ...meeting,
    status: "done",
    currentStage: "done",
    updatedAt,
    error: undefined,
    speechKitJobId: talkId,
    artifacts: {
      ...meeting.artifacts,
      transcriptKey,
      protocolJsonKey,
      protocolTextKey
    }
  };
}

export function retryMeeting(meeting, updatedAt) {
  if (meeting.status !== "failed") {
    return meeting;
  }

  return {
    ...meeting,
    status: "uploaded",
    currentStage: "uploaded",
    updatedAt,
    error: undefined
  };
}
