export class MockAiStudioGateway {
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

  async generateProtocol({ meeting, project, transcript }) {
    if (this.remainingFailures > 0) {
      this.remainingFailures -= 1;
      const error = new Error("AI Studio temporary error.");
      error.code = "AI_STUDIO_ERROR";
      throw error;
    }

    const participantNames = (meeting.speakerDrafts ?? [])
      .map((speaker) => speaker.guessedName || speaker.label)
      .filter(Boolean);

    const decisions = [
      "Зафиксировали текущий статус MVP и список ближайших задач.",
      "Согласовали продолжать обработку встреч через SpeechSense с отдельной генерацией протокола."
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

    const protocol = {
      summary: {
        title: meeting.titleDraft || `${project.name} — статусы и решения`,
        overview: `Встреча от ${meeting.date} по проекту ${project.name}. Обсуждены статусы, структура интерфейса и следующий шаг по протоколу встречи.`
      },
      participants: participantNames,
      guests: meeting.guests.map((guest) => guest.name),
      decisions,
      actionItems,
      transcriptHighlights: transcript.phrases.map((phrase, index) => ({
        speaker:
          meeting.speakerDrafts?.[index]?.guessedName ||
          meeting.speakerDrafts?.[index]?.label ||
          phrase.speakerLabel ||
          phrase.speakerTag,
        quote: phrase.text
      }))
    };

    const protocolText = [
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
      "Задачи:",
      ...actionItems.map(
        (item, index) =>
          `${index + 1}. ${item.owner} — ${item.task} (до ${item.deadline})`
      ),
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
    ].join("\n");

    return {
      protocol,
      protocolText
    };
  }
}
