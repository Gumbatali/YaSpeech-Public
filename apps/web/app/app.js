import {
  TIMELINE_STEPS,
  getMeetingStatusLabel,
  getStageViewModel,
  getTimelineStepState,
  resolveScreen
} from "./ui-model.js";

(function bootstrapApp() {
  const { useEffect, useState } = window.React;
  const html = window.htm.bind(window.React.createElement);

  class ApiClient {
    async json(pathname, init = {}) {
      const response = await fetch(pathname, {
        ...init,
        headers: {
          "content-type": "application/json",
          ...(window.__API_KEY__ ? { "x-api-key": window.__API_KEY__ } : {}),
          ...(init.headers ?? {})
        }
      });

      if (!response.ok) {
        let message = "Не удалось выполнить запрос.";
        try {
          const body = await response.json();
          message = body.error?.message ?? message;
        } catch {}
        throw new Error(message);
      }

      return response.json();
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

    uploadFile(upload, file) {
      return fetch(upload.uploadUrl, {
        method: upload.method,
        headers: {
          "content-type": file.type || "application/octet-stream"
        },
        body: file
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
  }

  const api = new ApiClient();

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
    const t = nowHHMM();
    return { date: todayIso(), startTime: t, endTime: t, durationSeconds: null, file: null };
  }

  function createDraftForm(meeting = null) {
    return {
      titleDraft: meeting?.titleDraft ?? "",
      speakerDrafts: (meeting?.speakerDrafts ?? []).map((speaker) => ({ ...speaker }))
    };
  }

  function App() {
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
    const [savingTeam, setSavingTeam] = useState(false);
    const [confirmingDraft, setConfirmingDraft] = useState(false);
    const [showProjectComposer, setShowProjectComposer] = useState(false);
    const [recording, setRecording] = useState(false);
    const [recordingSeconds, setRecordingSeconds] = useState(0);
    const recorderRef = React.useRef(null);
    const timerRef = React.useRef(null);
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

    useEffect(() => {
      void bootstrap();
    }, []);

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
        setNotice("Проект создан.");
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
        setNotice("Участники проекта сохранены.");
        await refreshProjects({ selectProjectId: selectedProjectId });
      } catch (caughtError) {
        setError(caughtError.message);
      } finally {
        setSavingTeam(false);
      }
    }

    async function startRecording() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/mp4";
        const recorder = new MediaRecorder(stream, { mimeType });
        const chunks = [];

        recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
        recorder.onstop = () => {
          stream.getTracks().forEach((t) => t.stop());
          clearInterval(timerRef.current);
          const blob = new Blob(chunks, { type: mimeType });
          const ext = mimeType.includes("webm") ? "webm" : "mp4";
          const recNow = new Date();
          const name = "запись_" + recNow.toISOString().slice(0, 16).replace("T", "_").replace(":", "-") + "." + ext;
          const file = new File([blob], name, { type: mimeType });
          setRecording(false);
          setRecordingSeconds(0);
          void handleFileSelect(file);
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
      setMeetingForm((current) => ({ ...current, file, durationSeconds: null }));
      const dur = await getAudioDuration(file);
      const endTime = nowHHMM();
      const startTime = dur ? subtractSecondsHHMM(endTime, dur) : endTime;
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
        setError("Сначала выберите файл.");
        return;
      }

      const ALLOWED_TYPES = [
        "audio/mpeg", "audio/mp3", "audio/mp4", "audio/m4a",
        "audio/x-m4a", "audio/wav", "audio/wave", "audio/ogg",
        "audio/webm", "audio/aac", "audio/flac", "audio/x-flac"
      ];
      const MAX_SIZE_BYTES = 1 * 1024 * 1024 * 1024; // 1 GB

      const fileType = meetingForm.file.type || "";
      const fileName = meetingForm.file.name || "";
      const AUDIO_EXT = /\.(mp3|m4a|mp4|wav|ogg|webm|aac|flac|opus)$/i;

      if (!ALLOWED_TYPES.includes(fileType) && !AUDIO_EXT.test(fileName)) {
        setError("Неподдерживаемый формат. Загрузите аудиофайл: MP3, M4A, WAV, OGG, FLAC, AAC.");
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

        const durationSeconds = meetingForm.durationSeconds ?? await getAudioDuration(meetingForm.file);
        await api.uploadFile(payload.upload, meetingForm.file);
        const uploaded = await api.completeUpload(
          payload.meeting.id,
          meetingForm.file.size,
          durationSeconds
        );
        setActiveMeeting(uploaded.meeting);
        setNotice("Запись загружена.");
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
        setNotice("Черновик подтверждён.");
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
        setNotice("Повторная обработка запущена.");
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
        setNotice("Протокол скопирован.");
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

    function renderNoticeArea() {
      return html`
        ${notice ? html`<div className="banner banner-ok">${notice}</div>` : null}
        ${error ? html`<div className="banner banner-error">${error}</div>` : null}
      `;
    }

    function renderProjectsScreen() {
      return html`
        <section className="screen projects-screen">
          <header className="screen-header">
            <div className="brand-mark">YaSpeech</div>
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
                  <button
                    key=${project.id}
                    className="project-card"
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
              if (n === 0) return "Добавить участников";
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
                <div className="time-range-edit">
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
                </div>
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
                  accept="audio/*,.mp3,.m4a,.wav,.ogg,.webm,.aac,.flac"
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
              <strong>${meetingForm.file ? meetingForm.file.name : "Файл пока не выбран"}</strong>
              <span>
                ${meetingForm.file
                  ? (meetingForm.file.size / (1024 * 1024)).toFixed(1) + " МБ · готов к загрузке"
                  : "MP3, M4A, WAV, OGG, FLAC, AAC · максимум 1 ГБ"}
              </span>
            </div>
          </div>

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
                <button
                  key=${meeting.id}
                  className="meeting-row"
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
              ? html`
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
              <div>
                <div className="eyebrow">Черновик встречи</div>
                <h2>Проверьте название и спикеров</h2>
              </div>
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
                    <span>${speaker.label}</span>
                    <input
                      value=${speaker.guessedName ?? ""}
                      placeholder="Имя или подпись"
                      onInput=${(event) => updateDraftSpeaker(index, event.target.value)}
                    />
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

    function renderResultScreen() {
      const protocol = activeMeeting?.protocol;
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
              <p className="panel-copy">${protocol.summary.overview}</p>
            </div>

            <div className="button-row">
              <button className="primary-button" onClick=${copyProtocol}>Скопировать</button>
              <button className="ghost-button" onClick=${downloadProtocol}>Скачать TXT</button>
              <button className="ghost-button" onClick=${openProjectHome}>К проекту</button>
            </div>

            <div className="result-stack">
              <section className="result-block">
                <div className="eyebrow">Участники</div>
                <ul>
                  ${protocol.participants.map(
                    (participant, index) => html`<li key=${index}>${participant}</li>`
                  )}
                </ul>
              </section>

              <section className="result-block">
                <div className="eyebrow">Что решили</div>
                <ol>
                  ${protocol.decisions.map(
                    (decision, index) => html`<li key=${index}>${decision}</li>`
                  )}
                </ol>
              </section>

              <section className="result-block">
                <div className="eyebrow">Следующие шаги</div>
                <ul>
                  ${protocol.actionItems.map(
                    (item, index) => html`
                      <li key=${index}>
                        <strong>${item.owner}</strong>: ${item.task} до ${item.deadline}
                      </li>
                    `
                  )}
                </ul>
              </section>

              <section className="result-block">
                <div className="eyebrow">Транскрипт по спикерам</div>
                <ul>
                  ${protocol.transcriptHighlights.map(
                    (highlight, index) => html`
                      <li key=${index}>
                        <strong>${highlight.speaker}</strong>: ${highlight.quote}
                      </li>
                    `
                  )}
                </ul>
              </section>
            </div>
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

    function renderContent() {
      if (loading) {
        return html`
          <section className="screen">
            <section className="panel">
              <div className="empty-state">Загружаем данные…</div>
            </section>
          </section>
        `;
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
