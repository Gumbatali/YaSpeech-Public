export class MockYandexGptGateway {
  constructor({ failAttempts = 0 } = {}) {
    this.remainingFailures = failAttempts;
  }

  async generateDraft({ project, transcript }) {
    const speakerDrafts = transcript.phrases.map((phrase, index) => ({
      id: phrase.speakerId ?? `speaker-${index + 1}`,
      label: phrase.speakerLabel ?? `Спикер ${index + 1}`,
      guessedName: phrase.detectedName ?? null,
      confidence: phrase.detectedName ? "high" : "low"
    }));

    return {
      titleDraft: `${project.name} — статусы и решения`,
      speakerDrafts,
      transcriptPreview: transcript.phrases
        .map((phrase, index) => {
          const speaker = speakerDrafts[index];
          const namePart = speaker?.guessedName ? ` — ${speaker.guessedName}` : "";
          return `${speaker?.label ?? phrase.speakerLabel}${namePart}: ${phrase.text}`;
        })
        .join("\n"),
      transcriptSegments: transcript.phrases.map((phrase, index) => {
        const speaker = speakerDrafts[index];
        return {
          speakerId: speaker?.id ?? phrase.speakerId,
          speakerLabel: speaker?.label ?? phrase.speakerLabel,
          guessedName: speaker?.guessedName ?? null,
          text: phrase.text
        };
      })
    };
  }

  async generateProtocol({ meeting, project, transcript, previousProtocol = null }) {
    if (this.remainingFailures > 0) {
      this.remainingFailures -= 1;
      const error = new Error("YandexGPT temporary error.");
      error.code = "YANDEX_GPT_ERROR";
      throw error;
    }

    const participantNames = (meeting.speakerDrafts ?? [])
      .map((speaker) => speaker.guessedName || speaker.label)
      .filter(Boolean);

    const decisions = [
      "Зафиксировали текущий статус MVP и список ближайших задач.",
      "Согласовали продолжать обработку встреч через SpeechKit с отдельной генерацией протокола через YandexGPT."
    ];

    const actionItemOwners =
      project.team.length > 0
        ? project.team.slice(0, 2).map((member) => member.name)
        : ["Ответственный 1", "Ответственный 2"];

    const actionItems = actionItemOwners.map((owner, index) => ({
      owner,
      task: index === 0
        ? "Подготовить описание пайплайна и статусов обработки."
        : "Проверить сценарий загрузки аудио и экран истории встреч.",
      deadline: index === 0 ? "2026-05-12" : "2026-05-13"
    }));

    // Сверка с предыдущим протоколом: делим задачи на выполненные и перенесённые
    let completedFromPrevious = [];
    let carriedForward = [];

    if (previousProtocol?.actionItems?.length) {
      const prevItems = previousProtocol.actionItems;
      const half = Math.ceil(prevItems.length / 2);
      completedFromPrevious = prevItems.slice(0, half).map((item) => ({
        ...item,
        completedAt: meeting.date
      }));
      carriedForward = prevItems.slice(half);
    }

    const protocol = {
      summary: {
        title: meeting.titleDraft || `${project.name} — статусы и решения`,
        overview: `Встреча от ${meeting.date} по проекту ${project.name}. Обсуждены статусы, структура интерфейса и следующий шаг по протоколу встречи.`
      },
      participants: participantNames,
      guests: meeting.guests.map((guest) => guest.name),
      decisions,
      actionItems,
      completedFromPrevious,
      carriedForward,
      transcriptHighlights: transcript.phrases.map((phrase, index) => ({
        speaker:
          meeting.speakerDrafts?.[index]?.guessedName ||
          meeting.speakerDrafts?.[index]?.label ||
          phrase.speakerLabel ||
          phrase.speakerTag,
        quote: phrase.text
      }))
    };

    const protocolTextParts = [
      "Протокол встречи",
      "",
      `Проект: ${project.name}`,
      `Название встречи: ${protocol.summary.title}`,
      `Дата: ${meeting.date}`,
      `Участники: ${participantNames.join(", ")}`,
      meeting.guests.length > 0
        ? `Гости: ${meeting.guests.map((guest) => guest.name).join(", ")}`
        : "Гости: нет",
      "",
      "Краткая сводка:",
      protocol.summary.overview,
      "",
      "Решения:",
      ...decisions.map((decision, index) => `${index + 1}. ${decision}`),
      "",
      "Новые задачи:",
      ...actionItems.map(
        (item, index) =>
          `${index + 1}. ${item.owner} — ${item.task} (до ${item.deadline})`
      )
    ];

    if (completedFromPrevious.length > 0) {
      protocolTextParts.push(
        "",
        "Выполнено с прошлой встречи:",
        ...completedFromPrevious.map(
          (item, index) => `${index + 1}. ✓ ${item.owner} — ${item.task}`
        )
      );
    }

    if (carriedForward.length > 0) {
      protocolTextParts.push(
        "",
        "Перенесено на следующую встречу:",
        ...carriedForward.map(
          (item, index) =>
            `${index + 1}. ${item.owner} — ${item.task} (до ${item.deadline})`
        )
      );
    }

    protocolTextParts.push(
      "",
      "Транскрипт по спикерам:",
      ...transcript.phrases.map((phrase, index) => {
        const speaker =
          meeting.speakerDrafts?.[index]?.guessedName ||
          meeting.speakerDrafts?.[index]?.label ||
          phrase.speakerLabel ||
          phrase.speakerTag;
        return `- ${speaker}: ${phrase.text}`;
      })
    );

    return {
      protocol,
      protocolText: protocolTextParts.join("\n")
    };
  }
}
