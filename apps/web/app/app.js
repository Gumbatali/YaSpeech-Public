import {
  TIMELINE_STEPS,
  getMeetingStatusLabel,
  getStageViewModel,
  getTimelineStepState,
  resolveScreen
} from "./ui-model.js";
import { preprocessAudio } from "./audio/preprocessor.js";
import { analyzeAudioQuality, describeQuality } from "./audio/quality-analyzer.js";

(function bootstrapApp() {
  const { useEffect, useState } = window.React;
  const html = window.htm.bind(window.React.createElement);

  class ApiClient {
    constructor(onUnauthorized) {
      this._onUnauthorized = onUnauthorized;
    }

    async json(pathname, init = {}, { skipAuthRedirect = false } = {}) {
      const response = await fetch(pathname, {
        ...init,
        headers: {
          "content-type": "application/json",
          ...(init.headers ?? {})
        }
      });

      if (response.status === 401 && !skipAuthRedirect) {
        this._onUnauthorized?.();
        throw new Error("Сессия истекла. Войдите снова.");
      }

      if (!response.ok) {
        let message = "Не удалось выполнить запрос.";
        try {
          const body = await response.json();
          // Поддерживаем оба формата: { error: "string" } и { error: { message } }
          message = typeof body.error === "string"
            ? body.error
            : (body.error?.message ?? message);
        } catch {}
        throw new Error(message);
      }

      return response.json();
    }

    getMe() {
      return this.json("/api/auth/me");
    }

    register(login, password) {
      return this.json("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({ login, password })
      }, { skipAuthRedirect: true });
    }

    login(login, password) {
      return this.json("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ login, password })
      }, { skipAuthRedirect: true });
    }

    logout() {
      return this.json("/api/auth/logout", { method: "POST" });
    }

    listProjects() {
      return this.json("/api/projects");
    }

    createProject(payload) {
      return this.json("/api/projects", {
        method: "POST",
        body: JSON.stringify(payload)
      });
    }

    getTeam(projectId) {
      return this.json(`/api/projects/${projectId}/team`);
    }

    updateTeam(projectId, payload) {
      return this.json(`/api/projects/${projectId}/team`, {
        method: "PUT",
        body: JSON.stringify(payload)
      });
    }

    listMeetings(projectId) {
      return this.json(`/api/projects/${projectId}/meetings`);
    }

    createMeeting(payload) {
      return this.json("/api/meetings", {
        method: "POST",
        body: JSON.stringify(payload)
      });
    }

    uploadFile(upload, file, onProgress) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open(upload.method, upload.uploadUrl);
        xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable && onProgress) {
            onProgress(Math.round((e.loaded / e.total) * 100));
          }
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(xhr);
          } else {
            reject(new Error(`Ошибка загрузки файла на сервер (HTTP ${xhr.status}).`));
          }
        };
        xhr.onerror = () => reject(new Error("Ошибка загрузки файла."));
        xhr.send(file);
      });
    }

    completeUpload(meetingId, sizeBytes, durationSeconds) {
      return this.json(`/api/meetings/${meetingId}/upload-complete`, {
        method: "POST",
        body: JSON.stringify({ sizeBytes, durationSeconds: durationSeconds ?? null })
      });
    }

    confirmDraft(meetingId, payload) {
      return this.json(`/api/meetings/${meetingId}/confirm-draft`, {
        method: "POST",
        body: JSON.stringify(payload)
      });
    }

    getMeeting(meetingId) {
      return this.json(`/api/meetings/${meetingId}`);
    }

    patchTranscript(meetingId, rawText) {
      return this.json(`/api/meetings/${meetingId}/transcript`, {
        method: "PATCH",
        body: JSON.stringify({ rawText })
      });
    }

    patchProtocol(meetingId, protocol) {
      return this.json(`/api/meetings/${meetingId}/protocol`, {
        method: "PATCH",
        body: JSON.stringify({ protocol })
      });
    }

    restoreTranscript(meetingId) {
      return this.json(`/api/meetings/${meetingId}/transcript/restore`, {
        method: "POST",
        body: JSON.stringify({})
      });
    }

    // ── Админ: управление пользователями ──
    listUsers() {
      return this.json("/api/admin/users");
    }

    setUserRole(userId, role) {
      return this.json(`/api/admin/users/${userId}/role`, {
        method: "PATCH",
        body: JSON.stringify({ role })
      });
    }

    banUser(userId) {
      return this.json(`/api/admin/users/${userId}/ban`, {
        method: "POST",
        body: JSON.stringify({})
      });
    }

    unbanUser(userId) {
      return this.json(`/api/admin/users/${userId}/unban`, {
        method: "POST",
        body: JSON.stringify({})
      });
    }

    setUserQuota(userId, quota) {
      return this.json(`/api/admin/users/${userId}/quota`, {
        method: "PATCH",
        body: JSON.stringify({ quota })
      });
    }

    resetUserQuota(userId) {
      return this.json(`/api/admin/users/${userId}/quota/reset`, {
        method: "POST",
        body: JSON.stringify({})
      });
    }

    regenerateProtocol(meetingId) {
      return this.json(`/api/meetings/${meetingId}/regenerate-protocol`, {
        method: "POST",
        body: JSON.stringify({})
      });
    }

    retryMeeting(meetingId) {
      return this.json(`/api/meetings/${meetingId}/retry`, {
        method: "POST",
        body: JSON.stringify({})
      });
    }

    async getProtocolText(meetingId) {
      const response = await fetch(`/api/meetings/${meetingId}/protocol.txt`);
      if (!response.ok) {
        throw new Error("Не удалось получить текст протокола.");
      }

      return response.text();
    }

    deleteProject(projectId) {
      return this.json(`/api/projects/${projectId}`, { method: "DELETE" });
    }

    deleteMeeting(meetingId) {
      return this.json(`/api/meetings/${meetingId}`, { method: "DELETE" });
    }
  }

  // api инициализируется позже, после определения App (нужен onUnauthorized)
  let api;

  function todayIso() {
    return new Date().toISOString().slice(0, 10);
  }

  function formatMeetingDate(value) {
    try {
      return new Intl.DateTimeFormat("ru-RU", { dateStyle: "long" }).format(new Date(value));
    } catch {
      return value;
    }
  }

  function nowHHMM() {
    const d = new Date();
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  function subtractSecondsHHMM(hhmm, seconds) {
    const [h, m] = hhmm.split(":").map(Number);
    const totalMin = h * 60 + m - Math.round(seconds / 60);
    const clampedMin = ((totalMin % 1440) + 1440) % 1440;
    return String(Math.floor(clampedMin / 60)).padStart(2, "0") + ":" + String(clampedMin % 60).padStart(2, "0");
  }

  function getMeetingTimeRange(meeting) {
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

  function formatMeetingTimeRange(meeting) {
    const range = getMeetingTimeRange(meeting);
    if (!range) return null;
    return range.start === range.end ? range.start : range.start + "–" + range.end;
  }

  function getAudioDuration(file) {
    return new Promise((resolve) => {
      const audio = document.createElement("audio");
      const url = URL.createObjectURL(file);
      audio.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(Math.round(audio.duration)); };
      audio.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      audio.src = url;
    });
  }

  function formatRecordingTime(seconds) {
    const m = String(Math.floor(seconds / 60)).padStart(2, "0");
    const s = String(seconds % 60).padStart(2, "0");
    return m + ":" + s;
  }

  function createProjectForm() {
    return { name: "" };
  }

  function createMeetingForm() {
    return { date: todayIso(), startTime: null, endTime: null, durationSeconds: null, file: null };
  }

  function createDraftForm(meeting = null) {
    return {
      titleDraft: meeting?.titleDraft ?? "",
      speakerDrafts: (meeting?.speakerDrafts ?? []).map((speaker) => ({ ...speaker }))
    };
  }

  function LoginScreen({ onAuth }) {
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

  function App() {
    const [authUser, setAuthUser] = useState(null);
    const [authChecked, setAuthChecked] = useState(false);
    const [projects, setProjects] = useState([]);
    const [selectedProjectId, setSelectedProjectId] = useState("");
    const [requestedScreen, setRequestedScreen] = useState("projects-home");
    const [teamDraft, setTeamDraft] = useState([]);
    const [meetings, setMeetings] = useState([]);
    const [activeMeeting, setActiveMeeting] = useState(null);
    const [notice, setNotice] = useState("");
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(true);
    const [submittingMeeting, setSubmittingMeeting] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(0);
    const [savingTeam, setSavingTeam] = useState(false);
    const [confirmingDraft, setConfirmingDraft] = useState(false);
    const [showProjectComposer, setShowProjectComposer] = useState(false);
    const [resultTab, setResultTab] = useState("summary"); // "summary" | "transcript"
    const [transcriptVersion, setTranscriptVersion] = useState("llm"); // "raw" | "llm"
    const [editingTranscript, setEditingTranscript] = useState(false);
    const [transcriptEditText, setTranscriptEditText] = useState("");
    const [savingTranscript, setSavingTranscript] = useState(false);
    const [regenerating, setRegenerating] = useState(false);
    const [restoringTranscript, setRestoringTranscript] = useState(false);
    // Редактирование всего саммари (обзор, участники, решения, задачи)
    const [editingSummary, setEditingSummary] = useState(false);
    const [summaryDraft, setSummaryDraft] = useState(null);
    const [savingSummary, setSavingSummary] = useState(false);
    // Админка
    const [adminUsers, setAdminUsers] = useState([]);
    const [adminLoading, setAdminLoading] = useState(false);
    const [adminBusyId, setAdminBusyId] = useState(null);
    const [fileProcessing, setFileProcessing] = useState(false);
    const [fileProcessingStage, setFileProcessingStage] = useState("");
    const [recording, setRecording] = useState(false);
    const [recordingSeconds, setRecordingSeconds] = useState(0);
    const recorderRef = React.useRef(null);
    const timerRef = React.useRef(null);
    const noticeTimerRef = React.useRef(null);

    function showNotice(msg, ms = 3000) {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
      setNotice(msg);
      noticeTimerRef.current = setTimeout(() => setNotice(""), ms);
    }

    const errorTimerRef = React.useRef(null);
    const [errorShake, setErrorShake] = useState(false);

    function showError(msg, ms = 4000) {
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
      setError(msg);
      setErrorShake(false);
      requestAnimationFrame(() => setErrorShake(true));
      errorTimerRef.current = setTimeout(() => { setError(""); setErrorShake(false); }, ms);
    }
    const streamRef = React.useRef(null);

    useEffect(() => {
      return () => {
        if (timerRef.current) {
          clearInterval(timerRef.current);
        }
        if (recorderRef.current && recorderRef.current.state !== "inactive") {
          try {
            recorderRef.current.stop();
          } catch {}
        }
        if (streamRef.current) {
          try {
            streamRef.current.getTracks().forEach((t) => t.stop());
          } catch {}
          streamRef.current = null;
        }
      };
    }, []);
    const [projectForm, setProjectForm] = useState(createProjectForm());
    const [meetingForm, setMeetingForm] = useState(createMeetingForm());
    const [draftForm, setDraftForm] = useState(createDraftForm());

    const selectedProject =
      projects.find((project) => project.id === selectedProjectId) ?? null;
    const currentScreen = resolveScreen({
      selectedProjectId,
      activeMeeting,
      requestedScreen
    });
    const stageView = getStageViewModel(activeMeeting);

    // Инициализируем api с колбэком на 401
    useEffect(() => {
      api = new ApiClient(() => {
        setAuthUser(null);
        setAuthChecked(true);
      });
      void checkAuth();
    }, []);

    // Загружаем проекты при авторизации
    useEffect(() => {
      if (authUser) {
        void bootstrap();
      }
    }, [authUser?.id]);

    useEffect(() => {
      if (!selectedProjectId) {
        setTeamDraft([]);
        setMeetings([]);
        setActiveMeeting(null);
        setMeetingForm(createMeetingForm());
        return;
      }

      void loadProjectContext(selectedProjectId);
    }, [selectedProjectId]);

    useEffect(() => {
      if (!activeMeeting || activeMeeting.status !== "draft_ready") {
        return;
      }

      setDraftForm(createDraftForm(activeMeeting));
    }, [activeMeeting?.id, activeMeeting?.status]);

    useEffect(() => {
      if (
        !activeMeeting ||
        !["uploaded", "speechkit_processing", "protocol_generating"].includes(
          activeMeeting.status
        )
      ) {
        return;
      }

      const timer = setInterval(() => {
        void refreshMeeting(activeMeeting.id, true);
      }, 1500);

      return () => clearInterval(timer);
    }, [activeMeeting?.id, activeMeeting?.status]);

    async function checkAuth() {
      try {
        const payload = await api.getMe();
        setAuthUser(payload.user);
      } catch {
        setAuthUser(null);
      } finally {
        setAuthChecked(true);
      }
    }

    async function bootstrap() {
      try {
        setLoading(true);
        setError("");
        const payload = await api.listProjects();
        setProjects(payload.projects);
      } catch (caughtError) {
        setError(caughtError.message);
      } finally {
        setLoading(false);
      }
    }

    async function handleLogout() {
      try {
        await api.logout();
      } catch {}
      setAuthUser(null);
      setProjects([]);
      setSelectedProjectId("");
      setActiveMeeting(null);
    }

    // ── Админка ──
    async function loadAdminUsers() {
      setAdminLoading(true);
      try {
        const { users } = await api.listUsers();
        setAdminUsers(users ?? []);
      } catch (e) {
        setError("Не удалось загрузить пользователей: " + (e.message ?? e));
      } finally {
        setAdminLoading(false);
      }
    }

    async function openAdmin() {
      setRequestedScreen("admin");
      await loadAdminUsers();
    }

    // Обёртка: выполняет admin-действие, обновляет одного юзера в списке
    async function runAdminAction(userId, action) {
      setAdminBusyId(userId);
      setError("");
      try {
        const { user } = await action();
        if (user) {
          setAdminUsers((list) => list.map((u) => (u.id === user.id ? user : u)));
        } else {
          await loadAdminUsers();
        }
      } catch (e) {
        setError("Действие не выполнено: " + (e.message ?? e));
      } finally {
        setAdminBusyId(null);
      }
    }

    async function loadProjectContext(projectId) {
      try {
        setLoading(true);
        setError("");
        const [teamResponse, meetingsResponse] = await Promise.all([
          api.getTeam(projectId),
          api.listMeetings(projectId)
        ]);

        setTeamDraft(teamResponse.members);
        setMeetings(meetingsResponse.meetings);
        setMeetingForm(createMeetingForm());
      } catch (caughtError) {
        setError(caughtError.message);
      } finally {
        setLoading(false);
      }
    }

    async function refreshProjects(options = {}) {
      const payload = await api.listProjects();
      setProjects(payload.projects);

      if (options.selectProjectId) {
        setSelectedProjectId(options.selectProjectId);
      }
    }

    async function refreshMeetings(projectId) {
      const payload = await api.listMeetings(projectId);
      setMeetings(payload.meetings);
      return payload.meetings;
    }

    async function refreshMeeting(meetingId, silent) {
      try {
        const payload = await api.getMeeting(meetingId);
        setActiveMeeting(payload.meeting);
        if (payload.meeting.projectId === selectedProjectId) {
          await refreshMeetings(selectedProjectId);
        }
      } catch (caughtError) {
        if (!silent) {
          setError(caughtError.message);
        }
      }
    }

    function openProject(projectId) {
      setNotice("");
      setError("");
      setSelectedProjectId(projectId);
      setRequestedScreen("");
      setActiveMeeting(null);
      setMeetingForm(createMeetingForm());
    }

    function goHome() {
      setSelectedProjectId("");
      setRequestedScreen("projects-home");
      setActiveMeeting(null);
      setMeetingForm(createMeetingForm());
      setDraftForm(createDraftForm());
      setNotice("");
      setError("");
    }

    function openProjectHome() {
      setRequestedScreen("");
      setActiveMeeting(null);
      setMeetingForm(createMeetingForm());
      setNotice("");
      setError("");
    }

    async function openMeetingFromHistory(meetingId) {
      setError("");
      setNotice("");
      await refreshMeeting(meetingId, false);
    }

    async function handleCreateProject(event) {
      event.preventDefault();
      if (!projectForm.name.trim()) {
        setError("Напишите название проекта.");
        return;
      }

      try {
        setError("");
        const payload = await api.createProject({
          name: projectForm.name.trim(),
          members: []
        });
        setProjectForm(createProjectForm());
        setShowProjectComposer(false);
        showNotice("Проект создан.");
        await refreshProjects({ selectProjectId: payload.project.id });
        setRequestedScreen("");
      } catch (caughtError) {
        setError(caughtError.message);
      }
    }

    function addTeamMember() {
      setTeamDraft((current) => [
        ...current,
        { id: `member-${Date.now()}-${current.length}`, name: "", role: "" }
      ]);
    }

    function updateTeamMember(index, field, value) {
      setTeamDraft((current) =>
        current.map((member, currentIndex) =>
          currentIndex === index ? { ...member, [field]: value } : member
        )
      );
    }

    function removeTeamMember(memberId) {
      setTeamDraft((current) => current.filter((member) => member.id !== memberId));
    }

    async function saveTeam() {
      if (!selectedProjectId) {
        return;
      }

      try {
        setSavingTeam(true);
        setError("");
        const cleanedMembers = teamDraft
          .map((member) => ({
            ...member,
            name: member.name.trim(),
            role: member.role.trim()
          }))
          .filter((member) => member.name);
        const payload = await api.updateTeam(selectedProjectId, {
          members: cleanedMembers
        });
        setTeamDraft(payload.project.team);
        showNotice("Участники проекта сохранены.");
        await refreshProjects({ selectProjectId: selectedProjectId });
      } catch (caughtError) {
        setError(caughtError.message);
      } finally {
        setSavingTeam(false);
      }
    }

    /** Кодирует AudioBuffer в WAV (PCM 16-bit) — без библиотек, работает в любом браузере */
    function encodeWav(audioBuffer) {
      const numChannels = audioBuffer.numberOfChannels;
      const sampleRate  = audioBuffer.sampleRate;
      const numSamples  = audioBuffer.length * numChannels;
      const dataBytes   = numSamples * 2;

      const buffer = new ArrayBuffer(44 + dataBytes);
      const view   = new DataView(buffer);
      const writeStr = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };

      writeStr(0, "RIFF");  view.setUint32(4, 36 + dataBytes, true);
      writeStr(8, "WAVE");  writeStr(12, "fmt ");
      view.setUint32(16, 16, true);  view.setUint16(20, 1, true);
      view.setUint16(22, numChannels, true);  view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * numChannels * 2, true);
      view.setUint16(32, numChannels * 2, true);  view.setUint16(34, 16, true);
      writeStr(36, "data");  view.setUint32(40, dataBytes, true);

      let off = 44;
      for (let i = 0; i < audioBuffer.length; i++) {
        for (let ch = 0; ch < numChannels; ch++) {
          const s = Math.max(-1, Math.min(1, audioBuffer.getChannelData(ch)[i]));
          view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
          off += 2;
        }
      }
      return buffer;
    }

    async function startRecording() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;

        const mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/mp4";
        const recorder = new MediaRecorder(stream, { mimeType });
        const chunks = [];

        recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
        recorder.onstop = async () => {
          if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
          if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
          setRecording(false);
          setRecordingSeconds(0);

          const webmBlob = new Blob(chunks, { type: mimeType });
          const baseName = "запись_" + new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "-");
          // handleFileSelect сам прогонит preprocessing — отдаём WebM как есть
          const recordedFile = new File([webmBlob], baseName + ".webm", { type: mimeType });
          void handleFileSelect(recordedFile);
        };

        recorderRef.current = recorder;
        recorder.start(250);
        setRecording(true);
        setRecordingSeconds(0);
        timerRef.current = setInterval(() => setRecordingSeconds((s) => s + 1), 1000);
      } catch (err) {
        setError("Нет доступа к микрофону. Разрешите доступ в настройках браузера.");
      }
    }

    function stopRecording() {
      recorderRef.current?.stop();
    }

    async function handleFileSelect(file) {
      setFileProcessing(true);
      setFileProcessingStage("Анализ записи…");

      // 1. Анализируем качество ДО обработки — чтобы предупредить юзера
      let qualityReport = null;
      try {
        showNotice("Анализ записи…", 10000);
        qualityReport = await analyzeAudioQuality(file);
        showNotice(describeQuality(qualityReport), 10000);
        if (qualityReport.quality === "poor") {
          setError("Качество записи низкое — результат распознавания может быть плохим. " +
            describeQuality(qualityReport));
        }
      } catch (e) {
        // не критично — пайплайн всё равно попробует обработать
      }

      // 2. Прогоняем через полный preprocessing pipeline
      try {
        setFileProcessingStage("Декодирование…");
        showNotice("Обработка аудио: декодирование…", 10000);
        const processed = await preprocessAudio(file, (stage, percent) => {
          setFileProcessingStage(`${stage} (${percent}%)`);
          showNotice(`Обработка аудио: ${stage} (${percent}%)`, 10000);
        });
        file = processed;

        // DEV: скачать обработанный WAV для прослушивания
        if (window.location.hostname === "localhost" || window.location.search.includes("debug_audio")) {
          const url = URL.createObjectURL(file);
          const a = document.createElement("a");
          a.href = url;
          a.download = `processed_${Date.now()}.wav`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 5000);
        }

        showNotice(`Файл готов к загрузке на расшифровку`, 3000);
      } catch (e) {
        setFileProcessing(false);
        setFileProcessingStage("");
        setError("Не удалось обработать аудио: " + e.message +
          ". Попробуйте сохранить в MP3 или WAV.");
        return;
      }

      setFileProcessing(false);
      setFileProcessingStage("");
      setNotice("");
      setError("");

      setMeetingForm((current) => ({ ...current, file, durationSeconds: null, startTime: null, endTime: null }));
      const dur = qualityReport?.durationSeconds ?? await getAudioDuration(file);
      const endTime = dur ? nowHHMM() : null;
      const startTime = dur ? subtractSecondsHHMM(endTime, dur) : null;
      setMeetingForm((current) => ({
        ...current,
        file,
        durationSeconds: dur,
        startTime,
        endTime
      }));
    }

    async function handleCreateMeeting(event) {
      event.preventDefault();
      if (!selectedProjectId) {
        setError("Сначала выберите проект.");
        return;
      }

      if (!meetingForm.file) {
        showError("Сначала выберите файл.");
        return;
      }

      const ALLOWED_TYPES = [
        "audio/mpeg", "audio/mp3",
        "audio/wav", "audio/wave", "audio/x-wav",
        "audio/ogg", "audio/opus", "audio/webm",
        "audio/mp4", "audio/m4a", "audio/x-m4a", "audio/aac",
        "audio/flac", "audio/x-flac", "video/mp4"
      ];
      const MAX_SIZE_BYTES = 1 * 1024 * 1024 * 1024; // 1 GB

      const fileType = meetingForm.file.type || "";
      const fileName = meetingForm.file.name || "";
      const AUDIO_EXT = /\.(mp3|wav|ogg|opus|m4a|aac|flac|mp4)$/i;

      if (!ALLOWED_TYPES.includes(fileType) && !AUDIO_EXT.test(fileName)) {
        setError("Неподдерживаемый формат. Допустимы: MP3, WAV, OGG, M4A, AAC, FLAC.");
        return;
      }

      if (meetingForm.file.size > MAX_SIZE_BYTES) {
        const sizeMb = (meetingForm.file.size / (1024 * 1024)).toFixed(0);
        setError(`Файл слишком большой (${sizeMb} МБ). Максимальный размер — 1 ГБ.`);
        return;
      }

      if (meetingForm.file.size === 0) {
        setError("Файл пустой. Выберите другой файл.");
        return;
      }

      try {
        setSubmittingMeeting(true);
        setError("");
        const payload = await api.createMeeting({
          projectId: selectedProjectId,
          date: meetingForm.date,
          startTime: meetingForm.startTime || null,
          endTime: meetingForm.endTime || null,
          participantIds: teamDraft.map((member) => member.id),
          guests: [],
          fileName: meetingForm.file.name,
          contentType: meetingForm.file.type || "application/octet-stream"
        });

        const file = meetingForm.file;
        const durationSeconds = meetingForm.durationSeconds ?? await getAudioDuration(file);
        setUploadProgress(0);
        await api.uploadFile(payload.upload, file, (pct) => setUploadProgress(pct));
        const uploaded = await api.completeUpload(
          payload.meeting.id,
          file.size,
          durationSeconds
        );
        setUploadProgress(0);
        // Файл залит — теперь переходим на экран с этапами
        setActiveMeeting(uploaded.meeting);
        showNotice("Запись загружена.");
        setMeetingForm(createMeetingForm());
        await refreshMeetings(selectedProjectId);
      } catch (caughtError) {
        setError(caughtError.message);
      } finally {
        setSubmittingMeeting(false);
      }
    }

    function updateDraftSpeaker(index, value) {
      setDraftForm((current) => ({
        ...current,
        speakerDrafts: current.speakerDrafts.map((speaker, currentIndex) =>
          currentIndex === index
            ? { ...speaker, guessedName: value }
            : speaker
        )
      }));
    }

    async function handleConfirmDraft() {
      if (!activeMeeting) {
        return;
      }

      try {
        setConfirmingDraft(true);
        setError("");
        const payload = await api.confirmDraft(activeMeeting.id, {
          titleDraft: draftForm.titleDraft,
          speakerDrafts: draftForm.speakerDrafts
        });
        setActiveMeeting(payload.meeting);
        showNotice("Черновик подтверждён.");
      } catch (caughtError) {
        setError(caughtError.message);
      } finally {
        setConfirmingDraft(false);
      }
    }

    async function retryMeeting() {
      if (!activeMeeting) {
        return;
      }

      try {
        const payload = await api.retryMeeting(activeMeeting.id);
        setActiveMeeting(payload.meeting);
        showNotice("Повторная обработка запущена.");
      } catch (caughtError) {
        setError(caughtError.message);
      }
    }

    async function handleDeleteProject(projectId) {
      try {
        setError("");
        await api.deleteProject(projectId);
        showNotice("Проект удалён.");
        const payload = await api.listProjects();
        setProjects(payload.projects);
      } catch (caughtError) {
        setError(caughtError.message);
      }
    }

    async function handleDeleteMeeting(meetingId) {
      try {
        setError("");
        await api.deleteMeeting(meetingId);
        showNotice("Встреча удалена.");
        await refreshMeetings(selectedProjectId);
        if (activeMeeting?.id === meetingId) {
          setActiveMeeting(null);
        }
      } catch (caughtError) {
        setError(caughtError.message);
      }
    }

    async function copyProtocol() {
      if (!activeMeeting) {
        return;
      }

      try {
        const protocolText = await api.getProtocolText(activeMeeting.id);
        await navigator.clipboard.writeText(protocolText);
        showNotice("Протокол скопирован.");
      } catch (caughtError) {
        setError(caughtError.message);
      }
    }

    async function downloadProtocol() {
      if (!activeMeeting) {
        return;
      }

      try {
        const protocolText = await api.getProtocolText(activeMeeting.id);
        const blob = new Blob([protocolText], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `${activeMeeting.projectId}-${activeMeeting.date}.txt`;
        anchor.click();
        URL.revokeObjectURL(url);
      } catch (caughtError) {
        setError(caughtError.message);
      }
    }

    function downloadTranscriptRaw() {
      const segments = activeMeeting?.rawTranscriptSegments ?? activeMeeting?.transcriptSegments;
      if (!segments?.length) {
        setError("Сырая расшифровка недоступна.");
        return;
      }
      const lines = segments.map((s) => {
        const name = s.guessedName || s.speakerLabel || s.speakerId;
        return `${name}:\n${s.text}`;
      });
      const text = [
        `Расшифровка встречи (исходная, без LLM-коррекции)`,
        `Проект: ${activeMeeting.projectId}`,
        `Дата: ${activeMeeting.date}`,
        ``,
        ...lines
      ].join("\n\n");
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `transcript-raw-${activeMeeting.projectId}-${activeMeeting.date}.txt`;
      anchor.click();
      URL.revokeObjectURL(url);
    }

    function downloadTranscriptLlm() {
      const correctedText = activeMeeting?.gptContext?.correctedText;
      const segments = parseLlmTranscript(correctedText);
      if (!segments?.length) {
        setError("LLM-расшифровка недоступна.");
        return;
      }
      const lines = segments.map((s) => {
        const name = s.guessedName || s.speakerLabel || s.speakerId;
        return `${name}:\n${s.text}`;
      });
      const text = [
        `Расшифровка встречи (LLM-восстановление)`,
        `Проект: ${activeMeeting.projectId}`,
        `Дата: ${activeMeeting.date}`,
        ``,
        ...lines
      ].join("\n\n");
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `transcript-llm-${activeMeeting.projectId}-${activeMeeting.date}.txt`;
      anchor.click();
      URL.revokeObjectURL(url);
    }

    function renderNoticeArea() {
      return html`
        ${notice ? html`<div className="banner banner-ok">${notice}</div>` : null}
        ${error ? html`<div className=${"banner banner-error" + (errorShake ? " banner-shake" : "")}>${error}</div>` : null}
      `;
    }

    function renderProjectsScreen() {
      return html`
        <section className="screen projects-screen">
          <header className="screen-header">
            <div className="screen-header-top">
              <div className="brand-mark">YaSpeech</div>
              <div className="user-chip">
                <span className="user-chip-login">${authUser?.login ?? ""}</span>
                ${authUser?.role === "admin"
                  ? html`<button className="link-button" onClick=${openAdmin}>Админ</button>`
                  : null}
                <button className="link-button user-logout" onClick=${handleLogout}>Выйти</button>
              </div>
            </div>
            <h1>Проекты</h1>
            <p>
              Выберите проект, чтобы загрузить запись встречи и получить
              протокол.
            </p>
          </header>

          ${renderNoticeArea()}

          <section className="panel">
            <div className="row">
              <h2>Список проектов</h2>
              <button
                className="ghost-button"
                onClick=${() => setShowProjectComposer((current) => !current)}
              >
                ${showProjectComposer ? "Скрыть" : "Новый проект"}
              </button>
            </div>

            ${showProjectComposer
              ? html`
                  <form className="stack-form" onSubmit=${handleCreateProject}>
                    <label className="field">
                      <span>Название проекта</span>
                      <input
                        value=${projectForm.name}
                        onInput=${(event) =>
                          setProjectForm({ name: event.target.value })}
                        placeholder="Например, ЖК Октябрьская улица 2"
                      />
                    </label>
                    <button className="primary-button" type="submit">Создать проект</button>
                  </form>
                `
              : null}

            <div className="project-list">
              ${projects.map(
                (project) => html`
                  <div key=${project.id} className="project-card">
                    <button
                      className="project-card-body"
                      onClick=${() => openProject(project.id)}
                    >
                      <strong>${project.name}</strong>
                      <span>${(() => {
                        const n = project.team?.length ?? project.teamCount ?? 0;
                        if (n === 0) return "Нет участников";
                        const label = n === 1 ? "участник" : n >= 2 && n <= 4 ? "участника" : "участников";
                        return n + " " + label;
                      })()}</span>
                    </button>
                    <button
                      className="ghost-button card-remove-button"
                      onClick=${(e) => { e.stopPropagation(); handleDeleteProject(project.id); }}
                    >
                      Убрать
                    </button>
                  </div>
                `
              )}
            </div>

            ${projects.length === 0
              ? html`
                  <div className="empty-state">
                    Пока нет проектов. Создайте первый и дальше просто загружайте
                    записи встреч.
                  </div>
                `
              : null}
          </section>
        </section>
      `;
    }

    function renderProjectHeader() {
      return html`
        <header className="project-header">
          <button className="back-button" onClick=${goHome}>Назад</button>
          <div className="project-heading">
            <div className="eyebrow">Проект</div>
            <h1>${selectedProject?.name}</h1>
          </div>
          <button
            className="ghost-button members-button"
            onClick=${() => setRequestedScreen("project-people")}
          >
            ${(() => {
              const n = selectedProject?.team?.length ?? 0;
              if (n === 0) return "Состав проекта";
              const label = n === 1 ? "участник" : n >= 2 && n <= 4 ? "участника" : "участников";
              return n + " " + label;
            })()}
          </button>
        </header>
      `;
    }

    function renderUploadCard() {
      return html`
        <form className="panel panel-main" onSubmit=${handleCreateMeeting}>
          <div className="panel-head">
            <div>
              <div className="eyebrow">Новая запись</div>
              <h2>Загрузить запись</h2>
              <div className="meeting-datetime-edit">
                <input
                  className="date-inline"
                  type="date"
                  value=${meetingForm.date}
                  onInput=${(event) =>
                    setMeetingForm((current) => ({ ...current, date: event.target.value }))}
                />
                ${meetingForm.startTime
                  ? html`<div className="time-range-edit">
                      <input
                        className="time-inline"
                        type="time"
                        value=${meetingForm.startTime}
                        onInput=${(event) =>
                          setMeetingForm((current) => ({ ...current, startTime: event.target.value }))}
                      />
                      <span className="time-sep">–</span>
                      <input
                        className="time-inline"
                        type="time"
                        value=${meetingForm.endTime}
                        onInput=${(event) =>
                          setMeetingForm((current) => ({ ...current, endTime: event.target.value }))}
                      />
                    </div>`
                  : null}
              </div>
            </div>
            <p className="panel-copy">
              Система подготовит текст встречи, предложит черновик и потом
              соберёт готовый протокол.
            </p>
          </div>

          <div className="file-picker">
            <div className="file-picker-actions">
              <label className="file-picker-button" aria-disabled=${recording}>
                <input
                  type="file"
                  accept=".mp3,.wav,.ogg,.opus,.m4a,.aac,.flac,audio/mpeg,audio/wav,audio/ogg,audio/opus,audio/mp4,audio/m4a,audio/aac,audio/flac"
                  disabled=${recording}
                  onChange=${(event) => {
                    const f = event.target.files?.[0];
                    if (f) void handleFileSelect(f);
                  }}
                />
                Выбрать файл
              </label>

              ${recording
                ? html`<button
                    type="button"
                    className="record-stop-button"
                    onClick=${stopRecording}
                  >
                    <span className="rec-dot"></span>
                    ${formatRecordingTime(recordingSeconds)}
                    · Остановить
                  </button>`
                : html`<button
                    type="button"
                    className="record-start-button"
                    onClick=${startRecording}
                  >
                    <span className="rec-dot"></span>
                    Записать
                  </button>`}
            </div>

            <div className="file-picker-meta">
              ${fileProcessing
                ? html`
                    <div className="file-processing-status">
                      <span className="file-processing-spinner"></span>
                      <strong>Обрабатываем файл…</strong>
                    </div>
                    <span className="file-processing-stage">${fileProcessingStage}</span>
                  `
                : meetingForm.file
                  ? html`
                      <div className="file-ready-status">
                        <span className="file-ready-icon">
                          <svg width="11" height="9" viewBox="0 0 11 9" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M1 4L4 7.5L10 1" stroke="#22c55e" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>
                          </svg>
                        </span>
                        <strong>${meetingForm.file.name}</strong>
                      </div>
                      <span>${(meetingForm.file.size / (1024 * 1024)).toFixed(1)} МБ · готов к загрузке</span>
                    `
                  : html`
                      <strong>Файл пока не выбран</strong>
                      <span>MP3, M4A, WAV, OGG, FLAC, AAC · максимум 1 ГБ</span>
                    `}
            </div>
          </div>

          ${submittingMeeting
            ? html`<div className="upload-progress-wrap">
                <div className="upload-progress-bar" style=${{ width: uploadProgress + "%" }}></div>
                <span className="upload-progress-label">${uploadProgress < 100 ? uploadProgress + "% · загружаем файл…" : "Финализируем…"}</span>
              </div>`
            : null}

          <button
            className="primary-button"
            type="submit"
            disabled=${submittingMeeting}
          >
            ${submittingMeeting ? "Загружаем..." : "Загрузить запись"}
          </button>
        </form>
      `;
    }

    function renderMeetingsList() {
      const recentMeetings = meetings.slice(0, 5);

      return html`
        <section className="panel">
          <div className="row">
            <h2>Последние встречи</h2>
            <span className="muted">${meetings.length}</span>
          </div>

          <div className="meeting-list">
            ${recentMeetings.map(
              (meeting) => html`
                <div key=${meeting.id} className="meeting-row">
                  <button
                    className="meeting-row-body"
                    onClick=${() => openMeetingFromHistory(meeting.id)}
                  >
                    <div className="meeting-info">
                      <strong>${meeting.summaryTitle || "Новая встреча"}</strong>
                      <span className="meeting-date-line">${formatMeetingDate(meeting.date)}</span>
                      ${formatMeetingTimeRange(meeting)
                        ? html`<span className="meeting-time-line">${formatMeetingTimeRange(meeting)}</span>`
                        : null}
                    </div>
                    <span className="status-chip">${getMeetingStatusLabel(meeting)}</span>
                  </button>
                  <button
                    className="ghost-button card-remove-button"
                    onClick=${() => handleDeleteMeeting(meeting.id)}
                  >
                    Убрать
                  </button>
                </div>
              `
            )}
          </div>

          ${meetings.length === 0
            ? html`
                <div className="empty-state">
                  После первой записи здесь появятся последние встречи проекта.
                </div>
              `
            : null}
        </section>
      `;
    }

    function renderProjectHome() {
      return html`
        <section className="screen project-screen">
          ${renderProjectHeader()}
          ${renderNoticeArea()}
          <div className="stack">
            ${renderUploadCard()}
            ${renderMeetingsList()}
          </div>
        </section>
      `;
    }

    function renderProcessingScreen() {
      return html`
        <section className="screen project-screen">
          ${renderProjectHeader()}
          ${renderNoticeArea()}

          <section className="panel panel-main">
            <div className="panel-head">
              <div>
                <div className="eyebrow">Обработка</div>
                <h2>${stageView.title}</h2>
              </div>
              <p className="panel-copy">${stageView.detail}</p>
            </div>

            <div className="timeline">
              ${TIMELINE_STEPS.map((step) => html`
                <div
                  key=${step.key}
                  className=${`timeline-item ${getTimelineStepState(step.key, activeMeeting)}`}
                >
                  <span className="timeline-dot"></span>
                  <strong>${step.title}</strong>
                </div>
              `)}
            </div>

            <div className="meta-box">
              <div className="meta-row">
                <span>Дата</span>
                <strong>${activeMeeting ? formatMeetingDate(activeMeeting.date) : "—"}</strong>
              </div>
              ${activeMeeting && formatMeetingTimeRange(activeMeeting)
                ? html`<div className="meta-row">
                    <span>Время</span>
                    <strong>${formatMeetingTimeRange(activeMeeting)}</strong>
                  </div>`
                : null}
              <div className="meta-row">
                <span>Файл</span>
                <strong>${activeMeeting?.audioFile?.originalFileName || "—"}</strong>
              </div>
            </div>

            ${activeMeeting?.status === "failed"
              ? activeMeeting?.error?.code === "POOR_TRANSCRIPT"
                ? html`
                    <div className="poor-transcript-block">
                      <div className="poor-transcript-icon">🎙️</div>
                      <div className="poor-transcript-title">Не удалось распознать речь</div>
                      <div className="poor-transcript-body">
                        ${activeMeeting.error.message || "Качество записи недостаточно для расшифровки."}
                      </div>
                      <div className="poor-transcript-hints">
                        <b>Что можно сделать:</b>
                        <ul>
                          <li>Записывать ближе к источнику звука</li>
                          <li>Убрать фоновый шум (закрыть окно, выключить кондиционер)</li>
                          <li>Проверить что файл не повреждён</li>
                        </ul>
                      </div>
                      <div className="button-row">
                        <button className="ghost-button" onClick=${openProjectHome}>К проекту</button>
                      </div>
                    </div>
                  `
                : html`
                    <div className="button-row">
                      <button className="primary-button" onClick=${retryMeeting}>
                        Попробовать снова
                      </button>
                      <button className="ghost-button" onClick=${openProjectHome}>
                        К проекту
                      </button>
                    </div>
                  `
              : null}
          </section>
        </section>
      `;
    }

    function renderDraftScreen() {
      return html`
        <section className="screen project-screen">
          ${renderProjectHeader()}
          ${renderNoticeArea()}

          <section className="panel panel-main">
            <div className="panel-head">
              <div className="panel-head-top">
                <div>
                  <div className="eyebrow">Черновик встречи</div>
                  <h2>Проверьте название и спикеров</h2>
                </div>
                <button
                  className="primary-button"
                  onClick=${handleConfirmDraft}
                  disabled=${confirmingDraft}
                >
                  ${confirmingDraft ? "Собираем..." : "Собрать протокол"}
                </button>
              </div>
              ${activeMeeting?.gptContext?.transcriptQuality === "poor" ? html`
                <div className="quality-warning">
                  ⚠️ <b>Низкое качество записи</b> — протокол может быть неточным.
                  ${activeMeeting.gptContext.confidenceNote
                    ? html` <span>${activeMeeting.gptContext.confidenceNote}</span>`
                    : null}
                </div>
              ` : null}
              <p className="panel-copy">
                Если нужно, поправьте подписи. После подтверждения соберём
                итоговый протокол.
              </p>
            </div>

            <label className="field">
              <span>Название встречи</span>
              <input
                value=${draftForm.titleDraft}
                onInput=${(event) =>
                  setDraftForm((current) => ({
                    ...current,
                    titleDraft: event.target.value
                  }))}
              />
            </label>

            <div className="speaker-list">
              ${draftForm.speakerDrafts.map(
                (speaker, index) => html`
                  <label key=${speaker.id || index} className="speaker-item">
                    <div className="speaker-item-header">
                      <span>${speaker.label}</span>
                      ${!speaker.guessedName
                        ? html`<span className="speaker-unidentified">Не удалось определить</span>`
                        : speaker.confidence === "high"
                          ? html`<span className="speaker-confidence speaker-confidence--high">уверен</span>`
                          : speaker.confidence === "medium"
                            ? html`<span className="speaker-confidence speaker-confidence--medium">предположение</span>`
                            : null}
                    </div>
                    <input
                      value=${speaker.guessedName ?? ""}
                      placeholder=${speaker.guessedName ? "Имя или подпись" : "Введите имя вручную"}
                      onInput=${(event) => updateDraftSpeaker(index, event.target.value)}
                    />
                    ${speaker.reasoning && speaker.reasoning !== "fallback"
                      ? html`<span className="speaker-reasoning">${speaker.reasoning}</span>`
                      : null}
                  </label>
                `
              )}
            </div>

            <div className="transcript-box">
              <div className="eyebrow">Фрагмент транскрипта</div>
              ${(activeMeeting?.transcriptSegments ?? []).map(
                (segment, index) => html`
                  <div key=${index} className="transcript-row">
                    <strong>${segment.guessedName || segment.speakerLabel}</strong>
                    <p>${segment.text}</p>
                  </div>
                `
              )}
            </div>

            <div className="button-row">
              <button
                className="primary-button"
                onClick=${handleConfirmDraft}
                disabled=${confirmingDraft}
              >
                ${confirmingDraft ? "Собираем..." : "Собрать протокол"}
              </button>
              <button className="ghost-button" onClick=${openProjectHome}>
                К проекту
              </button>
            </div>
          </section>
        </section>
      `;
    }

    // Цвета для спикеров в расшифровке
    const SPEAKER_COLORS = [
      "#4f6ef7", "#e05c5c", "#2bba8a", "#e09c2b",
      "#9b59b6", "#16a085", "#d35400", "#2980b9"
    ];

    /**
     * Строим карту identity → color прямо из сегментов в порядке первого появления.
     * Не зависит от speakerDrafts — работает и для raw, и для LLM-версии.
     * Один и тот же спикер всегда получает один и тот же цвет внутри набора сегментов.
     */
    function buildSpeakerColorMap(segments) {
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

    function speakerColorFromMap(colorMap, seg) {
      const keys = [seg.guessedName?.trim(), seg.speakerLabel, seg.speakerId].filter(Boolean);
      for (const k of keys) {
        if (colorMap.has(k)) return colorMap.get(k);
      }
      // крайний fallback: хэш чтобы незнакомый спикер не менял цвет между рендерами
      const key = keys[0] ?? "?";
      const hash = [...key].reduce((a, c) => a + c.charCodeAt(0), 0);
      return SPEAKER_COLORS[Math.abs(hash) % SPEAKER_COLORS.length];
    }

    function speakerInitial(label) {
      return (label ?? "?").replace("Спикер ", "С").slice(0, 2).toUpperCase();
    }

    /**
     * Строит карту "Спикер N" → { name, role, dialogueRole, display }.
     *  - name/role берём из speakerDrafts (LLM-идентификация)
     *  - dialogueRole считаем сами по сегментам: кто начал, у кого больше слов и т.п.
     *  - display — что показать: "Имя · роль", иначе "Спикер N · роль-в-диалоге"
     */
    function buildSpeakerInfoMap(speakerDrafts, segments) {
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
    function resolveSpeakerLabel(speakerInfo, seg) {
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

    function formatTimecode(ms) {
      if (ms == null) return null;
      const totalSec = Math.floor(ms / 1000);
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const s = totalSec % 60;
      if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
      return `${m}:${String(s).padStart(2, "0")}`;
    }

    function parseLlmTranscript(correctedText) {
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

    function renderTranscriptSegments(segments, colorMap, speakerInfo) {
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
            return html`
              <div key=${i} className="tf-row">
                ${title ? html`<div className="tf-avatar" style=${{ background: color }}>${initial}</div>` : null}
                <div className="tf-body">
                  <div className="tf-meta">
                    ${title ? html`<div className="tf-name" style=${{ color }}>${title}</div>` : null}
                    ${subtitle ? html`<span className="tf-role">${subtitle}</span>` : null}
                    ${timecode ? html`<span className="tf-timecode">${timecode}</span>` : null}
                  </div>
                  <div className="tf-text">${seg.text}</div>
                </div>
              </div>
            `;
          })}
        </div>
      `;
    }

    function renderTranscriptTab() {
      const rawSegments = activeMeeting?.rawTranscriptSegments ?? activeMeeting?.transcriptSegments ?? [];
      const llmSegments = parseLlmTranscript(activeMeeting?.gptContext?.correctedText);
      const hasLlm = llmSegments.length > 0;
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
          ${transcriptVersion === "llm" && !hasLlm
            ? html`<div className="empty-state">LLM-коррекция ещё не готова.</div>`
            : renderTranscriptSegments(activeSegments, colorMap, speakerInfo)
          }
        </div>
      `;
    }

    function renderSummaryTab(protocol) {

      async function saveSummary() {
        setSavingSummary(true);
        const newProtocol = {
          ...protocol,
          summary: { ...(protocol.summary ?? {}), overview: summaryDraft.overview },
          participants: summaryDraft.participants.map((p) => p.trim()).filter(Boolean),
          decisions: summaryDraft.decisions.map((d) => d.trim()).filter(Boolean),
          actionItems: summaryDraft.actionItems
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
        return html`
          <div className="result-stack summary-edit">
            <section className="result-block">
              <div className="eyebrow">Краткий обзор</div>
              <textarea
                className="summary-textarea"
                rows="4"
                value=${summaryDraft.overview}
                onInput=${(e) => setSummaryDraft((d) => ({ ...d, overview: e.target.value }))}
              ></textarea>
            </section>

            <section className="result-block">
              <div className="eyebrow">Участники</div>
              ${summaryDraft.participants.map((p, i) => html`
                <div key=${i} className="edit-row">
                  <input value=${p} onInput=${(e) => setList("participants", i, e.target.value)} placeholder="Имя участника" />
                  <button className="ghost-button ghost-button--sm" onClick=${() => removeFromList("participants", i)}>✕</button>
                </div>`)}
              <button className="ghost-button ghost-button--sm" onClick=${() => addToList("participants", "")}>+ Добавить участника</button>
            </section>

            <section className="result-block">
              <div className="eyebrow">Что решили</div>
              ${summaryDraft.decisions.map((d, i) => html`
                <div key=${i} className="edit-row">
                  <input value=${d} onInput=${(e) => setList("decisions", i, e.target.value)} placeholder="Решение" />
                  <button className="ghost-button ghost-button--sm" onClick=${() => removeFromList("decisions", i)}>✕</button>
                </div>`)}
              <button className="ghost-button ghost-button--sm" onClick=${() => addToList("decisions", "")}>+ Добавить решение</button>
            </section>

            <section className="result-block">
              <div className="eyebrow">Следующие шаги</div>
              ${summaryDraft.actionItems.map((item, i) => html`
                <div key=${i} className="action-item action-item--editing">
                  <div className="action-edit-grid">
                    <label className="action-edit-field"><span>Ответственный</span>
                      <input value=${item.owner ?? ""} onInput=${(e) => setAction(i, "owner", e.target.value)} placeholder="Имя или роль" /></label>
                    <label className="action-edit-field"><span>Задача</span>
                      <input value=${item.task ?? ""} onInput=${(e) => setAction(i, "task", e.target.value)} placeholder="Описание задачи" /></label>
                    <label className="action-edit-field"><span>Срок</span>
                      <input type="date" value=${item.deadline ?? ""} onInput=${(e) => setAction(i, "deadline", e.target.value || null)} /></label>
                  </div>
                  <div className="action-edit-btns">
                    <button className="ghost-button ghost-button--sm" onClick=${() => removeFromList("actionItems", i)}>Удалить задачу</button>
                  </div>
                </div>`)}
              <button className="ghost-button ghost-button--sm" onClick=${() => addToList("actionItems", { owner: "", task: "", deadline: null })}>+ Добавить задачу</button>
            </section>

            <div className="button-row">
              <button className="primary-button" onClick=${saveSummary} disabled=${savingSummary}>
                ${savingSummary ? "Сохраняем…" : "Сохранить итоги"}
              </button>
              <button className="ghost-button" onClick=${() => setEditingSummary(false)} disabled=${savingSummary}>Отмена</button>
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
                    <div className="highlight-speaker">${h.speaker}</div>
                    <blockquote className="highlight-quote">«${h.quote}»</blockquote>
                  </div>`)}
              </div>
            </section>` : null}
        </div>
      `;
    }

    function renderResultScreen() {
      const protocol = activeMeeting?.protocol;

      function startEditSummary() {
        setSummaryDraft({
          overview: protocol.summary?.overview ?? "",
          participants: [...(protocol.participants ?? [])],
          decisions: [...(protocol.decisions ?? [])],
          actionItems: (protocol.actionItems ?? []).map((a) => ({ ...a }))
        });
        setEditingSummary(true);
      }
      if (!protocol) {
        return html`
          <section className="screen project-screen">
            ${renderProjectHeader()}
            ${renderNoticeArea()}
            <section className="panel">
              <div className="empty-state">Протокол ещё не готов.</div>
            </section>
          </section>
        `;
      }

      return html`
        <section className="screen project-screen">
          ${renderProjectHeader()}
          ${renderNoticeArea()}

          <section className="panel panel-main">
            <div className="panel-head">
              <div>
                <div className="eyebrow">Готовый результат</div>
                <h2>${protocol.summary.title}</h2>
              </div>
              <div className="meeting-meta-line">
                <span>${formatMeetingDate(activeMeeting.date)}</span>
                ${formatMeetingTimeRange(activeMeeting)
                  ? html`<span className="meeting-time-line">${formatMeetingTimeRange(activeMeeting)}</span>`
                  : null}
              </div>
              ${activeMeeting?.gptContext?.transcriptQuality === "poor" ? html`
                <div className="quality-warning">
                  ⚠️ <b>Низкое качество записи</b> — данные могут быть неточными или неполными.
                </div>
              ` : null}
              <p className="panel-copy">${protocol.summary.overview}</p>
            </div>

            <div className="result-tabs">
              <button
                className=${"tab-btn" + (resultTab === "summary" ? " tab-btn--active" : "")}
                onClick=${() => setResultTab("summary")}
              >Итоги</button>
              <button
                className=${"tab-btn" + (resultTab === "transcript" ? " tab-btn--active" : "")}
                onClick=${() => setResultTab("transcript")}
              >Расшифровка</button>
            </div>

            ${resultTab === "summary"
              ? html`<div className="button-row">
                  <button className="primary-button" onClick=${copyProtocol}>Скопировать итоги</button>
                  <button className="ghost-button" onClick=${downloadProtocol}>Скачать TXT</button>
                  <button className="ghost-button" onClick=${openProjectHome}>К проекту</button>
                  ${!editingSummary ? html`<button className="ghost-button ghost-button--sm" onClick=${startEditSummary}>✏️ Редактировать итоги</button>` : null}
                </div>`
              : html`<div className="button-row">
                  <button className="primary-button" onClick=${downloadTranscriptLlm}>Скачать LLM-версию</button>
                  <button className="ghost-button" onClick=${downloadTranscriptRaw}>Скачать исходную</button>
                  <button className="ghost-button" onClick=${openProjectHome}>К проекту</button>
                </div>`}

            ${resultTab === "summary"
              ? renderSummaryTab(protocol)
              : renderTranscriptTab()}
          </section>
        </section>
      `;
    }

    function renderPeopleScreen() {
      return html`
        <section className="screen project-screen">
          ${renderProjectHeader()}
          ${renderNoticeArea()}

          <section className="panel panel-main">
            <div className="row">
              <div>
                <div className="eyebrow">Участники проекта</div>
                <h2>Кого учитывать на встречах</h2>
              </div>
              <button className="ghost-button" onClick=${addTeamMember}>Добавить</button>
            </div>

            <div className="people-list">
              ${teamDraft.map(
                (member, index) => html`
                  <div key=${member.id} className="person-row">
                    <label className="field">
                      <span>Имя</span>
                      <input
                        value=${member.name}
                        onInput=${(event) => updateTeamMember(index, "name", event.target.value)}
                      />
                    </label>
                    <label className="field">
                      <span>Роль</span>
                      <input
                        value=${member.role}
                        onInput=${(event) => updateTeamMember(index, "role", event.target.value)}
                      />
                    </label>
                    <button className="ghost-button" onClick=${() => removeTeamMember(member.id)}>
                      Убрать
                    </button>
                  </div>
                `
              )}
            </div>

            <div className="button-row">
              <button
                className="primary-button"
                onClick=${saveTeam}
                disabled=${savingTeam}
              >
                ${savingTeam ? "Сохраняем..." : "Сохранить"}
              </button>
              <button className="ghost-button" onClick=${openProjectHome}>
                К проекту
              </button>
            </div>
          </section>
        </section>
      `;
    }

    function renderAdminScreen() {
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

          ${renderNoticeArea()}

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

    function renderContent() {
      if (!authChecked) {
        return html`
          <section className="screen">
            <section className="panel">
              <div className="empty-state">Загружаем…</div>
            </section>
          </section>
        `;
      }

      if (!authUser) {
        return html`<${LoginScreen} onAuth=${(user) => setAuthUser(user)} />`;
      }

      if (loading) {
        return html`
          <section className="screen">
            <section className="panel">
              <div className="empty-state">Загружаем данные…</div>
            </section>
          </section>
        `;
      }

      if (currentScreen === "admin") {
        return renderAdminScreen();
      }

      if (currentScreen === "projects-home" || !selectedProject) {
        return renderProjectsScreen();
      }

      if (currentScreen === "project-people") {
        return renderPeopleScreen();
      }

      if (currentScreen === "meeting-processing") {
        return renderProcessingScreen();
      }

      if (currentScreen === "meeting-draft") {
        return renderDraftScreen();
      }

      if (currentScreen === "meeting-result") {
        return renderResultScreen();
      }

      return renderProjectHome();
    }

    return html`<div className="app-shell">${renderContent()}</div>`;
  }

  const root = window.ReactDOM.createRoot(document.getElementById("app"));
  root.render(html`<${App} />`);
})();
