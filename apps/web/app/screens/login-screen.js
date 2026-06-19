/**
 * Экран входа/регистрации. Единственный экран с собственным состоянием —
 * остальные получают всё через параметры от App.
 */
import { html, useState } from "../html.js?v=__BUILD__";

export function LoginScreen({ api, onAuth }) {
  const [mode, setMode] = useState("login"); // "login" | "register"
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [needTotp, setNeedTotp] = useState(false); // сервер запросил второй фактор
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  function backToCredentials() {
    setNeedTotp(false);
    setTotpCode("");
    setErr("");
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!login.trim() || !password) { setErr("Заполните все поля."); return; }
    if (needTotp && !totpCode.trim()) { setErr("Введите код подтверждения."); return; }
    setBusy(true);
    setErr("");
    try {
      let result;
      if (mode === "login") {
        result = await api.login(login.trim(), password, totpCode.trim());
      } else {
        result = await api.register(login.trim(), password);
      }
      onAuth(result.user);
    } catch (e) {
      if (e.totpRequired) {
        // Пароль верен — переходим ко второму шагу (ввод кода).
        setNeedTotp(true);
        setErr(e.totpInvalid ? "Неверный код. Попробуйте ещё раз." : "");
      } else {
        setErr(e.message);
      }
    } finally {
      setBusy(false);
    }
  }

  const title = needTotp
    ? "Подтверждение входа"
    : mode === "login" ? "Вход" : "Регистрация";

  return html`
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-logo">YaSpeech</div>
        <h1 className="auth-title">${title}</h1>
        <form className="auth-form" onSubmit=${handleSubmit}>
          ${needTotp
            ? html`
              <p className="auth-hint">
                Введите 6-значный код из приложения-аутентификатора
                (Google Authenticator, 1Password и т.п.).
              </p>
              <label className="field">
                <span>Код подтверждения</span>
                <input
                  type="text"
                  inputmode="numeric"
                  autocomplete="one-time-code"
                  pattern="[0-9]*"
                  maxlength="9"
                  value=${totpCode}
                  onInput=${(e) => setTotpCode(e.target.value)}
                  placeholder="000000"
                  autoFocus
                  disabled=${busy}
                />
              </label>
            `
            : html`
              <label className="field">
                <span>Логин</span>
                <input
                  type="text"
                  autocomplete="username"
                  value=${login}
                  onInput=${(e) => setLogin(e.target.value)}
                  placeholder="Имя пользователя"
                  disabled=${busy}
                />
              </label>
              <label className="field">
                <span>Пароль</span>
                <input
                  type="password"
                  autocomplete=${mode === "login" ? "current-password" : "new-password"}
                  value=${password}
                  onInput=${(e) => setPassword(e.target.value)}
                  placeholder="Минимум 6 символов"
                  disabled=${busy}
                />
              </label>
            `}
          ${err ? html`<div className="auth-error">${err}</div>` : null}
          <button className="primary-button" type="submit" disabled=${busy}>
            ${busy
              ? "Подождите…"
              : needTotp ? "Подтвердить" : mode === "login" ? "Войти" : "Зарегистрироваться"}
          </button>
        </form>
        <div className="auth-switch">
          ${needTotp
            ? html`<button className="link-button" onClick=${backToCredentials}>← Назад ко входу</button>`
            : mode === "login"
              ? html`Нет аккаунта? <button className="link-button" onClick=${() => { setMode("register"); setErr(""); }}>Создать</button>`
              : html`Уже есть аккаунт? <button className="link-button" onClick=${() => { setMode("login"); setErr(""); }}>Войти</button>`}
        </div>
      </div>
    </div>
  `;
}
