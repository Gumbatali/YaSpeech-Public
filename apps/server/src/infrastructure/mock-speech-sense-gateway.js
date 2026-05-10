export class MockSpeechSenseGateway {
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
    const talkId = `talk-${meeting.id}`;
    const fallbackPhrases = [
      `обсуждает текущий статус проекта ${project.name} и ход MVP.`,
      "предлагает упростить интерфейс и оставить загрузку записи на главном экране.",
      "фиксирует решения по протоколу встречи и следующим задачам команды."
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
      talkId,
      transcript: {
        talkId,
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
