import test from "node:test";
import assert from "node:assert/strict";
import {
  UPLOAD_STALL_TIMEOUT_MS,
  isUploadStalled,
  markUploadStalled,
  reopenMeetingUpload,
  touchUploadHeartbeat
} from "../src/domain/meeting.js";

const T0 = "2026-07-14T10:00:00.000Z";

function uploadingMeeting(overrides = {}) {
  return {
    id: "meeting-001",
    status: "uploading",
    currentStage: "uploading",
    createdAt: T0,
    updatedAt: T0,
    ...overrides
  };
}

function minutesAfter(iso, minutes) {
  return new Date(Date.parse(iso) + minutes * 60 * 1000).toISOString();
}

test("touchUploadHeartbeat обновляет прогресс и updatedAt только в статусе uploading", () => {
  const meeting = uploadingMeeting();
  const later = minutesAfter(T0, 1);

  const touched = touchUploadHeartbeat(meeting, 42, later);
  assert.equal(touched.uploadProgress, 42);
  assert.equal(touched.updatedAt, later);
  assert.equal(meeting.uploadProgress, undefined); // без мутации оригинала

  const done = { ...meeting, status: "done" };
  assert.equal(touchUploadHeartbeat(done, 42, later), done);
});

test("touchUploadHeartbeat зажимает прогресс в диапазон 0–100", () => {
  const meeting = uploadingMeeting();
  assert.equal(touchUploadHeartbeat(meeting, 150, T0).uploadProgress, 100);
  assert.equal(touchUploadHeartbeat(meeting, -5, T0).uploadProgress, 0);
  assert.equal(touchUploadHeartbeat(meeting, "мусор", T0).uploadProgress, 0);
});

test("isUploadStalled: false пока таймаут не истёк, true после", () => {
  const meeting = uploadingMeeting();

  assert.equal(isUploadStalled(meeting, minutesAfter(T0, 9)), false);
  assert.equal(isUploadStalled(meeting, minutesAfter(T0, 11)), true);
});

test("isUploadStalled: heartbeat сдвигает точку отсчёта", () => {
  const meeting = touchUploadHeartbeat(uploadingMeeting(), 50, minutesAfter(T0, 8));

  // 11 минут от создания, но только 3 от heartbeat — не зависла
  assert.equal(isUploadStalled(meeting, minutesAfter(T0, 11)), false);
  assert.equal(isUploadStalled(meeting, minutesAfter(T0, 19)), true);
});

test("isUploadStalled: не срабатывает для других статусов и битых дат", () => {
  assert.equal(isUploadStalled(uploadingMeeting({ status: "uploaded" }), minutesAfter(T0, 60)), false);
  assert.equal(isUploadStalled(null, minutesAfter(T0, 60)), false);
  assert.equal(
    isUploadStalled(uploadingMeeting({ updatedAt: "не-дата", createdAt: "не-дата" }), minutesAfter(T0, 60)),
    false
  );
});

test("markUploadStalled переводит в failed с кодом UPLOAD_STALLED", () => {
  const later = minutesAfter(T0, UPLOAD_STALL_TIMEOUT_MS / 60000 + 1);
  const stalled = markUploadStalled(uploadingMeeting(), later);

  assert.equal(stalled.status, "failed");
  assert.equal(stalled.error.code, "UPLOAD_STALLED");
  assert.equal(stalled.updatedAt, later);

  // Для не-uploading статусов — no-op
  const done = uploadingMeeting({ status: "done" });
  assert.equal(markUploadStalled(done, later), done);
});

test("reopenMeetingUpload возвращает встречу в uploading и чистит ошибку", () => {
  const later = minutesAfter(T0, 15);
  const stalled = markUploadStalled(uploadingMeeting({ uploadProgress: 73 }), later);

  const reopened = reopenMeetingUpload(stalled, minutesAfter(T0, 16));
  assert.equal(reopened.status, "uploading");
  assert.equal(reopened.currentStage, "uploading");
  assert.equal(reopened.uploadProgress, 0);
  assert.equal(reopened.error, undefined);
});
