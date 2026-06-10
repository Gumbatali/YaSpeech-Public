/**
 * Чистые хелперы форматирования дат, времени и длительности.
 * Без состояния и без зависимостей от React.
 */

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export function formatMeetingDate(value) {
  try {
    return new Intl.DateTimeFormat("ru-RU", { dateStyle: "long" }).format(new Date(value));
  } catch {
    return value;
  }
}

export function nowHHMM() {
  const d = new Date();
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

export function subtractSecondsHHMM(hhmm, seconds) {
  const [h, m] = hhmm.split(":").map(Number);
  const totalMin = h * 60 + m - Math.round(seconds / 60);
  const clampedMin = ((totalMin % 1440) + 1440) % 1440;
  return String(Math.floor(clampedMin / 60)).padStart(2, "0") + ":" + String(clampedMin % 60).padStart(2, "0");
}

export function getMeetingTimeRange(meeting) {
  // Prefer explicitly stored times
  if (meeting?.startTime && meeting?.endTime) {
    return { start: meeting.startTime, end: meeting.endTime };
  }
  // Fallback: compute from uploadedAt + durationSeconds
  const dur = meeting?.audioFile?.durationSeconds;
  const uploadedAt = meeting?.audioFile?.uploadedAt || meeting?.updatedAt;
  if (!uploadedAt) return null;
  const fmt = (ms) => new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
  const endMs = new Date(uploadedAt).getTime();
  const end = fmt(endMs);
  const start = dur ? fmt(endMs - dur * 1000) : end;
  return { start, end };
}

export function formatMeetingTimeRange(meeting) {
  const range = getMeetingTimeRange(meeting);
  if (!range) return null;
  return range.start === range.end ? range.start : range.start + "–" + range.end;
}

export function formatRecordingTime(seconds) {
  const m = String(Math.floor(seconds / 60)).padStart(2, "0");
  const s = String(seconds % 60).padStart(2, "0");
  return m + ":" + s;
}

export function formatTimecode(ms) {
  if (ms == null) return null;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Длительность аудиофайла в секундах (через <audio>); null если не определилась. */
export function getAudioDuration(file) {
  return new Promise((resolve) => {
    const audio = document.createElement("audio");
    const url = URL.createObjectURL(file);
    audio.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(Math.round(audio.duration)); };
    audio.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    audio.src = url;
  });
}
