import http from "node:http";
import { MeetingPipelineService } from "../application/meeting-pipeline-service.js";
import { FileSystemMeetingRepository } from "../infrastructure/file-system-meeting-repository.js";
import { FileSystemProjectRepository } from "../infrastructure/file-system-project-repository.js";
import { LocalArtifactStorage } from "../infrastructure/local-artifact-storage.js";
import { LocalQueueRunner } from "../infrastructure/local-queue-runner.js";
import { MockYandexGptGateway } from "../infrastructure/mock-yandex-gpt-gateway.js";
import { MockSpeechKitGateway } from "../infrastructure/mock-speech-kit-gateway.js";
import { YcUserRepository } from "../infrastructure/yc-user-repository.js";
import { hashPassword, verifyPassword } from "../shared/password.js";
import { createHttpHandler } from "./create-http-handler.js";

class RuntimeClock {
  now() {
    return new Date();
  }
}

class RuntimeIdGenerator {
  next() {
    return crypto.randomUUID();
  }
}

import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function createRuntimeServer({
  dataDir,
  port = 0,
  failAiStudioAttempts = 0,
  // По умолчанию auth выключен (sessionSecret = null) — поведение как раньше.
  // Передайте sessionSecret/adminLogin, чтобы включить полную auth-цепочку локально.
  sessionSecret = null,
  adminLogin = null,
  // Подменяемые часы для тестов (staleness-логика загрузки зависит от времени)
  clock: providedClock = null,
  // Пороги параллельного ASR — настраиваемо для тестов (гонять реальные
  // десятки МБ в юнит-тестах непрактично), см. MeetingPipelineService.
  parallelSplitThresholdBytes,
  chunkTargetSeconds
}) {
  const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
  const webRootDirectory = path.resolve(currentDirectory, "../../../web");
  const clock = providedClock ?? new RuntimeClock();
  const idGenerator = new RuntimeIdGenerator();
  const projectRepository = new FileSystemProjectRepository(dataDir);
  const meetingRepository = new FileSystemMeetingRepository(dataDir);
  const artifactStorage = new LocalArtifactStorage(dataDir);
  // YcUserRepository работает с любым storage, у которого есть readJson/writeJson —
  // локально это файловая система, в облаке S3.
  const userRepository = new YcUserRepository(artifactStorage);
  const queueRunner = new LocalQueueRunner();
  const pipelineService = new MeetingPipelineService({
    meetingRepository,
    projectRepository,
    artifactStorage,
    speechKitGateway: new MockSpeechKitGateway(),
    yandexGptGateway: new MockYandexGptGateway({
      failAttempts: failAiStudioAttempts
    }),
    queueRunner,
    clock,
    ...(parallelSplitThresholdBytes != null ? { parallelSplitThresholdBytes } : {}),
    ...(chunkTargetSeconds != null ? { chunkTargetSeconds } : {})
  });

  const requestHandler = createHttpHandler({
    projectRepository,
    meetingRepository,
    userRepository,
    artifactStorage,
    pipelineService,
    clock,
    idGenerator,
    webRootDirectory,
    sessionSecret,
    adminLogin,
    passwordHasher: { hash: hashPassword },
    passwordVerifier: { verify: verifyPassword }
  });

  const server = http.createServer(requestHandler);
  server.keepAliveTimeout = 1;
  server.headersTimeout = 2_000;

  return {
    async start() {
      await new Promise((resolve) => {
        server.listen(port, "127.0.0.1", resolve);
      });

      const address = server.address();
      const resolvedPort =
        typeof address === "object" && address ? address.port : port;

      this.baseUrl = `http://127.0.0.1:${resolvedPort}`;
      return this;
    },
    async close() {
      if (typeof server.closeAllConnections === "function") {
        server.closeAllConnections();
      }
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
    async waitForIdle() {
      await queueRunner.waitForIdle();
    },
    get baseUrl() {
      return this._baseUrl;
    },
    set baseUrl(value) {
      this._baseUrl = value;
    },
    repositories: {
      projectRepository,
      meetingRepository,
      userRepository
    },
    services: {
      pipelineService
    }
  };
}
