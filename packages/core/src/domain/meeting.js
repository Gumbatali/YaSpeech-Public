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

export function markMeetingUploaded(meeting, sizeBytes, updatedAt, durationSeconds) {
  if (meeting.status !== "uploading" && meeting.status !== "draft") {
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
