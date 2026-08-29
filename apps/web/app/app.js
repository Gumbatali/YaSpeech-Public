import {
  TIMELINE_STEPS,
  getMeetingStatusLabel,
  getStageViewModel,
  getTimelineStepState,
  resolveScreen
} from "./ui-model.js?v=__BUILD__";
import { preprocessAudio } from "./audio/preprocessor.js?v=__BUILD__";
import { analyzeAudioQuality, describeQuality } from "./audio/quality-analyzer.js?v=__BUILD__";
import { html, useEffect, useState, React } from "./html.js?v=__BUILD__";
import { ApiClient } from "./api.js?v=__BUILD__";
import {
  todayIso,
  isoDateFromTimestamp,
  formatMeetingDate,
  nowHHMM,
  subtractSecondsHHMM,
  formatMeetingTimeRange,
  formatRecordingTime,
  getAudioDuration
} from "./format.js?v=__BUILD__";
import { parseLlmTranscript } from "./transcript-model.js?v=__BUILD__";
import { copyText } from "./clipboard.js?v=__BUILD__";
import { LoginScreen } from "./screens/login-screen.js?v=__BUILD__";
import { AdminScreen } from "./screens/admin-screen.js?v=__BUILD__";
import { SummaryTab } from "./screens/summary-tab.js?v=__BUILD__";
import { TranscriptTab, RefineControl } from "./screens/transcript-tab.js?v=__BUILD__";

(function bootstrapApp() {

  // api инициализируется позже, после определения App (нужен onUnauthorized)
  let api;

  function createProjectForm() {
    return { name: "" };
  }

  function createMeetingForm() {
    return { date: todayIso(), startTime: null, endTime: null, durationSeconds: null, file: null };
  }

  // Уведомление о готовности встречи — localStorage, а не state: должно
  // пережить перезагрузку страницы, пока пользователь ждёт обработку.
  function isNotifyEnabled(meetingId) {
    try {
      return localStorage.getItem(`notify:${meetingId}`) === "1";
    } catch {
      return false;
    }
  }

  function setNotifyEnabled(meetingId, on) {
    try {
      if (on) localStorage.setItem(`notify:${meetingId}`, "1");
      else localStorage.removeItem(`notify:${meetingId}`);
    } catch {
      // localStorage недоступен (приватный режим и т.п.) — тихо пропускаем
    }
  }

  async function requestNotifyPermission() {
    if (typeof Notification === "undefined") return false;
    if (Notification.permission === "granted") return true;
    if (Notification.permission === "denied") return false;
    const result = await Notification.requestPermission();
    return result === "granted";
  }

  function fireDoneNotification(meeting) {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    try {
      new Notification("Протокол готов", {
        body: meeting.titleDraft || "Встреча обработана"
      });
    } catch {
      // конструктор Notification может бросить в некоторых окружениях — не критично
    }
  }

  function createDraftForm(meeting = null) {
    return {
      titleDraft: meeting?.titleDraft ?? "",
      speakerDrafts: (meeting?.speakerDrafts ?? []).map((speaker) => ({ ...speaker }))
    };
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
      // Пока идёт ИИ-улучшение, форму не трогаем — иначе сотрём ввод пользователя.
      // По завершении (done) пересобираем: подтянутся имена спикеров и заголовок.
      const refineStatus = activeMeeting.llmRefine?.status;
      if (refineStatus === "queued" || refineStatus === "processing") {
        return;
      }

      setDraftForm(createDraftForm(activeMeeting));
    }, [activeMeeting?.id, activeMeeting?.status, activeMeeting?.llmRefine?.status]);

    useEffect(() => {
      const refineActive = ["queued", "processing"].includes(
        activeMeeting?.llmRefine?.status
      );
      if (
        !activeMeeting ||
        (!["uploaded", "speechkit_processing", "diarizing", "protocol_generating"].includes(
          activeMeeting.status
        ) && !refineActive)
      ) {
        return;
      }

      const timer = setInterval(() => {
        void refreshMeeting(activeMeeting.id, true);
      }, 1500);

      return () => clearInterval(timer);
    }, [activeMeeting?.id, activeMeeting?.status, activeMeeting?.llmRefine?.status]);

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
        const previousStatus = activeMeeting?.id === meetingId ? activeMeeting.status : null;
        setActiveMeeting(payload.meeting);
        if (
          previousStatus && previousStatus !== "done" &&
          payload.meeting.status === "done" && isNotifyEnabled(meetingId)
        ) {
          fireDoneNotification(payload.meeting);
          setNotifyEnabled(meetingId, false);
        }
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
      // Дата встречи по умолчанию — todayIso() (дата открытия формы), не дата
      // самой встречи. Для не самой свежей записи это ломает относительные
      // дедлайны в протоколе ("до завтра" считается от даты загрузки, а не
      // от даты встречи). lastModified у выбранного файла — не дата записи
      // звука, а дата последнего изменения файла на диске, но обычно куда
      // ближе к реальной дате встречи, чем "сегодня" — берём его как лучший
      // доступный дефолт, только если поле даты ещё не тронуто пользователем.
      // Важно: берём lastModified ДО preprocessAudio ниже — он пересобирает
      // file в новый Blob/File, который эту метадату не сохраняет.
      const originalLastModified = file?.lastModified;

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
      const fileDate = originalLastModified ? isoDateFromTimestamp(originalLastModified) : null;
      if (fileDate && fileDate !== todayIso()) {
        showNotice(`Дата встречи выставлена по дате файла: ${formatMeetingDate(fileDate)}. Поправьте, если неверно.`, 6000);
      }
      setMeetingForm((current) => ({
        ...current,
        file,
        durationSeconds: dur,
        startTime,
        endTime,
        // Не перетираем дату, если пользователь уже сам её поправил.
        date: fileDate && current.date === todayIso() ? fileDate : current.date
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
        setEditingTranscript(false);
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
        await copyText(protocolText);
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

    function renderNotifyToggle(meetingId) {
      const enabled = isNotifyEnabled(meetingId);

      async function handleToggle(event) {
        const wantOn = event.target.checked;
        if (wantOn) {
          const granted = await requestNotifyPermission();
          if (!granted) {
            setError("Уведомления заблокированы в браузере — разрешите их в настройках сайта.");
            return;
          }
        }
        setNotifyEnabled(meetingId, wantOn);
        // notify-состояние живёт в localStorage, не в useState — форсируем
        // перерисовку, чтобы чекбокс сразу отразил новое значение
        setActiveMeeting((m) => (m ? { ...m } : m));
      }

      return html`
        <label className="refine-control">
          <input type="checkbox" checked=${enabled} onChange=${handleToggle} />
          <span>🔔 Уведомить, когда будет готово</span>
        </label>
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
              ${activeMeeting && activeMeeting.status !== "failed"
                ? renderNotifyToggle(activeMeeting.id)
                : null}
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
      // Лучшая доступная версия: после «Улучшить с ИИ» показываем её,
      // правки и протокол тоже идут по ней
      const draftSegments = (activeMeeting?.llmTranscriptSegments?.length
        ? activeMeeting.llmTranscriptSegments
        : activeMeeting?.transcriptSegments) ?? [];
      const refineBusy = ["queued", "processing"].includes(
        activeMeeting?.llmRefine?.status
      );

      function startDraftTranscriptEdit() {
        setTranscriptEditText(
          draftSegments
            .map((s) => {
              const label = s.guessedName || s.speakerLabel || "";
              return label ? `${label}: ${s.text}` : s.text;
            })
            .join("\n")
        );
        setEditingTranscript(true);
      }

      async function saveDraftTranscript() {
        if (!transcriptEditText.trim()) return;
        setSavingTranscript(true);
        try {
          const res = await api.patchTranscript(activeMeeting.id, transcriptEditText);
          if (res?.meeting) setActiveMeeting(res.meeting);
          setEditingTranscript(false);
          setNotice("Расшифровка сохранена. Можно улучшить с помощью ИИ или сразу собрать протокол.");
        } catch (e) {
          setError("Не удалось сохранить расшифровку: " + (e.message ?? e));
        } finally {
          setSavingTranscript(false);
        }
      }

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
                  disabled=${confirmingDraft || activeMeeting?.status === "protocol_generating"}
                >
                  ${confirmingDraft || activeMeeting?.status === "protocol_generating" ? "Собираем..." : "Собрать протокол"}
                </button>
              </div>
              ${activeMeeting?.status === "protocol_generating" ? html`
                <div className="quality-warning" style=${{ background: "var(--accent-soft, #eef2ff)" }}>
                  ⏳ ${stageView.title} — ${stageView.detail}
                </div>
                ${renderNotifyToggle(activeMeeting.id)}
              ` : null}
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
              ${RefineControl({
                api,
                activeMeeting,
                setActiveMeeting,
                setError
              })}
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
                    ${(() => {
                      // Подсказки из ростера проекта — не печатать заново имя,
                      // которое уже есть в участниках; исключаем тех, кто уже
                      // назначен на ДРУГУЮ метку, чтобы не тыкнуть по ошибке
                      // одного человека на двух спикеров.
                      const quickpick = teamDraft.filter((member) =>
                        !draftForm.speakerDrafts.some((s, i) => i !== index && s.guessedName === member.name)
                      );
                      return quickpick.length > 0
                        ? html`
                            <div className="refine-control">
                              ${quickpick.map((member) => html`
                                <button
                                  key=${member.id}
                                  type="button"
                                  className="ghost-button ghost-button--sm"
                                  onClick=${(event) => {
                                    event.preventDefault();
                                    updateDraftSpeaker(index, member.name);
                                  }}
                                >${member.name}</button>
                              `)}
                            </div>
                          `
                        : null;
                    })()}
                  </label>
                `
              )}
            </div>

            <div className="transcript-box">
              <div className="transcript-box-head">
                <div className="eyebrow">
                  ${activeMeeting?.llmTranscriptSegments?.length
                    ? "Транскрипт (улучшен ИИ)"
                    : "Фрагмент транскрипта"}
                </div>
                ${!editingTranscript && !refineBusy
                  ? html`
                      <button
                        className="ghost-button ghost-button--sm"
                        onClick=${startDraftTranscriptEdit}
                        title="Исправьте текст — ИИ и протокол будут работать с вашей версией"
                      >✏️ Редактировать</button>
                    `
                  : null}
              </div>
              ${editingTranscript
                ? html`
                    <p className="transcript-edit-hint">
                      Формат строки: <code>Имя спикера: текст реплики</code>.
                      Сохранённые правки учтёт и «Улучшить с помощью ИИ», и сборка протокола.
                    </p>
                    <textarea
                      className="transcript-editor"
                      value=${transcriptEditText}
                      onInput=${(e) => setTranscriptEditText(e.target.value)}
                      rows="14"
                      spellcheck="false"
                    ></textarea>
                    <div className="button-row">
                      <button
                        className="primary-button"
                        onClick=${saveDraftTranscript}
                        disabled=${savingTranscript}
                      >${savingTranscript ? "Сохраняем…" : "Сохранить"}</button>
                      <button
                        className="ghost-button"
                        onClick=${() => setEditingTranscript(false)}
                        disabled=${savingTranscript}
                      >Отмена</button>
                    </div>
                  `
                : draftSegments.map(
                    (segment, index) => html`
                      <div key=${index} className="transcript-row">
                        <strong>
                          ${segment.guessedName || segment.speakerLabel}
                          ${segment.refined ? html` <span className="tf-refined-badge" title="Исправлено ИИ">✨</span>` : null}
                        </strong>
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
                </div>`
              : html`<div className="button-row">
                  <button className="primary-button" onClick=${downloadTranscriptLlm}>Скачать LLM-версию</button>
                  <button className="ghost-button" onClick=${downloadTranscriptRaw}>Скачать исходную</button>
                  <button className="ghost-button" onClick=${openProjectHome}>К проекту</button>
                </div>`}

            ${resultTab === "summary"
              ? SummaryTab({
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
                  onStartEdit: startEditSummary
                })
              : TranscriptTab({
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
                })}
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
      return AdminScreen({
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
        noticeArea: renderNoticeArea()
      });
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
        return html`<${LoginScreen} api=${api} onAuth=${(user) => setAuthUser(user)} />`;
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
