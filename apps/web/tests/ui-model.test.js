import test from "node:test";
import assert from "node:assert/strict";
import {
  getStageViewModel,
  getTimelineStepState,
  resolveScreen
} from "../app/ui-model.js";

test("resolveScreen prefers the project-first upload flow", () => {
  assert.equal(
    resolveScreen({ selectedProjectId: "", activeMeeting: null, requestedScreen: "" }),
    "projects-home"
  );
  assert.equal(
    resolveScreen({
      selectedProjectId: "project-1",
      activeMeeting: null,
      requestedScreen: ""
    }),
    "project-workspace"
  );
  assert.equal(
    resolveScreen({
      selectedProjectId: "project-1",
      activeMeeting: { status: "speechkit_processing", currentStage: "speechkit_processing" },
      requestedScreen: ""
    }),
    "meeting-processing"
  );
  assert.equal(
    resolveScreen({
      selectedProjectId: "project-1",
      activeMeeting: { status: "done", currentStage: "done" },
      requestedScreen: ""
    }),
    "meeting-result"
  );
  assert.equal(
    resolveScreen({
      selectedProjectId: "project-1",
      activeMeeting: { status: "draft_ready", currentStage: "draft_ready" },
      requestedScreen: ""
    }),
    "meeting-draft"
  );
});

test("getStageViewModel uses human language for the processing stages", () => {
  assert.deepEqual(
    getStageViewModel({ status: "speechkit_processing", currentStage: "speechkit_processing" }),
    {
      tone: "working",
      title: "Готовим текст встречи",
      detail: "Система слушает запись и собирает речь участников."
    }
  );

  assert.deepEqual(
    getStageViewModel({ status: "draft_ready", currentStage: "draft_ready" }),
    {
      tone: "success",
      title: "Черновик готов",
      detail: "Проверьте название встречи и участников перед финальной сборкой."
    }
  );

  assert.deepEqual(
    getStageViewModel({ status: "protocol_generating", currentStage: "protocol_generating" }),
    {
      tone: "working",
      title: "Собираем итоговый протокол",
      detail: "Сводим резюме, решения и задачи в один понятный документ."
    }
  );

  assert.deepEqual(
    getStageViewModel({
      status: "failed",
      currentStage: "protocol_generating",
      error: { message: "Temporary issue" }
    }),
    {
      tone: "error",
      title: "Нужна повторная попытка",
      detail: "Temporary issue"
    }
  );
});

test("timeline step state shows draft and final protocol as separate stages", () => {
  assert.equal(
    getTimelineStepState("speechkit_processing", {
      status: "speechkit_processing",
      currentStage: "speechkit_processing"
    }),
    "current"
  );
  assert.equal(
    getTimelineStepState("draft_ready", {
      status: "draft_ready",
      currentStage: "draft_ready"
    }),
    "current"
  );
  assert.equal(
    getTimelineStepState("draft_ready", {
      status: "protocol_generating",
      currentStage: "protocol_generating"
    }),
    "done"
  );
  assert.equal(
    getTimelineStepState("protocol_generating", {
      status: "protocol_generating",
      currentStage: "protocol_generating"
    }),
    "current"
  );
  assert.equal(
    getTimelineStepState("done", { status: "done", currentStage: "done" }),
    "done"
  );
});
