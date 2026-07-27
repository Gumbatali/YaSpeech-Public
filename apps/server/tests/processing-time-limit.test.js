import test from "node:test";
import assert from "node:assert/strict";
import { MeetingPipelineService } from "../src/application/meeting-pipeline-service.js";

class FakeClock {
  constructor(startIso) {
    this.current = new Date(startIso);
  }
  now() {
    return new Date(this.current);
  }
  advanceMinutes(minutes) {
    this.current = new Date(this.current.getTime() + minutes * 60 * 1000);
  }
}

function makeService(clock) {
  // pollAsrPhase проверяет лимит времени ДО обращения к speechKitGateway —
  // остальные зависимости в этом тесте не задействуются.
  return new MeetingPipelineService({
    meetingRepository: null,
    projectRepository: null,
    artifactStorage: null,
    speechKitGateway: { pollRecognitionOnce: async () => { throw new Error("not expected to be called"); } },
    yandexGptGateway: null,
    queueRunner: null,
    clock
  });
}

test("pollAsrPhase: в пределах лимита — до time-limit проверки код не доходит (падает дальше по стеку, не на времени)", async () => {
  const clock = new FakeClock("2026-07-14T10:00:00.000Z");
  const service = makeService(clock);
  const meeting = {
    id: "m1",
    asrJobs: [{ operationId: "op-1", offsetSeconds: 0 }],
    asrStartedAt: "2026-07-14T10:00:00.000Z"
  };

  clock.advanceMinutes(19); // ещё в пределах лимита

  let code = null;
  try {
    await service.pollAsrPhase(meeting, {});
  } catch (e) {
    code = e.code ?? e.message;
  }
  // Дошли до вызова gateway (стаб намеренно бросает "not expected to be
  // called") — значит проверка лимита времени пропустила это состояние
  assert.notEqual(code, "PROCESSING_TIME_LIMIT_EXCEEDED");
});

test("pollAsrPhase: обработка дольше 20 минут — PROCESSING_TIME_LIMIT_EXCEEDED, а не ошибка про длину аудио", async () => {
  const clock = new FakeClock("2026-07-14T10:00:00.000Z");
  const service = makeService(clock);
  const meeting = {
    id: "m1",
    asrJobs: [{ operationId: "op-1", offsetSeconds: 0 }],
    asrStartedAt: "2026-07-14T10:00:00.000Z"
  };

  clock.advanceMinutes(21); // за пределами лимита

  await assert.rejects(
    () => service.pollAsrPhase(meeting, {}),
    (error) => {
      assert.equal(error.code, "PROCESSING_TIME_LIMIT_EXCEEDED");
      assert.match(error.message, /20 мин/);
      // сообщение не должно упоминать длину/длительность аудиофайла —
      // лимит на обработку, а не на файл
      assert.doesNotMatch(error.message.toLowerCase(), /длительност|длин[аы] запис/);
      return true;
    }
  );
});

test("pollAsrPhase: граница 20 минут ровно — ещё не лимит", async () => {
  const clock = new FakeClock("2026-07-14T10:00:00.000Z");
  const service = makeService(clock);
  const meeting = {
    id: "m1",
    asrJobs: [{ operationId: "op-1", offsetSeconds: 0 }],
    asrStartedAt: "2026-07-14T10:00:00.000Z"
  };

  clock.advanceMinutes(20); // ровно лимит — строгое "больше", не "больше либо равно"

  let timedOut = false;
  try {
    await service.pollAsrPhase(meeting, {});
  } catch (e) {
    timedOut = e.code === "PROCESSING_TIME_LIMIT_EXCEEDED";
  }
  assert.equal(timedOut, false);
});
