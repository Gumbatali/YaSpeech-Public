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
 * Прогресс/ошибка LLM-улучшения расшифровки. Запуск — автоматический
 * (см. prepareDraftFromTranscript), эта функция только отображает статус
 * и даёт кнопку повтора при сбое. Используется на вкладке «Расшифровка»
 * и на экране черновика.
 */
export function RefineControl({ api, activeMeeting, setActiveMeeting, setError, compact = false }) {
  const refine = activeMeeting?.llmRefine;
  const status = refine?.status;

  async function handleRefine() {
    try {
      const res = await api.refineTranscript(activeMeeting.id);
      if (res?.meeting) setActiveMeeting(res.meeting);
    } catch (e) {
      setError("Не удалось запустить улучшение: " + (e.message ?? e));
    }
  }

  if (status === "queued") {
    return html`<div className="refine-progress">⏳ Улучшение поставлено в очередь…</div>`;
  }

  if (status === "processing") {
    const done = refine.done ?? 0;
    const total = refine.total ?? 0;
    const percent = total > 0 ? Math.round((done / total) * 100) : 0;
    return html`
      <div className="refine-progress">
        <div className="refine-progress-label">
          ✨ Улучшаем расшифровку… ${total > 0 ? `фрагмент ${Math.min(done + 1, total)} из ${total}` : ""}
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
      : html`<div className="refine-done">✨ Расшифровка улучшена ИИ</div>`;
  }

  if (status === "failed") {
    return html`
      <div className="refine-control">
        <div className="refine-error">Не удалось улучшить: ${refine?.error ?? "ошибка"}</div>
        <button className="ghost-button ghost-button--sm refine-button" onClick=${handleRefine}>
          ✨ Повторить улучшение
        </button>
      </div>
    `;
  }

  // idle — улучшение запускается автоматически при готовности черновика
  // (см. prepareDraftFromTranscript), переключателя в UI больше нет.
  return null;
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
  const showDiff = refinedSegments.length > 0;
  const activeSegments = (transcriptVersion === "llm" && hasLlm)
    ? llmSegments
    : rawSegments;

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
        </div>
      </div>
      ${transcriptVersion === "llm" && !hasLlm
        ? html`<div className="empty-state">Улучшенная версия недоступна для этой встречи.</div>`
        : renderTranscriptSegments(activeSegments, colorMap, speakerInfo, {
            showDiff: transcriptVersion === "llm" && showDiff
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
