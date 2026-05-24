import { getIamToken, invalidateIamToken } from "../shared/iam-token.js";
import { logger } from "../shared/logger.js";

const SPEECHKIT_URL = "https://transcribe.api.cloud.yandex.net/speech/stt/v2/longRunningRecognize";
const OPERATION_URL = "https://operation.api.cloud.yandex.net/operations";

// SpeechKit v2 поддерживает только: LINEAR16_PCM, OGG_OPUS, MP3
// Для остальных форматов не указываем encoding — автоопределение по URI
function resolveEncoding(fileName) {
  const ext = (fileName ?? "").split(".").pop().toLowerCase();
  const map = {
    mp3: "MP3",
    ogg: "OGG_OPUS",
    opus: "OGG_OPUS",
    wav: "LINEAR16_PCM"
  };
  return map[ext] ?? null; // null = не указываем, SpeechKit сам определит
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class YcSpeechKitGateway {
  constructor({ bucket }) {
    this.bucket = bucket;
  }

  async processMeeting({ meeting, project }) {
    let iamToken = await getIamToken();

    const audioUri = `https://storage.yandexcloud.net/${this.bucket}/${meeting.artifacts.audioOriginalKey}`;
    const encoding = resolveEncoding(meeting.audioFile?.originalFileName);

    logger.info("SpeechKit: starting recognition", {
      meetingId: meeting.id,
      audioUri,
      encoding: encoding ?? "auto"
    });

    // v2 longRunningRecognize поддерживает только стандартный набор полей.
    // literatureText / speechAdaptation — это v3, при попытке их добавить
    // v2 либо игнорирует, либо возвращает урезанный результат. Не используем.
    const makeRequest = async (token) => {
      return fetch(SPEECHKIT_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          config: {
            specification: {
              languageCode: "ru-RU",
              model: "general",
              ...(encoding ? { audioEncoding: encoding } : {}),
              speakerLabeling: "ENABLED",
              rawResults: false,
              partialResults: false
            }
          },
          audio: { uri: audioUri }
        })
      });
    };

    // Запускаем асинхронное распознавание
    let startRes = await makeRequest(iamToken);

    if (startRes.status === 401) {
      invalidateIamToken();
      iamToken = await getIamToken();
      startRes = await makeRequest(iamToken);
    }

    if (!startRes.ok) {
      const text = await startRes.text().catch(() => "");
      logger.error("SpeechKit: start failed", { meetingId: meeting.id, status: startRes.status, body: text });
      throw new Error(`SpeechKit start failed ${startRes.status}: ${text}`);
    }

    const operation = await startRes.json();
    const operationId = operation.id;
    if (!operationId) {
      throw new Error(`SpeechKit: no operation id in response: ${JSON.stringify(operation)}`);
    }

    logger.info("SpeechKit: operation created, polling...", { meetingId: meeting.id, operationId });

    // Ждём завершения (до 25 минут)
    const response = await this.pollOperation(operationId, 500, 3000);

    // Преобразуем в наш формат
    const transcript = this.parseTranscript(response, meeting);
    return { jobId: operationId, transcript };
  }

  async pollOperation(operationId, maxAttempts, intervalMs) {
    for (let i = 0; i < maxAttempts; i++) {
      await sleep(intervalMs);

      let iamToken = await getIamToken();
      let res = await fetch(`${OPERATION_URL}/${operationId}`, {
        headers: { "Authorization": `Bearer ${iamToken}` }
      });

      if (res.status === 401) {
        invalidateIamToken();
        iamToken = await getIamToken();
        res = await fetch(`${OPERATION_URL}/${operationId}`, {
          headers: { "Authorization": `Bearer ${iamToken}` }
        });
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`SpeechKit poll failed ${res.status}: ${text}`);
      }

      const op = await res.json();

      if (op.done) {
        if (op.error) {
          throw new Error(`SpeechKit error: ${JSON.stringify(op.error)}`);
        }
        return op.response;
      }
    }
    throw new Error("SpeechKit recognition timed out after 25 minutes");
  }

  parseTranscript(response, meeting) {
    const chunks = response.chunks ?? [];

    // Группируем последовательные реплики по speakerTag
    const grouped = [];
    for (const chunk of chunks) {
      const text = chunk.alternatives?.[0]?.text ?? "";
      if (!text.trim()) continue;

      const speakerTag = chunk.speakerTag ?? chunk.channelTag ?? "1";
      const last = grouped.at(-1);

      // Склеиваем подряд идущие реплики одного спикера
      if (last && last.speakerTag === speakerTag) {
        last.text += " " + text;
      } else {
        grouped.push({ speakerTag, text });
      }
    }

    // Формируем уникальных спикеров
    const speakerIds = [...new Set(grouped.map((g) => g.speakerTag))];

    const phrases = grouped.map((segment, index) => {
      const speakerIndex = speakerIds.indexOf(segment.speakerTag);
      const speakerId = `speaker-${speakerIndex + 1}`;
      const speakerLabel = `Спикер ${speakerIndex + 1}`;
      return {
        speakerId,
        speakerLabel,
        speakerTag: segment.speakerTag,
        detectedName: null,
        startTimeMs: index * 1000,
        endTimeMs: (index + 1) * 1000,
        text: segment.text
      };
    });

    const rawText = phrases
      .map((p) => `${p.speakerLabel}: ${p.text}`)
      .join("\n");

    return {
      jobId: meeting.id,
      meetingId: meeting.id,
      rawText,
      phrases,
      generatedAt: new Date().toISOString()
    };
  }
}
