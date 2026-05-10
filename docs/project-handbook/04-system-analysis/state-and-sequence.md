# Состояния и последовательности

## Жизненный цикл встречи

```mermaid
stateDiagram-v2
  [*] --> uploading
  uploading --> uploaded
  uploaded --> speechsense_processing
  speechsense_processing --> draft_ready
  draft_ready --> protocol_generating
  protocol_generating --> done
  uploaded --> failed
  speechsense_processing --> failed
  protocol_generating --> failed
  failed --> uploaded : retry
```

## Основная последовательность обработки

```mermaid
sequenceDiagram
  participant U as Пользователь
  participant W as Web UI
  participant API as API Backend
  participant S as Storage
  participant Q as Queue / Worker
  participant SS as SpeechSense
  participant AI as AI Studio

  U->>W: Выбрать проект и файл
  W->>API: POST /api/meetings
  API-->>W: uploadUrl + meeting
  W->>S: PUT аудиофайл
  W->>API: POST /api/meetings/{id}/upload-complete
  API->>Q: enqueue meeting
  Q->>SS: processMeeting(audio)
  SS-->>Q: transcript + talkId
  Q->>AI: generateDraft(transcript, project context)
  AI-->>Q: titleDraft + speakerDrafts
  Q-->>W: meeting.status = draft_ready
  U->>W: Подтвердить черновик
  W->>API: POST /api/meetings/{id}/confirm-draft
  API->>Q: enqueue meeting
  Q->>AI: generateProtocol(transcript, draft)
  AI-->>Q: protocol
  Q-->>W: meeting.status = done
```

## Ошибочные ветки

- если транскрипт не получен, встреча уходит в `failed`;
- если финальный протокол не собран, встреча уходит в `failed`;
- повторная попытка возвращает встречу в `uploaded` и запускает пайплайн заново.
