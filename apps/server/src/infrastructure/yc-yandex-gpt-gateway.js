import { getIamToken } from "../shared/iam-token.js";

const GPT_URL = "https://llm.api.cloud.yandex.net/foundationModels/v1/completion";
const MAX_TRANSCRIPT_CHARS = 24_000; // ~8k токенов, оставляем место для промпта

export class YcYandexGptGateway {
  constructor({ folderId }) {
    this.folderId = folderId;
    this.modelUri = `gpt://${folderId}/yandexgpt-pro/latest`;
  }

  async complete(systemPrompt, userPrompt, temperature = 0.3) {
    const iamToken = await getIamToken();

    const res = await fetch(GPT_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${iamToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        modelUri: this.modelUri,
        completionOptions: {
          stream: false,
          temperature,
          maxTokens: 4000
        },
        messages: [
          { role: "system", text: systemPrompt },
          { role: "user", text: userPrompt }
        ]
      })
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`YandexGPT failed ${res.status}: ${text}`);
    }

    const data = await res.json();
    const raw = data.result?.alternatives?.[0]?.message?.text ?? "";

    // Убираем markdown-обёртку если GPT завернул ответ в ```json ... ```
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    return cleaned;
  }

  async generateDraft({ project, transcript }) {
    const teamList = project.team?.length
      ? project.team.map((m) => `- ${m.name}${m.role ? ` (${m.role})` : ""}`).join("\n")
      : "Список участников не задан";

    const transcriptText = transcript.rawText.slice(0, MAX_TRANSCRIPT_CHARS);

    const systemPrompt = `Ты — ассистент для анализа транскриптов деловых встреч на русском языке.
Отвечай ТОЛЬКО корректным JSON без пояснений и без markdown-обёртки.`;

    const userPrompt = `Транскрипт встречи:
${transcriptText}

Список участников проекта "${project.name}":
${teamList}

Верни JSON строго в таком формате:
{
  "titleDraft": "Краткое название встречи (5-8 слов)",
  "speakerDrafts": [
    {
      "id": "speaker-1",
      "label": "Спикер 1",
      "guessedName": "Имя из списка участников если угадал, иначе null"
    }
  ]
}

Уникальные id спикеров из транскрипта: ${[...new Set(transcript.phrases.map((p) => p.speakerId))].join(", ")}`;

    let result;
    try {
      const raw = await this.complete(systemPrompt, userPrompt);
      result = JSON.parse(raw);
    } catch (e) {
      // Fallback: базовый черновик
      const speakerIds = [...new Set(transcript.phrases.map((p) => p.speakerId))];
      return {
        titleDraft: `${project.name} — встреча`,
        speakerDrafts: speakerIds.map((id, i) => ({
          id,
          label: `Спикер ${i + 1}`,
          guessedName: null,
          confidence: "low"
        })),
        transcriptPreview: transcript.rawText.slice(0, 2000),
        transcriptSegments: transcript.phrases.map((p) => ({
          speakerId: p.speakerId,
          speakerLabel: p.speakerLabel,
          guessedName: null,
          text: p.text
        }))
      };
    }

    const speakerDrafts = (result.speakerDrafts ?? []).map((s) => ({
      ...s,
      confidence: s.guessedName ? "high" : "low"
    }));

    return {
      titleDraft: result.titleDraft ?? `${project.name} — встреча`,
      speakerDrafts,
      transcriptPreview: transcript.rawText.slice(0, 2000),
      transcriptSegments: transcript.phrases.map((p, i) => {
        const draft = speakerDrafts.find((s) => s.id === p.speakerId);
        return {
          speakerId: p.speakerId,
          speakerLabel: p.speakerLabel,
          guessedName: draft?.guessedName ?? null,
          text: p.text
        };
      })
    };
  }

  async generateProtocol({ meeting, project, transcript, previousProtocol = null }) {
    const participants = (meeting.speakerDrafts ?? [])
      .map((s) => s.guessedName || s.label)
      .filter(Boolean);

    const transcriptText = transcript.rawText.slice(0, MAX_TRANSCRIPT_CHARS);

    const prevSection = previousProtocol?.actionItems?.length
      ? `\nЗадачи с предыдущей встречи (проверь какие выполнены, какие нет):\n${previousProtocol.actionItems.map((a) => `- ${a.owner}: ${a.task} (дедлайн ${a.deadline})`).join("\n")}`
      : "";

    const systemPrompt = `Ты — ассистент для составления протоколов деловых встреч на русском языке.
Отвечай ТОЛЬКО корректным JSON без пояснений и без markdown-обёртки.
Сегодняшняя дата встречи: ${meeting.date}.`;

    const userPrompt = `Транскрипт встречи:
${transcriptText}

Проект: ${project.name}
Название встречи: ${meeting.titleDraft ?? project.name}
Участники: ${participants.join(", ") || "не определены"}${prevSection}

Верни JSON строго в таком формате:
{
  "summary": {
    "title": "Финальное название встречи",
    "overview": "2-3 предложения о чём была встреча"
  },
  "participants": ["Имя1", "Имя2"],
  "decisions": ["Решение 1", "Решение 2"],
  "actionItems": [
    { "owner": "Имя", "task": "Задача", "deadline": "YYYY-MM-DD" }
  ],
  "completedFromPrevious": [
    { "owner": "Имя", "task": "Задача", "deadline": "YYYY-MM-DD" }
  ],
  "carriedForward": [
    { "owner": "Имя", "task": "Задача", "deadline": "YYYY-MM-DD" }
  ],
  "transcriptHighlights": [
    { "speaker": "Имя", "quote": "Цитата до 100 символов" }
  ]
}

completedFromPrevious — задачи из предыдущей встречи которые упомянуты как выполненные.
carriedForward — задачи из предыдущей встречи которые не выполнены и переносятся.
Если предыдущих задач не было — оба массива пустые.`;

    let protocol;
    try {
      const raw = await this.complete(systemPrompt, userPrompt, 0.2);
      protocol = JSON.parse(raw);
    } catch (e) {
      throw new Error(`YandexGPT вернул некорректный JSON: ${e.message}`);
    }

    // Гарантируем наличие всех полей
    protocol.summary ??= { title: meeting.titleDraft ?? project.name, overview: "" };
    protocol.participants ??= participants;
    protocol.decisions ??= [];
    protocol.actionItems ??= [];
    protocol.completedFromPrevious ??= [];
    protocol.carriedForward ??= [];
    protocol.transcriptHighlights ??= [];

    const protocolText = buildProtocolText(protocol, meeting, project);
    return { protocol, protocolText };
  }
}

function buildProtocolText(protocol, meeting, project) {
  const lines = [
    "ПРОТОКОЛ ВСТРЕЧИ",
    "",
    `Проект: ${project.name}`,
    `Название: ${protocol.summary.title}`,
    `Дата: ${meeting.date}`,
    `Участники: ${protocol.participants.join(", ") || "—"}`,
    "",
    "КРАТКАЯ СВОДКА",
    protocol.summary.overview,
    "",
    "РЕШЕНИЯ",
    ...protocol.decisions.map((d, i) => `${i + 1}. ${d}`),
    "",
    "ЗАДАЧИ",
    ...protocol.actionItems.map((a, i) => `${i + 1}. ${a.owner} — ${a.task} (до ${a.deadline})`)
  ];

  if (protocol.completedFromPrevious.length > 0) {
    lines.push(
      "",
      "ВЫПОЛНЕНО С ПРОШЛОЙ ВСТРЕЧИ",
      ...protocol.completedFromPrevious.map((a, i) => `${i + 1}. ✓ ${a.owner} — ${a.task}`)
    );
  }

  if (protocol.carriedForward.length > 0) {
    lines.push(
      "",
      "ПЕРЕНЕСЕНО НА СЛЕДУЮЩУЮ ВСТРЕЧУ",
      ...protocol.carriedForward.map((a, i) => `${i + 1}. ${a.owner} — ${a.task} (до ${a.deadline})`)
    );
  }

  lines.push(
    "",
    "КЛЮЧЕВЫЕ МОМЕНТЫ",
    ...protocol.transcriptHighlights.map((h) => `— ${h.speaker}: «${h.quote}»`)
  );

  return lines.join("\n");
}
