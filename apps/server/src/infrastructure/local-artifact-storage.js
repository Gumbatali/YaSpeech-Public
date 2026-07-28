import crypto from "node:crypto";
import { createWriteStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { ensureDirectory, readJsonFile, writeJsonFile, writeTextFile } from "../shared/fs.js";

export class LocalArtifactStorage {
  constructor(dataDirectory) {
    this.dataDirectory = dataDirectory;
    this.uploadTokens = new Map();
  }

  resolveAbsolutePath(artifactKey) {
    return path.join(this.dataDirectory, artifactKey);
  }

  async issueMeetingUpload(meeting) {
    const token = crypto.randomUUID();
    this.uploadTokens.set(`${meeting.id}:${token}`, {
      artifactKey: meeting.artifacts.audioOriginalKey
    });

    return {
      method: "PUT",
      uploadUrl: `/local-upload/${meeting.id}?token=${token}`,
      artifactKey: meeting.artifacts.audioOriginalKey
    };
  }

  async writeUpload(meetingId, token, requestStream) {
    const upload = this.uploadTokens.get(`${meetingId}:${token}`);
    if (!upload) {
      const error = new Error("Upload token is invalid or expired.");
      error.code = "UPLOAD_TOKEN_INVALID";
      throw error;
    }

    const targetPath = this.resolveAbsolutePath(upload.artifactKey);
    await ensureDirectory(path.dirname(targetPath));
    await pipeline(requestStream, createWriteStream(targetPath));
    this.uploadTokens.delete(`${meetingId}:${token}`);
    const fileStat = await stat(targetPath);

    return {
      artifactKey: upload.artifactKey,
      sizeBytes: fileStat.size
    };
  }

  async writeJson(artifactKey, value) {
    await writeJsonFile(this.resolveAbsolutePath(artifactKey), value);
  }

  async readJson(artifactKey) {
    return readJsonFile(this.resolveAbsolutePath(artifactKey), null);
  }

  async writeText(artifactKey, value) {
    await writeTextFile(this.resolveAbsolutePath(artifactKey), value);
  }

  async readText(artifactKey) {
    try {
      return await readFile(this.resolveAbsolutePath(artifactKey), "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        return null;
      }

      throw error;
    }
  }

  /** Сырые байты (для аудио-чанков параллельного ASR — см. audio-splitting.js) */
  async writeBuffer(artifactKey, buffer) {
    const targetPath = this.resolveAbsolutePath(artifactKey);
    await ensureDirectory(path.dirname(targetPath));
    await writeFile(targetPath, buffer);
  }

  async readBuffer(artifactKey) {
    try {
      return await readFile(this.resolveAbsolutePath(artifactKey));
    } catch (error) {
      if (error.code === "ENOENT") {
        return null;
      }

      throw error;
    }
  }
}
