# Состояния и последовательности

## Жизненный цикл встречи

```mermaid
stateDiagram-v2
  [*] --> uploading
  uploading --> uploaded
  uploaded --> speechkit_processing
  speechkit_processing --> draft_ready
  draft_ready --> protocol_generating
  protocol_generating --> done
  uploaded --> failed
  speechkit_processing --> failed
  protocol_generating --> failed
  failed --> uploaded : retry
```

Улучшение расшифровки ИИ идёт **ортогонально** основному статусу — отдельным
полем `llmRefine.status`, не меняя `meeting.status`:

```mermaid
stateDiagram-v2
  [*] --> queued : кнопка «Улучшить с помощью ИИ»
  queued --> processing
  processing --> done
  processing --> failed
  processing --> stale : пользователь отредактировал текст
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
  participant AI as YandexGPT

  U->>W: Выбрать проект и файл
  W->>API: POST /api/meetings
  API-->>W: uploadUrl + meeting
  W->>S: PUT аудиофайл
  W->>API: POST /api/meetings/{id}/upload-complete
  API->>Q: enqueue meeting
  Q->>SS: ASR (split: start → poll → done)
  SS-->>Q: transcript + jobId
  Note over Q: черновик собирается БЕЗ LLM
  Q-->>W: meeting.status = draft_ready

  opt Кнопка «✨ Улучшить с помощью ИИ» (необязательно)
    U->>W: Нажать «Улучшить»
    W->>API: POST /api/meetings/{id}/transcript/refine
    API->>Q: enqueue refine-джобу
    Q->>AI: диаризация · глоссарий · коррекция (line-ID) · имена
    AI-->>Q: transcript.refined.json
    Q-->>W: llmRefine.status = done
  end

  U->>W: Подтвердить черновик
  W->>API: POST /api/meetings/{id}/confirm-draft
  API->>Q: enqueue meeting
  Q->>AI: generateProtocol(refined ?? raw)
  AI-->>Q: protocol
  Q-->>W: meeting.status = done
```

## Ошибочные ветки

- если транскрипт не получен (или распознавание пустое — `POOR_TRANSCRIPT`), встреча уходит в `failed`;
- если ASR висит дольше 40 минут — `SPEECHKIT_TIMEOUT` → `failed`;
- если финальный протокол не собран, встреча уходит в `failed`;
- сбой refine помечает `llmRefine.status=failed`, но НЕ роняет статус встречи;
- сбой QA-шага (`qaProtocol`, D1/D2 — запускается только при `transcriptQuality` fair/poor)
  логируется как warning и НЕ роняет статус встречи: уже собранный `extractProtocol`
  возвращается без QA-аннотаций вместо потери всего протокола;
- повторная попытка (`retry`) возвращает встречу к обработке и запускает пайплайн заново.
