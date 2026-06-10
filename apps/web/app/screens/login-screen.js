/**
 * Экран входа/регистрации. Единственный экран с собственным состоянием —
 * остальные получают всё через параметры от App.
 */
import { html, useState } from "../html.js?v=__BUILD__";

export function LoginScreen({ api, onAuth }) {
  const [mode, setMode] = useState("login"); // "login" | "register"
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function handleSubmit(event) {
    event.preventDefault();
    if (!login.trim() || !password) { setErr("Заполните все поля."); return; }
    setBusy(true);
    setErr("");
    try {
      let result;
      if (mode === "login") {
        result = await api.login(login.trim(), password);
      } else {
        result = await api.register(login.trim(), password);
      }
      onAuth(result.user);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return html`
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-logo">YaSpeech</div>
        <h1 className="auth-title">${mode === "login" ? "Вход" : "Регистрация"}</h1>
        <form className="auth-form" onSubmit=${handleSubmit}>
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
          ${err ? html`<div className="auth-error">${err}</div>` : null}
          <button className="primary-button" type="submit" disabled=${busy}>
            ${busy ? "Подождите…" : mode === "login" ? "Войти" : "Зарегистрироваться"}
          </button>
        </form>
        <div className="auth-switch">
          ${mode === "login"
            ? html`Нет аккаунта? <button className="link-button" onClick=${() => { setMode("register"); setErr(""); }}>Создать</button>`
            : html`Уже есть аккаунт? <button className="link-button" onClick=${() => { setMode("login"); setErr(""); }}>Войти</button>`}
        </div>
      </div>
    </div>
  `;
}
