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
  participantIds,
  guests,
  fileName,
  contentType,
  createdAt
}) {
  const extension = resolveExtension(fileName, contentType);
  const baseKey = `projects/${project.id}/meetings/${meetingId}`;

  return {
    id: meetingId,
    projectId: project.id,
    projectName: project.name,
    date,
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
      audioOriginalKey: `${baseKey}/audio-original${extension}`,
      transcriptKey: `${baseKey}/transcript.json`,
      protocolJsonKey: `${baseKey}/protocol.json`,
      protocolTextKey: `${baseKey}/protocol.txt`,
      manifestKey: `${baseKey}/meeting.json`
    }
  };
}

export function markMeetingUploaded(meeting, sizeBytes, updatedAt) {
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
      sizeBytes
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
