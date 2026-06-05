export const TIMELINE_STEPS = [
  { key: "uploaded", title: "Запись загружена" },
  { key: "speechkit_processing", title: "Готовим текст встречи" },
  { key: "draft_ready", title: "Черновик готов" },
  { key: "protocol_generating", title: "Собираем итоговый протокол" },
  { key: "done", title: "Протокол готов" }
];

const STEP_ORDER = TIMELINE_STEPS.map((step) => step.key);

export function resolveScreen({ selectedProjectId, activeMeeting, requestedScreen }) {
  // Админка не зависит от выбранного проекта — проверяем первой
  if (requestedScreen === "admin") {
    return "admin";
  }

  if (!selectedProjectId || requestedScreen === "projects-home") {
    return "projects-home";
  }

  if (requestedScreen === "project-people") {
    return "project-people";
  }

  if (!activeMeeting) {
    return "project-workspace";
  }

  if (activeMeeting.status === "done") {
    return "meeting-result";
  }

  if (activeMeeting.status === "draft_ready") {
    return "meeting-draft";
  }

  if (
    ["uploaded", "speechkit_processing", "protocol_generating", "failed"].includes(
      activeMeeting.status
    )
  ) {
    return "meeting-processing";
  }

  return "project-workspace";
}

export function getStageViewModel(meeting) {
  if (!meeting) {
    return {
      tone: "neutral",
      title: "Выберите проект слева",
      detail: "После выбора проекта можно сразу загрузить запись встречи."
    };
  }

  if (meeting.status === "failed") {
    return {
      tone: "error",
      title: "Нужна повторная попытка",
      detail: meeting.error?.message ?? "Во время обработки что-то пошло не так."
    };
  }

  if (meeting.status === "done") {
    return {
      tone: "success",
      title: "Протокол готов",
      detail: "Результат уже можно открыть, скопировать или скачать."
    };
  }

  if (meeting.status === "protocol_generating") {
    return {
      tone: "working",
      title: "Собираем итоговый протокол",
      detail: "Сводим резюме, решения и задачи в один понятный документ."
    };
  }

  if (meeting.status === "draft_ready") {
    return {
      tone: "success",
      title: "Черновик готов",
      detail: "Проверьте название встречи и участников перед финальной сборкой."
    };
  }

  if (meeting.status === "speechkit_processing") {
    return {
      tone: "working",
      title: "Готовим текст встречи",
      detail: "Система слушает запись и собирает речь участников."
    };
  }

  if (meeting.status === "uploading") {
    return {
      tone: "working",
      title: "Загружаем файл…",
      detail: "Отправляем запись на сервер, это займёт несколько секунд."
    };
  }

  if (meeting.status === "uploaded") {
    return {
      tone: "working",
      title: "Запись загружена",
      detail: "Поставили встречу в очередь и начинаем обработку."
    };
  }

  return {
    tone: "working",
    title: "Загрузите запись",
    detail: "Система сама подготовит черновик встречи и потом соберёт протокол."
  };
}

export function getMeetingStatusLabel(meeting) {
  return getStageViewModel(meeting).title;
}

function getCurrentStepKey(meeting) {
  if (!meeting) {
    return "uploaded";
  }

  if (meeting.status === "failed") {
    return meeting.currentStage ?? "speechkit_processing";
  }

  if (meeting.status === "uploading") {
    return "uploaded";
  }

  return meeting.currentStage ?? meeting.status ?? "uploaded";
}

export function getTimelineStepState(stepKey, meeting) {
  const currentStepKey = getCurrentStepKey(meeting);
  const currentIndex = STEP_ORDER.indexOf(currentStepKey);
  const stepIndex = STEP_ORDER.indexOf(stepKey);

  if (currentIndex === -1 || stepIndex === -1) {
    return "upcoming";
  }

  if (meeting?.status === "done") {
    return "done";
  }

  if (stepIndex < currentIndex) {
    return "done";
  }

  if (stepIndex === currentIndex) {
    return "current";
  }

  return "upcoming";
}
