/**
 * Точка входа Cloud Function для воркера.
 * Триггер: Yandex Message Queue → обрабатывает встречи из очереди.
 */
import { makeDeps } from "./make-deps.js";
import { logger } from "../shared/logger.js";

let deps;

function getDeps() {
  if (!deps) deps = makeDeps();
  return deps;
}

export async function index(event) {
  const { pipelineService } = getDeps();

  const messages = event.messages ?? [];
  const results = [];

  for (const msg of messages) {
    let meetingId = null;
    try {
      const body = JSON.parse(msg.details?.message?.body ?? "{}");
      meetingId = body.meetingId ?? null;
      const phase = body.phase ?? null;
      if (!meetingId) {
        logger.warn("Worker: no meetingId in message", { raw: msg.details?.message?.body });
        results.push({ meetingId: null, status: "skipped" });
        continue;
      }
      logger.info("Worker: processing", { meetingId, phase });
      await pipelineService.processMeeting(meetingId, phase);
      logger.info("Worker: done", { meetingId, phase });
      results.push({ meetingId, status: "ok" });
    } catch (err) {
      logger.error("Worker: unhandled error", { meetingId, error: err.message, stack: err.stack });
      results.push({ meetingId, status: "error", error: err.message });
    }
  }

  return { results };
}
