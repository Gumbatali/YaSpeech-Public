# Состояния и последовательности

## Жизненный цикл встречи

```mermaid
stateDiagram-v2
  [*] --> uploading
  uploading --> uploaded
  uploaded --> speechkit_processing
  speechkit_processing --> diarizing
  diarizing --> draft_ready
  draft_ready --> protocol_generating
  protocol_generating --> done
  uploaded --> failed
  speechkit_processing --> failed
  diarizing --> failed
  protocol_generating --> failed
  failed --> uploaded : retry
```

`diarizing` — асинхронный опрос сервиса диаризации
(`apps/diarization-service`, pyannote.audio, портировано из
research/diarization-asr-lab), тем же паттерном поллинга, что и ASR. Если
сервис не настроен, упал или превысил таймаут (90 минут) — не роняет
встречу, а откатывается на разметку спикеров из ASR (см. «Ошибочные ветки»).

Улучшение расшифровки ИИ идёт **ортогонально** основному статусу — отдельным
полем `llmRefine.status`, не меняя `meeting.status`. Запускается
автоматически, без ручной кнопки:

```mermaid
stateDiagram-v2
  [*] --> queued : автоматически после diarizing → draft_ready
  queued --> processing
  processing --> done
  processing --> failed : ручной повтор кнопкой «Повторить улучшение»
  processing --> stale : пользователь отредактировал текст
  stale --> queued : автоматически перезапускается
```

## Основная последовательность обработки

```mermaid
sequenceDiagram
  participant U as Пользователь
  participant W as Web UI
  participant API as API Backend
  participant S as Storage
  participant Q as Queue / Worker
  participant SS as SpeechKit
  participant D as Diarization Service
  participant AI as YandexGPT

  U->>W: Выбрать проект и файл
  W->>API: POST /api/meetings
  API-->>W: uploadUrl + meeting
  W->>S: PUT аудиофайл
  W->>API: POST /api/meetings/{id}/upload-complete
  API->>Q: enqueue meeting
  Q->>SS: ASR (split: start → poll → done)
  SS-->>Q: transcript + jobId

  Q->>D: POST /jobs (split: poll → done)
  D-->>Q: RTTM (спикеры по голосу, не по каналу)
  Note over Q: фразы переразмечены по диаризации,<br/>черновик собирается без ручных LLM-шагов

  Q->>AI: refine: диаризация-фоллбэк (если моно) · глоссарий ·<br/>коррекция (line-ID) · имена — автоматически
  AI-->>Q: transcript.refined.json
  Q-->>W: meeting.status = draft_ready, llmRefine.status = done

  U->>W: Подтвердить черновик
  W->>API: POST /api/meetings/{id}/confirm-draft
  API->>Q: enqueue meeting
  Note over Q: ждёт llmRefine.status == done/failed,<br/>если refine ещё идёт
  Q->>AI: generateProtocol(refined ?? raw)
  AI-->>Q: protocol
  Q-->>W: meeting.status = done
```

## Ошибочные ветки

- если транскрипт не получен (или распознавание пустое — `POOR_TRANSCRIPT`), встреча уходит в `failed`;
- если ASR висит дольше 40 минут — `SPEECHKIT_TIMEOUT` → `failed`;
- если диаризация не настроена, упала или висит дольше 90 минут — используется
  разметка спикеров из ASR как есть, встреча НЕ падает;
- если финальный протокол не собран, встреча уходит в `failed`;
- сбой refine помечает `llmRefine.status=failed`, но НЕ роняет статус встречи;
  `generateProtocol` дожидается `done`/`failed` перед сборкой протокола, но
  никогда не блокируется бесконечно — `failed` тоже разблокирует сборку
  (на raw/correctedText вместо refined-текста);
- сбой QA-шага (`qaProtocol`, D1/D2 — запускается только при `transcriptQuality` fair/poor)
  логируется как warning и НЕ роняет статус встречи: уже собранный `extractProtocol`
  возвращается без QA-аннотаций вместо потери всего протокола;
- повторная попытка (`retry`) возвращает встречу к обработке и запускает пайплайн заново.
