/**
 * Вкладка «Итоги» на экране результата: просмотр и редактирование саммари
 * (обзор, участники, решения, задачи). Состояние редактора живёт в App.
 * Вызывается как функция: SummaryTab({ ... }).
 */
import { html } from "../html.js?v=__BUILD__";

export function SummaryTab({
  api,
  protocol,
  activeMeeting,
  setActiveMeeting,
  summaryDraft,
  setSummaryDraft,
  editingSummary,
  setEditingSummary,
  savingSummary,
  setSavingSummary,
  setNotice,
  setError,
  onStartEdit
}) {
  async function saveSummary() {
    setSavingSummary(true);
    const cleanParticipants = summaryDraft.participants.map((p) => p.trim()).filter(Boolean);
    const participantSet = new Set(cleanParticipants);
    const newProtocol = {
      ...protocol,
      summary: { ...(protocol.summary ?? {}), overview: summaryDraft.overview },
      participants: cleanParticipants,
      decisions: summaryDraft.decisions.map((d) => d.trim()).filter(Boolean),
      // Если owner не в текущем списке участников — очищаем
      actionItems: summaryDraft.actionItems.map((a) => ({
        ...a,
        owner: participantSet.has(a.owner) ? a.owner : ""
      }))
    };
    try {
      await api.patchProtocol(activeMeeting.id, newProtocol);
      setActiveMeeting((m) => ({ ...m, protocol: newProtocol }));
      setEditingSummary(false);
      setNotice("Итоги сохранены.");
    } catch (e) {
      setError("Не удалось сохранить: " + (e.message ?? e));
    } finally {
      setSavingSummary(false);
    }
  }

  // Хелперы для редактирования списков в драфте
  const setList = (key, idx, value) =>
    setSummaryDraft((d) => ({ ...d, [key]: d[key].map((v, i) => (i === idx ? value : v)) }));
  const addToList = (key, empty) =>
    setSummaryDraft((d) => ({ ...d, [key]: [...d[key], empty] }));
  const removeFromList = (key, idx) =>
    setSummaryDraft((d) => ({ ...d, [key]: d[key].filter((_, i) => i !== idx) }));
  const setAction = (idx, field, value) =>
    setSummaryDraft((d) => ({
      ...d,
      actionItems: d.actionItems.map((a, i) => (i === idx ? { ...a, [field]: value } : a))
    }));

  // ── Режим редактирования ──────────────────────────────────────────────
  if (editingSummary && summaryDraft) {
    const owners = summaryDraft.participants.filter(Boolean);

    // Авто-высота textarea: вызывать и при монтировании (ref), и при вводе
    function growEl(el) {
      if (!el) return;
      el.style.height = "auto";
      el.style.height = el.scrollHeight + "px";
    }
    function autoGrow(e) { growEl(e.target); }

    // При переименовании участника — обновляем и задачи с тем же owner.
    // Читаем oldName из d(), а не из замыкания, чтобы избежать stale closure.
    function renameParticipant(idx, newName) {
      setSummaryDraft((d) => {
        const oldName = d.participants[idx];
        return {
          ...d,
          participants: d.participants.map((p, pi) => pi === idx ? newName : p),
          actionItems: d.actionItems.map((a) =>
            a.owner === oldName ? { ...a, owner: newName } : a
          )
        };
      });
    }

    // При удалении участника — очищаем owner в его задачах.
    function removeParticipant(idx) {
      setSummaryDraft((d) => {
        const name = d.participants[idx];
        return {
          ...d,
          participants: d.participants.filter((_, pi) => pi !== idx),
          actionItems: d.actionItems.map((a) =>
            a.owner === name ? { ...a, owner: "" } : a
          )
        };
      });
    }

    return html`
      <div className="result-stack summary-edit">

        <section className="result-block">
          <div className="eyebrow">Краткий обзор</div>
          <textarea
            className="se-textarea se-textarea--overview"
            rows="3"
            value=${summaryDraft.overview}
            ref=${growEl}
            onInput=${(e) => { autoGrow(e); setSummaryDraft((d) => ({ ...d, overview: e.target.value })); }}
            placeholder="Краткое описание встречи"
          ></textarea>
        </section>

        <section className="result-block">
          <div className="eyebrow">Участники</div>
          <div className="se-chips">
            ${summaryDraft.participants.map((p, i) => html`
              <div key=${i} className="se-chip">
                <input
                  className="se-chip-input"
                  value=${p}
                  style=${{ width: Math.max((p || "").length, 4) + "ch" }}
                  onInput=${(e) => {
                    const newName = e.target.value;
                    e.target.style.width = Math.max(newName.length, 4) + "ch";
                    renameParticipant(i, newName);
                  }}
                  placeholder="Имя"
                />
                <button className="se-chip-remove" onClick=${() => removeParticipant(i)}>✕</button>
              </div>`)}
            <button className="se-chip-add" onClick=${() => addToList("participants", "")}>+ Добавить</button>
          </div>
        </section>

        <section className="result-block">
          <div className="eyebrow">Что решили</div>
          <div className="se-decisions">
            ${summaryDraft.decisions.map((d, i) => html`
              <div key=${i} className="se-decision-row">
                <span className="se-decision-num">${i + 1}.</span>
                <textarea
                  className="se-textarea se-textarea--decision"
                  rows="1"
                  value=${d}
                  ref=${growEl}
                  onInput=${(e) => { autoGrow(e); setList("decisions", i, e.target.value); }}
                  placeholder="Решение"
                ></textarea>
                <button className="se-row-remove" onClick=${() => removeFromList("decisions", i)} title="Удалить">🗑</button>
              </div>`)}
            <button className="se-ghost-add" onClick=${() => addToList("decisions", "")}>+ Добавить решение</button>
          </div>
        </section>

        <section className="result-block">
          <div className="eyebrow">Следующие шаги</div>
          <div className="se-actions">
            ${summaryDraft.actionItems.map((item, i) => html`
              <div key=${i} className="se-action-card">
                <textarea
                  className="se-textarea se-textarea--task"
                  rows="2"
                  value=${item.task ?? ""}
                  ref=${growEl}
                  onInput=${(e) => { autoGrow(e); setAction(i, "task", e.target.value); }}
                  placeholder="Что нужно сделать…"
                ></textarea>
                <div className="se-action-meta">
                  <div className="se-action-meta-field">
                    <span className="se-meta-label">👤</span>
                    <select
                      className="se-meta-select"
                      value=${item.owner ?? ""}
                      onChange=${(e) => setAction(i, "owner", e.target.value)}
                    >
                      <option value="">— не назначен —</option>
                      ${owners.map((o, j) => html`<option key=${j} value=${o}>${o}</option>`)}
                    </select>
                  </div>
                  <div className="se-action-meta-field">
                    <span className="se-meta-label">📅</span>
                    <input
                      type="date"
                      className="se-meta-input se-meta-input--date"
                      value=${item.deadline ?? ""}
                      onInput=${(e) => setAction(i, "deadline", e.target.value || null)}
                    />
                  </div>
                  <button className="se-action-remove" onClick=${() => removeFromList("actionItems", i)} title="Удалить задачу">🗑</button>
                </div>
              </div>`)}
            <button className="se-ghost-add" onClick=${() => addToList("actionItems", { owner: "", task: "", deadline: null })}>+ Добавить задачу</button>
          </div>
        </section>

        <div className="se-sticky-bar">
          <button className="ghost-button" onClick=${() => setEditingSummary(false)} disabled=${savingSummary}>Отмена</button>
          <button className="primary-button" onClick=${saveSummary} disabled=${savingSummary}>
            ${savingSummary ? "Сохраняем…" : "Сохранить итоги"}
          </button>
        </div>
      </div>
    `;
  }

  // ── Режим просмотра ───────────────────────────────────────────────────
  return html`
    <div className="result-stack">
      <section className="result-block">
        <div className="eyebrow">Участники</div>
        ${protocol.participants?.length
          ? html`<ul>${protocol.participants.map((p, i) => html`<li key=${i}>${p}</li>`)}</ul>`
          : html`<p className="empty-hint">Не определены</p>`}
      </section>

      ${protocol.topics?.length ? html`
        <section className="result-block">
          <div className="eyebrow">Темы встречи</div>
          <div className="topics-list">
            ${protocol.topics.map((t, i) => html`
              <div key=${i} className="topic-card">
                <div className="topic-title">${i + 1}. ${t.title}</div>
                <p className="topic-narrative">${t.narrative}</p>
              </div>`)}
          </div>
        </section>` : null}

      <section className="result-block">
        <div className="eyebrow">Что решили</div>
        ${protocol.decisions?.length
          ? html`<ol>${protocol.decisions.map((d, i) => html`<li key=${i}>${d}</li>`)}</ol>`
          : html`<p className="empty-hint">Решений не зафиксировано</p>`}
      </section>

      <section className="result-block">
        <div className="eyebrow">Следующие шаги</div>
        ${protocol.actionItems?.length
          ? html`<ul className="action-list">${protocol.actionItems.map((item, i) => html`
              <li key=${i} className="action-item action-item--static">
                <span className="action-owner">${item.owner}</span>
                <span className="action-task">${item.task}</span>
                ${item.deadline
                  ? html`<span className="action-deadline">до ${item.deadline}</span>`
                  : html`<span className="action-deadline action-deadline--empty">срок не указан</span>`}
              </li>`)}</ul>`
          : html`<p className="empty-hint">Задач не зафиксировано</p>`}
      </section>

      ${protocol.transcriptHighlights?.length ? html`
        <section className="result-block">
          <div className="eyebrow">Ключевые цитаты</div>
          <div className="highlights-list">
            ${protocol.transcriptHighlights.map((h, i) => html`
              <div key=${i} className="highlight-card">
                <div className="highlight-speaker">${h.speaker ?? "—"}</div>
                <blockquote className="highlight-quote">«${h.quote}»</blockquote>
              </div>`)}
          </div>
        </section>` : null}

      <div className="edit-btn--mobile-wrap">
        <button className="ghost-button ghost-button--sm" onClick=${onStartEdit}>✏️ Редактировать итоги</button>
      </div>
    </div>
  `;
}
