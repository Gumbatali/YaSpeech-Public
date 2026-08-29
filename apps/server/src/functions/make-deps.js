/**
 * Создаёт зависимости для Cloud Functions из переменных окружения.
 *
 * ASR_PROVIDER:
 *   "speechkit" (default) — Яндекс SpeechKit
 *   "groq"                — Groq Whisper large-v3 (требует GROQ_API_KEY)
 */
import { YcArtifactStorage } from "../infrastructure/yc-artifact-storage.js";
import { YcProjectRepository } from "../infrastructure/yc-project-repository.js";
import { YcMeetingRepository } from "../infrastructure/yc-meeting-repository.js";
import { YcUserRepository } from "../infrastructure/yc-user-repository.js";
import { YmqQueueRunner } from "../infrastructure/ymq-queue-runner.js";
import { MockSpeechKitGateway } from "../infrastructure/mock-speech-kit-gateway.js";
import { MockYandexGptGateway } from "../infrastructure/mock-yandex-gpt-gateway.js";
import { YcSpeechKitGateway } from "../infrastructure/yc-speech-kit-gateway.js";
import { GroqWhisperGateway } from "../infrastructure/groq-whisper-gateway.js";
import { YcYandexGptGateway } from "../infrastructure/yc-yandex-gpt-gateway.js";
import { PyannoteDiarization } from "../infrastructure/pyannote-diarization.js";
import { MeetingPipelineService } from "../application/meeting-pipeline-service.js";
import { hashPassword, verifyPassword } from "../shared/password.js";

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
  const userRepository    = new YcUserRepository(artifactStorage);
  const queueRunner       = new YmqQueueRunner({ queueUrl, keyId, secret });
  const clock             = new RuntimeClock();
  const idGenerator       = new RuntimeIdGenerator();

  const folderId    = process.env.YC_FOLDER_ID || "b1gu902hilj9930q2ebn";
  const useMocks    = process.env.USE_MOCKS === "true";
  const asrProvider = process.env.ASR_PROVIDER ?? "speechkit"; // "speechkit" | "groq"

  let speechKitGateway;
  if (useMocks) {
    speechKitGateway = new MockSpeechKitGateway();
  } else if (asrProvider === "groq") {
    const groqApiKey = process.env.GROQ_API_KEY;
    if (!groqApiKey) throw new Error("GROQ_API_KEY required when ASR_PROVIDER=groq");
    speechKitGateway = new GroqWhisperGateway({ apiKey: groqApiKey, artifactStorage });
  } else {
    speechKitGateway = new YcSpeechKitGateway({ bucket });
  }

  const yandexGptGateway = useMocks
    ? new MockYandexGptGateway()
    : new YcYandexGptGateway({ folderId });

  const diarizationGateway = new PyannoteDiarization({
    // Несколько очередей для round-robin — см. комментарий в
    // pyannote-diarization.js о том, почему одной очереди недостаточно.
    queueUrls: [
      process.env.DIARIZATION_QUEUE_URL,
      process.env.DIARIZATION_QUEUE_URL_2,
      process.env.DIARIZATION_QUEUE_URL_3
    ].filter(Boolean),
    keyId,
    secret,
    artifactStorage
  });

  const pipelineService = new MeetingPipelineService({
    meetingRepository,
    projectRepository,
    artifactStorage,
    speechKitGateway,
    yandexGptGateway,
    diarizationGateway,
    queueRunner,
    clock,
  });

  const sessionSecret = process.env.SESSION_SECRET ?? null;
  const adminLogin    = process.env.ADMIN_LOGIN ?? null;

  // Адаптеры для хэширования паролей (без npm — Node crypto под капотом)
  const passwordHasher   = { hash: hashPassword };
  const passwordVerifier = { verify: verifyPassword };

  return {
    projectRepository,
    meetingRepository,
    userRepository,
    artifactStorage,
    pipelineService,
    clock,
    idGenerator,
    sessionSecret,
    adminLogin,
    passwordHasher,
    passwordVerifier
  };
}
