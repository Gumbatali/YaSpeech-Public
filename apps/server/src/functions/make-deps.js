/**
 * Создаёт зависимости для Cloud Functions из переменных окружения.
 */
import { YcArtifactStorage } from "../infrastructure/yc-artifact-storage.js";
import { YcProjectRepository } from "../infrastructure/yc-project-repository.js";
import { YcMeetingRepository } from "../infrastructure/yc-meeting-repository.js";
import { YmqQueueRunner } from "../infrastructure/ymq-queue-runner.js";
import { MockSpeechKitGateway } from "../infrastructure/mock-speech-kit-gateway.js";
import { MockYandexGptGateway } from "../infrastructure/mock-yandex-gpt-gateway.js";
import { MeetingPipelineService } from "../application/meeting-pipeline-service.js";

class RuntimeClock {
  now() { return new Date(); }
}

class RuntimeIdGenerator {
  next() { return crypto.randomUUID(); }
}

import crypto from "node:crypto";

export function makeDeps() {
  const bucket    = process.env.YC_STORAGE_BUCKET;
  const queueUrl  = process.env.YC_QUEUE_URL;
  const keyId     = process.env.YMQ_KEY_ID;
  const secret    = process.env.YMQ_SECRET;
  const storageKeyId    = process.env.STORAGE_KEY_ID ?? keyId;
  const storageSecret   = process.env.STORAGE_SECRET ?? secret;

  const artifactStorage   = new YcArtifactStorage({ bucket, keyId: storageKeyId, secret: storageSecret });
  const projectRepository = new YcProjectRepository(artifactStorage);
  const meetingRepository = new YcMeetingRepository(artifactStorage);
  const queueRunner       = new YmqQueueRunner({ queueUrl, keyId, secret });
  const clock             = new RuntimeClock();
  const idGenerator       = new RuntimeIdGenerator();

  const pipelineService = new MeetingPipelineService({
    meetingRepository,
    projectRepository,
    artifactStorage,
    speechKitGateway: new MockSpeechKitGateway(),
    yandexGptGateway: new MockYandexGptGateway(),
    queueRunner,
    clock,
  });

  const apiKey = process.env.API_KEY ?? null;

  return { projectRepository, meetingRepository, artifactStorage, pipelineService, clock, idGenerator, apiKey };
}
