/**
 * Чистая модель отображения расшифровки: цвета спикеров, карта «кто есть кто»,
 * парсинг LLM-текста обратно в сегменты. Без React и без состояния —
 * полностью покрывается unit-тестами в Node.
 */

// Цвета для спикеров в расшифровке
export const SPEAKER_COLORS = [
  "#4f6ef7", "#e05c5c", "#2bba8a", "#e09c2b",
  "#9b59b6", "#16a085", "#d35400", "#2980b9"
];

/**
 * Строим карту identity → color прямо из сегментов в порядке первого появления.
 * Не зависит от speakerDrafts — работает и для raw, и для LLM-версии.
 * Один и тот же спикер всегда получает один и тот же цвет внутри набора сегментов.
 */
export function buildSpeakerColorMap(segments) {
  const map = new Map();
  let idx = 0;
  for (const seg of (segments ?? [])) {
    const key = (seg.guessedName?.trim()) || seg.speakerLabel || seg.speakerId;
    if (key && !map.has(key)) {
      map.set(key, SPEAKER_COLORS[idx % SPEAKER_COLORS.length]);
      idx++;
    }
  }
  return map;
}

export function speakerColorFromMap(colorMap, seg) {
  const keys = [seg.guessedName?.trim(), seg.speakerLabel, seg.speakerId].filter(Boolean);
  for (const k of keys) {
    if (colorMap.has(k)) return colorMap.get(k);
  }
  // крайний fallback: хэш чтобы незнакомый спикер не менял цвет между рендерами
  const key = keys[0] ?? "?";
  const hash = [...key].reduce((a, c) => a + c.charCodeAt(0), 0);
  return SPEAKER_COLORS[Math.abs(hash) % SPEAKER_COLORS.length];
}

export function speakerInitial(label) {
  return (label ?? "?").replace("Спикер ", "С").slice(0, 2).toUpperCase();
}

/**
 * Строит карту "Спикер N" → { name, role, dialogueRole }.
 *  - name/role берём из speakerDrafts (LLM-идентификация)
 *  - dialogueRole считаем сами по сегментам: кто начал, у кого больше слов и т.п.
 */
export function buildSpeakerInfoMap(speakerDrafts, segments) {
  const info = new Map();

  // 1. Имя, проф. роль и роль-в-диалоге из drafts (ключи: label, id, guessedName)
  (speakerDrafts ?? []).forEach((s) => {
    const entry = {
      name: s.guessedName?.trim() || null,
      role: s.guessedRole?.trim() || null,
      dialogueRole: s.dialogueRole?.trim() || null // от LLM, если есть
    };
    [s.label, s.id, s.guessedName?.trim()].filter(Boolean).forEach((k) => {
      if (!info.has(k)) info.set(k, entry);
    });
  });

  // 2. Роль-в-диалоге: статистика по сегментам
  const stats = new Map(); // key → { words, firstIdx, count }
  (segments ?? []).forEach((seg, idx) => {
    const key = seg.guessedName?.trim() || seg.speakerLabel || seg.speakerId;
    if (!key) return;
    const words = (seg.text ?? "").trim().split(/\s+/).filter(Boolean).length;
    const cur = stats.get(key) ?? { words: 0, firstIdx: idx, count: 0 };
    cur.words += words;
    cur.count += 1;
    stats.set(key, cur);
  });

  // Самодельная эвристика — только если LLM не дал dialogueRole
  const ordered = [...stats.entries()].sort((a, b) => a[1].firstIdx - b[1].firstIdx);
  const maxWords = Math.max(0, ...[...stats.values()].map((v) => v.words));
  ordered.forEach(([key, st], i) => {
    const existing = info.get(key) ?? { name: null, role: null, dialogueRole: null };
    if (existing.dialogueRole) return; // LLM уже описал роль
    let dialogueRole;
    if (i === 0) dialogueRole = "начал разговор";
    else if (st.words === maxWords && maxWords > 0) dialogueRole = "основной спикер";
    else dialogueRole = "участник";
    info.set(key, { ...existing, dialogueRole });
  });

  return info;
}

/** Возвращает { title, subtitle } для шапки реплики спикера. */
export function resolveSpeakerLabel(speakerInfo, seg) {
  const rawLabel = seg.guessedName || seg.speakerLabel || seg.speakerId || "";
  const keys = [seg.guessedName?.trim(), seg.speakerLabel, seg.speakerId].filter(Boolean);
  let entry = null;
  for (const k of keys) {
    if (speakerInfo.has(k)) { entry = speakerInfo.get(k); break; }
  }
  if (!entry) return { title: rawLabel, subtitle: null };

  // Приоритет: настоящее имя > проф. роль > роль в диалоге
  if (entry.name) {
    return { title: entry.name, subtitle: entry.role || null };
  }
  return { title: rawLabel, subtitle: entry.role || entry.dialogueRole || null };
}

/** Парсит LLM-восстановленный текст ("Имя: реплика" построчно) в сегменты. */
export function parseLlmTranscript(correctedText) {
  if (!correctedText) return [];
  return correctedText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(.{1,50}):\s*(.+)$/);
      if (m) {
        // speakerId = нормализованный label, чтобы colorMap мог его найти
        const label = m[1].trim();
        return { speakerId: label, speakerLabel: label, text: m[2] };
      }
      return { speakerId: "speaker-1", speakerLabel: "", text: line };
    });
}
