/**
 * Фабрика диаризаторов. Выбор бэкенда — одна переменная окружения.
 *
 * DIARIZER:
 *   "none"               — без диаризации (спикеров расставит LLM-проход)
 *   "pyannote-hf"        — pyannote Community-1 через HuggingFace Inference API
 *   "pyannote-selfhosted"— свой сервис pyannote (без лимита 24 МБ)
 *   "nemo-sortformer"    — NeMo Sortformer, offline, до 4 спикеров
 *   "streaming-sortformer" — Streaming Sortformer v2.1, до 4 спикеров
 *   "diart"              — diart, неизвестное число участников
 *   "eend-eda"           — EEND-EDA, pretrained CALLHOME
 *
 * Все варианты кроме "pyannote-hf" — HTTP-сервисы на общем контракте,
 * поэтому за ними стоит один HttpDiarization с разным URL.
 */

import { HttpDiarization } from "./http-diarization.js";
import { PyannoteDiarization } from "../pyannote-diarization.js";
import { logger } from "../../shared/logger.js";

/** Бэкенды с фиксированным числом слотов — им нельзя задавать min/max. */
const FIXED_SLOT_BACKENDS = new Set(["nemo-sortformer", "streaming-sortformer", "eend-eda"]);

export const DIARIZER_BACKENDS = [
  "none",
  "pyannote-hf",
  "pyannote-selfhosted",
  "nemo-sortformer",
  "streaming-sortformer",
  "diart",
  "eend-eda",
];

/**
 * @param {{ env?: Record<string,string|undefined>, artifactStorage: object }} options
 * @returns {{ available: boolean, diarize: (key: string) => Promise<Array|null>, backend: string }}
 */
export function makeDiarizer({ env = process.env, artifactStorage }) {
  const backend = (env.DIARIZER ?? "none").trim();

  if (!DIARIZER_BACKENDS.includes(backend)) {
    logger.warn("makeDiarizer: unknown DIARIZER value, falling back to none", {
      value: backend,
      supported: DIARIZER_BACKENDS,
    });
    return nullDiarizer("none");
  }

  if (backend === "none") return nullDiarizer("none");

  if (backend === "pyannote-hf") {
    const hfToken = env.HF_TOKEN;
    if (!hfToken) {
      logger.warn("makeDiarizer: DIARIZER=pyannote-hf but HF_TOKEN is missing");
      return nullDiarizer(backend);
    }
    const diarizer = new PyannoteDiarization({ hfToken, artifactStorage });
    diarizer.backend = backend;
    return diarizer;
  }

  const baseUrl = env.DIARIZER_URL;
  if (!baseUrl) {
    logger.warn("makeDiarizer: DIARIZER_URL is required for this backend", { backend });
    return nullDiarizer(backend);
  }

  const speakerHints = FIXED_SLOT_BACKENDS.has(backend)
    ? {} // модель сама фиксирует число слотов, подсказки игнорируются
    : {
        numSpeakers: intOrNull(env.DIARIZER_NUM_SPEAKERS),
        minSpeakers: intOrNull(env.DIARIZER_MIN_SPEAKERS),
        maxSpeakers: intOrNull(env.DIARIZER_MAX_SPEAKERS),
      };

  logger.info("makeDiarizer: configured", { backend, baseUrl });

  return new HttpDiarization({
    baseUrl,
    backend,
    artifactStorage,
    authToken: env.DIARIZER_TOKEN ?? null,
    timeoutMs: intOrNull(env.DIARIZER_TIMEOUT_MS) ?? undefined,
    ...speakerHints,
  });
}

function nullDiarizer(backend) {
  return {
    backend,
    available: false,
    async diarize() {
      return null;
    },
    async health() {
      return { status: "disabled", backend };
    },
  };
}

function intOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}
