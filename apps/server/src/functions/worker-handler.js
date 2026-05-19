/**
 * Точка входа Cloud Function для воркера.
 * Триггер: Yandex Message Queue → обрабатывает встречи из очереди.
 */
import { makeDeps } from "./make-deps.js";

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
    try {
      const body = JSON.parse(msg.details?.message?.body ?? "{}");
      const { meetingId } = body;
      if (!meetingId) {
        console.warn("Worker: no meetingId in message", msg);
        results.push({ meetingId: null, status: "skipped" });
        continue;
      }
      console.log("Worker: processing meeting", meetingId);
      await pipelineService.processMeeting(meetingId);
      console.log("Worker: done", meetingId);
      results.push({ meetingId, status: "ok" });
    } catch (err) {
      console.error("Worker error:", err);
      results.push({ status: "error", error: err.message });
    }
  }

  return { results };
}
