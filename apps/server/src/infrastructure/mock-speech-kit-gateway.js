export class MockSpeechKitGateway {
  /**
   * Стартует «фиктивное» распознавание. Сразу возвращает mock operationId.
   * audioKey (параллельный ASR чанков) включается в operationId — иначе все
   * чанки одной встречи получили бы одинаковый ID и слились бы неотличимо.
   */
  async startRecognition({ meeting, audioKey }) {
    const suffix = audioKey ? `:${audioKey}` : "";
    return { operationId: `mock-op-${meeting.id}${suffix}` };
  }

  /**
   * Mock-поллинг: всегда возвращает done: true с полным транскриптом.
   * project опционален — передаётся из pipeline для генерации реалистичных спикеров.
   */
  async pollRecognitionOnce({ meeting, project = null, operationId }) {
    const p = project ?? { team: [], name: "mock" };
    const { transcript } = await this.processMeeting({ meeting, project: p });
    return { done: true, jobId: operationId ?? `job-${meeting.id}`, transcript };
  }

  async processMeeting({ meeting, project }) {
    const scopedTeam = project.team.filter((member) =>
      meeting.participantIds.includes(member.id)
    );
    const knownSpeakers = (scopedTeam.length > 0 ? scopedTeam : project.team).slice(0, 3);
    const speakers =
      knownSpeakers.length > 0
        ? knownSpeakers
        : [
            { name: "Участник проекта" },
            { name: "Коллега по встрече" }
          ];
    const jobId = `job-${meeting.id}`;
    // Реплики намеренно длинные: pipeline отбраковывает транскрипты короче
    // 20 слов как «плохое распознавание», поэтому даже один спикер должен дать
    // достаточно текста для прохождения этого порога.
    const fallbackPhrases = [
      `обсуждает текущий статус проекта ${project.name}, рассказывает про ход работ по MVP, отмечает выполненные задачи прошлой недели и предлагает обсудить приоритеты на ближайший спринт.`,
      "предлагает упростить интерфейс загрузки, оставить запись встречи на главном экране, убрать лишние шаги из формы и согласовать финальный макет с командой дизайна до конца недели.",
      "фиксирует ключевые решения по протоколу встречи, распределяет следующие задачи между участниками команды, назначает ответственных и договаривается о сроках сдачи по каждому пункту."
    ];

    const phrases = speakers.map((speaker, index) => ({
      speakerId: `speaker-${index + 1}`,
      speakerLabel: `Спикер ${index + 1}`,
      speakerTag: `Спикер ${index + 1}`,
      detectedName: speaker.name,
      startTimeMs: index * 45_000,
      endTimeMs: index * 45_000 + 30_000,
      text: `${speaker.name} ${fallbackPhrases[index] ?? fallbackPhrases.at(-1)}`
    }));

    if (meeting.guests.length > 0 && phrases.length < 4) {
      const guest = meeting.guests[0];
      phrases.push({
        speakerId: `speaker-${phrases.length + 1}`,
        speakerLabel: `Спикер ${phrases.length + 1}`,
        speakerTag: `Спикер ${phrases.length + 1}`,
        detectedName: guest.name,
        startTimeMs: 135_000,
        endTimeMs: 165_000,
        text: `${guest.name} подтверждает экспертные замечания и предлагает не усложнять MVP.`
      });
    }

    return {
      jobId,
      transcript: {
        jobId,
        meetingId: meeting.id,
        rawText: phrases
          .map((phrase) => `${phrase.speakerLabel}: ${phrase.text}`)
          .join("\n"),
        phrases,
        generatedAt: new Date().toISOString()
      }
    };
  }
}
