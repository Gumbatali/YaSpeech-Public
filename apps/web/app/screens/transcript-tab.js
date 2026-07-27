/**
 * Вкладка «Расшифровка»: просмотр raw/LLM-версий, редактирование текста,
 * восстановление оригинала, пересборка протокола.
 * Состояние живёт в App. Вызывается как функция: TranscriptTab({ ... }).
 */
import { html } from "../html.js?v=__BUILD__";
import { formatTimecode } from "../format.js?v=__BUILD__";
import {
  SPEAKER_COLORS,
  buildSpeakerColorMap,
  buildSpeakerInfoMap,
  parseLlmTranscript,
  resolveSpeakerLabel,
  speakerColorFromMap,
  speakerInitial
} from "../transcript-model.js?v=__BUILD__";

function renderTranscriptSegments(segments, colorMap, speakerInfo, { showDiff = false } = {}) {
  if (!segments.length) {
    return html`<div className="empty-state">Расшифровка недоступна.</div>`;
  }
  return html`
    <div className="transcript-full">
      ${segments.map((seg, i) => {
        const color = colorMap ? speakerColorFromMap(colorMap, seg) : SPEAKER_COLORS[i % SPEAKER_COLORS.length];
        const { title, subtitle } = speakerInfo
          ? resolveSpeakerLabel(speakerInfo, seg)
          : { title: seg.guessedName || seg.speakerLabel || seg.speakerId || "", subtitle: null };
        const initial = speakerInitial(title);
        const timecode = formatTimecode(seg.startTimeMs);
        const isRefined = showDiff && seg.refined && seg.originalText;
        return html`
          <div key=${i} className="tf-row">
            ${title ? html`<div className="tf-avatar" style=${{ background: color }}>${initial}</div>` : null}
            <div className="tf-body">
              <div className="tf-meta">
                ${title ? html`<div className="tf-name" style=${{ color }}>${title}</div>` : null}
                ${subtitle ? html`<span className="tf-role">${subtitle}</span>` : null}
                ${timecode ? html`<span className="tf-timecode">${timecode}</span>` : null}
                ${isRefined ? html`<span className="tf-refined-badge" title="Исправлено ИИ">✨ ИИ</span>` : null}
              </div>
              <div className=${"tf-text" + (isRefined ? " tf-text--refined" : "")}>${seg.text}</div>
              ${isRefined
                ? html`
                    <details className="tf-diff">
                      <summary>исходный вариант</summary>
                      <div className="tf-diff-original">${seg.originalText}</div>
                    </details>
                  `
                : null}
            </div>
          </div>
        `;
      })}
    </div>
  `;
}

/**
 * Кнопка/прогресс LLM-улучшения расшифровки.
 * ЕДИНСТВЕННАЯ точка запуска LLM-коррекции — без неё никаких LLM-вызовов нет.
 * Используется на вкладке «Расшифровка» и на экране черновика.
 */
export function RefineControl({ api, activeMeeting, setActiveMeeting, setError, compact = false }) {
  const refine = activeMeeting?.llmRefine;
  const status = refine?.status;

  async function handleRefine() {
    try {
      const res = await api.refineTranscript(activeMeeting.id);
      if (res?.meeting) setActiveMeeting(res.meeting);
    } catch (e) {
      setError("Не удалось запустить разметку: " + (e.message ?? e));
    }
  }

  if (status === "queued") {
    return html`<div className="refine-progress">⏳ Разметка поставлена в очередь…</div>`;
  }

  if (status === "processing") {
    const done = refine.done ?? 0;
    const total = refine.total ?? 0;
    const percent = total > 0 ? Math.round((done / total) * 100) : 0;
    return html`
      <div className="refine-progress">
        <div className="refine-progress-label">
          ✨ Размечаем аудио… ${total > 0 ? `фрагмент ${Math.min(done + 1, total)} из ${total}` : ""}
        </div>
        <div className="refine-progress-bar">
          <div className="refine-progress-fill" style=${{ width: `${percent}%` }}></div>
        </div>
      </div>
    `;
  }

  if (status === "done") {
    return compact
      ? null
      : html`<div className="refine-done">✨ Аудио размечено ИИ</div>`;
  }

  // idle | stale | failed → кнопка
  return html`
    <div className="refine-control">
      ${status === "failed"
        ? html`<div className="refine-error">Не удалось разметить: ${refine?.error ?? "ошибка"}</div>`
        : null}
      <button className="ghost-button ghost-button--sm refine-button" onClick=${handleRefine}>
        ✨ ${status === "failed" ? "Повторить разметку" : "Разметить аудио с ИИ"}
      </button>
      ${!compact
        ? html`<span className="refine-hint">Разделит запись по спикерам из состава проекта, исправит ошибки распознавания. Займёт около минуты.</span>`
        : null}
    </div>
  `;
}

/**
 * Кнопка/прогресс сборки «Диалога» — литературной записи поверх уже
 * улучшенной (refine) расшифровки. Появляется только после llmRefine=done.
 */
export function DialogueControl({ api, activeMeeting, setActiveMeeting, setError, compact = false }) {
  const refineDone = activeMeeting?.llmRefine?.status === "done";
  const dialogue = activeMeeting?.llmDialogue;
  const status = dialogue?.status;

  async function handleBuildDialogue() {
    try {
      const res = await api.buildDialogue(activeMeeting.id);
      if (res?.meeting) setActiveMeeting(res.meeting);
    } catch (e) {
      setError("Не удалось собрать диалог: " + (e.message ?? e));
    }
  }

  if (!refineDone) {
    return compact
      ? null
      : html`<span className="refine-hint">Сначала разметьте аудио с ИИ — диалог собирается поверх неё.</span>`;
  }

  if (status === "queued") {
    return html`<div className="refine-progress">⏳ Сборка диалога поставлена в очередь…</div>`;
  }

  if (status === "processing") {
    const done = dialogue.done ?? 0;
    const total = dialogue.total ?? 0;
    const percent = total > 0 ? Math.round((done / total) * 100) : 0;
    return html`
      <div className="refine-progress">
        <div className="refine-progress-label">
          💬 Собираем диалог… ${total > 0 ? `фрагмент ${Math.min(done + 1, total)} из ${total}` : ""}
        </div>
        <div className="refine-progress-bar">
          <div className="refine-progress-fill" style=${{ width: `${percent}%` }}></div>
        </div>
      </div>
    `;
  }

  if (status === "done") {
    return compact ? null : html`<div className="refine-done">💬 Диалог собран</div>`;
  }

  // idle | stale | failed → кнопка
  return html`
    <div className="refine-control">
      ${status === "failed"
        ? html`<div className="refine-error">Не удалось собрать диалог: ${dialogue?.error ?? "ошибка"}</div>`
        : null}
      <button className="ghost-button ghost-button--sm refine-button" onClick=${handleBuildDialogue}>
        💬 ${status === "failed" ? "Повторить сборку" : "Собрать диалог"}
      </button>
      ${!compact
        ? html`<span className="refine-hint">Уберёт слова-паразиты и рваные фразы, сохранив смысл и факты. Займёт около минуты.</span>`
        : null}
    </div>
  `;
}

export function TranscriptTab({
  api,
  activeMeeting,
  setActiveMeeting,
  transcriptVersion,
  setTranscriptVersion,
  editingTranscript,
  setEditingTranscript,
  transcriptEditText,
  setTranscriptEditText,
  savingTranscript,
  setSavingTranscript,
  regenerating,
  setRegenerating,
  restoringTranscript,
  setRestoringTranscript,
  setNotice,
  setError
}) {
  const rawSegments = activeMeeting?.rawTranscriptSegments ?? activeMeeting?.transcriptSegments ?? [];
  // Новый источник — сегменты refine-job (с таймкодами и диффом);
  // parseLlmTranscript — fallback для встреч, обработанных старым пайплайном
  const refinedSegments = activeMeeting?.llmTranscriptSegments ?? [];
  const llmSegments = refinedSegments.length > 0
    ? refinedSegments
    : parseLlmTranscript(activeMeeting?.gptContext?.correctedText);
  const hasLlm = llmSegments.length > 0;
  // Диалог — только новый пайплайн, fallback-парсинг для него не нужен
  // (появился уже после введения llmTranscriptSegments)
  const dialogueSegments = activeMeeting?.llmDialogueSegments ?? [];
  const hasDialogue = dialogueSegments.length > 0;

  let activeSegments = rawSegments;
  let showDiff = false;
  if (transcriptVersion === "dialogue" && hasDialogue) {
    activeSegments = dialogueSegments;
    showDiff = true;
  } else if (transcriptVersion === "llm" && hasLlm) {
    activeSegments = llmSegments;
    showDiff = refinedSegments.length > 0;
  }

  // colorMap строится ПОСЛЕ activeSegments — один проход, первый спикер = color[0] и т.д.
  const colorMap = buildSpeakerColorMap(activeSegments);

  // Карта обогащения: "Спикер N" → { name, role, dialogueRole }
  // Имя/роль приходят из speakerDrafts (LLM-идентификация), роль-в-диалоге считаем сами.
  const speakerInfo = buildSpeakerInfoMap(activeMeeting?.speakerDrafts, activeSegments);

  // Собираем rawText для редактора из активных сегментов
  function buildRawText(segs) {
    return segs.map((s) => {
      const label = s.guessedName || s.speakerLabel || "";
      return label ? `${label}: ${s.text}` : s.text;
    }).join("\n");
  }

  async function handleStartEdit() {
    setTranscriptEditText(buildRawText(rawSegments));
    setEditingTranscript(true);
  }

  async function handleSaveTranscript() {
    if (!transcriptEditText.trim()) return;
    setSavingTranscript(true);
    try {
      const res = await api.patchTranscript(activeMeeting.id, transcriptEditText);
      if (res?.meeting) setActiveMeeting(res.meeting);
      setEditingTranscript(false);
      setNotice("Расшифровка сохранена. Нажмите «Пересобрать», чтобы обновить протокол.");
    } catch (e) {
      setError("Не удалось сохранить расшифровку: " + (e.message ?? e));
    } finally {
      setSavingTranscript(false);
    }
  }

  async function handleRegenerate() {
    setRegenerating(true);
    try {
      const { meeting } = await api.regenerateProtocol(activeMeeting.id);
      setActiveMeeting(meeting);
      setNotice("Протокол пересобирается…");
    } catch (e) {
      setError("Не удалось запустить пересборку: " + (e.message ?? e));
    } finally {
      setRegenerating(false);
    }
  }

  async function handleRestoreOriginal() {
    if (!confirm("Вернуть исходную расшифровку от системы распознавания? Все ваши правки текста будут потеряны.")) return;
    setRestoringTranscript(true);
    try {
      await api.restoreTranscript(activeMeeting.id);
      // перечитываем встречу, чтобы подтянуть восстановленные сегменты
      const { meeting } = await api.getMeeting(activeMeeting.id);
      setActiveMeeting(meeting);
      setNotice("Исходная расшифровка восстановлена.");
    } catch (e) {
      setError("Не удалось вернуть оригинал: " + (e.message ?? e));
    } finally {
      setRestoringTranscript(false);
    }
  }

  if (editingTranscript) {
    return html`
      <div className="transcript-edit-wrap">
        <p className="transcript-edit-hint">
          Отредактируйте текст расшифровки. Формат строки: <code>Имя спикера: текст реплики</code>.
          После сохранения нажмите «Пересобрать протокол» — LLM переработает протокол на основе исправленного текста.
        </p>
        <textarea
          className="transcript-editor"
          value=${transcriptEditText}
          onInput=${(e) => setTranscriptEditText(e.target.value)}
          rows="20"
          spellcheck="false"
        ></textarea>
        <div className="button-row">
          <button
            className="primary-button"
            onClick=${handleSaveTranscript}
            disabled=${savingTranscript}
          >${savingTranscript ? "Сохраняем…" : "Сохранить"}</button>
          <button
            className="ghost-button"
            onClick=${() => setEditingTranscript(false)}
            disabled=${savingTranscript}
          >Отмена</button>
        </div>
      </div>
    `;
  }

  return html`
    <div>
      <div className="transcript-toolbar">
        <div className="transcript-version-toggle">
          <button
            className=${"tvt-btn" + (transcriptVersion === "raw" ? " tvt-btn--active" : "")}
            onClick=${() => setTranscriptVersion("raw")}
          >Дословно</button>
          <button
            className=${"tvt-btn" + (transcriptVersion === "llm" ? " tvt-btn--active" : "")}
            onClick=${() => setTranscriptVersion("llm")}
            disabled=${!hasLlm}
          >LLM восстановил</button>
          <button
            className=${"tvt-btn" + (transcriptVersion === "dialogue" ? " tvt-btn--active" : "")}
            onClick=${() => setTranscriptVersion("dialogue")}
            disabled=${!hasDialogue}
          >Диалог</button>
        </div>
      </div>
      ${transcriptVersion === "dialogue"
        ? DialogueControl({ api, activeMeeting, setActiveMeeting, setError, compact: false })
        : RefineControl({ api, activeMeeting, setActiveMeeting, setError, compact: transcriptVersion === "raw" })}
      ${transcriptVersion === "llm" && !hasLlm
        ? html`<div className="empty-state">Нажмите «Разметить аудио с ИИ», чтобы получить исправленную версию.</div>`
        : transcriptVersion === "dialogue" && !hasDialogue
        ? html`<div className="empty-state">Нажмите «Собрать диалог», чтобы получить читаемую запись беседы.</div>`
        : renderTranscriptSegments(activeSegments, colorMap, speakerInfo, {
            showDiff: (transcriptVersion === "llm" || transcriptVersion === "dialogue") && showDiff
          })
      }
      <div className="transcript-actions">
        <button className="ghost-button ghost-button--sm" onClick=${handleStartEdit}>
          ✏️ Редактировать
        </button>
        <button
          className="ghost-button ghost-button--sm"
          onClick=${handleRestoreOriginal}
          disabled=${restoringTranscript}
          title="Вернуть исходную расшифровку от системы распознавания"
        >${restoringTranscript ? "Возвращаем…" : "↩️ Вернуть оригинал"}</button>
        <button
          className="ghost-button ghost-button--sm"
          onClick=${handleRegenerate}
          disabled=${regenerating}
          title="Пересобрать протокол на основе текущей расшифровки"
        >${regenerating ? "Пересобираем…" : "🔄 Пересобрать протокол"}</button>
      </div>
    </div>
  `;
}
