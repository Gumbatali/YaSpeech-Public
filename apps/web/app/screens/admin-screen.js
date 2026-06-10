/**
 * Админ-экран: пользователи, роли, баны, квоты.
 * Состояние живёт в App — сюда приходит через параметры.
 * Вызывается как функция (не компонент): AdminScreen({ ... }).
 */
import { html } from "../html.js?v=__BUILD__";

export function AdminScreen({
  api,
  authUser,
  adminUsers,
  adminLoading,
  adminBusyId,
  runAdminAction,
  loadAdminUsers,
  openProjectHome,
  handleLogout,
  setError,
  noticeArea
}) {
  function quotaLabel(user) {
    if (user.transcriptionQuota === null || user.transcriptionQuota === undefined) {
      return `${user.transcriptionUsed ?? 0} / ∞`;
    }
    return `${user.transcriptionUsed ?? 0} / ${user.transcriptionQuota}`;
  }

  async function changeQuota(user) {
    const current = user.transcriptionQuota ?? "";
    const input = prompt(
      `Лимит расшифровок для «${user.login}».\nПустое поле = безлимит, число ≥ 0 = лимит.`,
      current === null ? "" : String(current)
    );
    if (input === null) return; // отмена
    const trimmed = input.trim();
    const quota = trimmed === "" ? null : Number(trimmed);
    if (quota !== null && (!Number.isInteger(quota) || quota < 0)) {
      setError("Лимит должен быть целым числом ≥ 0 или пустым.");
      return;
    }
    await runAdminAction(user.id, () => api.setUserQuota(user.id, quota));
  }

  return html`
    <section className="screen admin-screen">
      <header className="screen-header">
        <div className="screen-header-top">
          <div className="brand-mark">YaSpeech</div>
          <div className="user-chip">
            <span className="user-chip-login">${authUser?.login ?? ""}</span>
            <button className="link-button" onClick=${openProjectHome}>К проектам</button>
            <button className="link-button user-logout" onClick=${handleLogout}>Выйти</button>
          </div>
        </div>
        <h1>Администрирование</h1>
        <p>Пользователи, роли, блокировки и лимиты на расшифровки.</p>
      </header>

      ${noticeArea}

      <section className="panel">
        <div className="row">
          <h2>Пользователи</h2>
          <button className="ghost-button ghost-button--sm" onClick=${loadAdminUsers} disabled=${adminLoading}>
            ${adminLoading ? "Обновляем…" : "Обновить"}
          </button>
        </div>

        ${adminLoading && adminUsers.length === 0
          ? html`<div className="empty-state">Загружаем…</div>`
          : adminUsers.length === 0
            ? html`<div className="empty-state">Пользователей нет.</div>`
            : html`
              <div className="admin-table">
                <div className="admin-row admin-row--head">
                  <span>Логин</span>
                  <span>Роль</span>
                  <span>Статус</span>
                  <span>Расшифровки</span>
                  <span>Действия</span>
                </div>
                ${adminUsers.map((user) => {
                  const isSelf = user.id === authUser?.id;
                  const busy = adminBusyId === user.id;
                  return html`
                    <div key=${user.id} className=${"admin-row" + (busy ? " admin-row--busy" : "")}>
                      <span className="admin-login">
                        ${user.login}${isSelf ? html`<span className="admin-self"> (вы)</span>` : null}
                      </span>
                      <span>
                        <span className=${"role-badge role-badge--" + user.role}>${user.role === "admin" ? "админ" : "участник"}</span>
                      </span>
                      <span>
                        <span className=${"status-badge status-badge--" + (user.status ?? "active")}>
                          ${user.status === "banned" ? "заблокирован" : "активен"}
                        </span>
                      </span>
                      <span className="admin-quota">${quotaLabel(user)}</span>
                      <span className="admin-actions">
                        ${user.role === "admin"
                          ? html`<button className="link-button" disabled=${busy || isSelf}
                              onClick=${() => runAdminAction(user.id, () => api.setUserRole(user.id, "member"))}>→ участник</button>`
                          : html`<button className="link-button" disabled=${busy}
                              onClick=${() => runAdminAction(user.id, () => api.setUserRole(user.id, "admin"))}>→ админ</button>`}
                        <button className="link-button" disabled=${busy} onClick=${() => changeQuota(user)}>лимит</button>
                        <button className="link-button" disabled=${busy}
                          onClick=${() => runAdminAction(user.id, () => api.resetUserQuota(user.id))}>сброс</button>
                        ${user.status === "banned"
                          ? html`<button className="link-button" disabled=${busy}
                              onClick=${() => runAdminAction(user.id, () => api.unbanUser(user.id))}>разблок.</button>`
                          : html`<button className="link-button link-button--danger" disabled=${busy || isSelf}
                              onClick=${() => runAdminAction(user.id, () => api.banUser(user.id))}>блок.</button>`}
                      </span>
                    </div>
                  `;
                })}
              </div>
            `}
      </section>
    </section>
  `;
}
