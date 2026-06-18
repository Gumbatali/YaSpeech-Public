# API и контракты данных

## HTTP API

### Аутентификация

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

### Проекты

- `GET /api/projects`
- `POST /api/projects`
- `GET /api/projects/{projectId}`
- `PATCH /api/projects/{projectId}`
- `DELETE /api/projects/{projectId}`
- `PATCH /api/projects/{projectId}/team`
- `GET /api/projects/{projectId}/meetings`

### Встречи

- `POST /api/meetings`
- `POST /api/meetings/{meetingId}/upload-complete`
- `POST /api/meetings/{meetingId}/confirm-draft`
- `GET /api/meetings/{meetingId}`
- `POST /api/meetings/{meetingId}/retry`
- `POST /api/meetings/{meetingId}/transcript/refine` — запустить улучшение ИИ (по кнопке)
- `PATCH /api/meetings/{meetingId}/transcript` — сохранить отредактированную расшифровку
- `POST /api/meetings/{meetingId}/transcript/restore` — вернуть исходную расшифровку
- `PATCH /api/meetings/{meetingId}/protocol` — сохранить отредактированный протокол
- `POST /api/meetings/{meetingId}/regenerate-protocol` — пересобрать протокол
- `GET /api/meetings/{meetingId}/protocol.txt`
- `GET /api/meetings/{meetingId}/transcript.txt`
- `DELETE /api/meetings/{meetingId}`

### Администрирование

- `GET /api/admin/users`
- `PATCH /api/admin/users/{userId}` — бан, роль, квота

## Пример создания встречи

### Request

```json
{
  "projectId": "residential-sales",
  "date": "2026-05-11",
  "participantIds": ["anna", "ivan"],
  "guests": [],
  "fileName": "meeting-01.m4a",
  "contentType": "audio/mp4"
}
```

### Response

```json
{
  "meeting": {
    "id": "meeting-123",
    "status": "uploading"
  },
  "uploadUrl": "/local-upload/meeting-123?token=..."
}
```

## Контракт состояния встречи

Ключевые поля `meeting.json`:

- `id`
- `projectId`
- `projectName`
- `date`
- `status`
- `currentStage`
- `participantIds`
- `guests`
- `audioFile`
- `artifacts`
- `speechKitJobId`
- `titleDraft`
- `speakerDrafts`
- `transcriptPreview`
- `transcriptSegments`
- `rawTranscriptSegments` — сырые сегменты ASR (вкладка «Дословно»)
- `llmTranscriptSegments` — сегменты после улучшения ИИ (вкладка «LLM восстановил»)
- `llmRefine` — статус улучшения: `{ status, done, total, requestedAt, changedRatio, ... }`
- `protocol`
- `error` — `{ code, message }`

## Контракт хранения артефактов

Текущий `baseKey`: `projects/{projectId}/{YYYY-MM-DD}_{meetingId}`
(старый формат `projects/{pid}/meetings/{mid}` поддерживается как fallback).

```text
meetings/index.json                          # глобальный индекс (meetingId → baseKey)
projects/<project-id>/team.json
projects/<project-id>/glossary.json          # накопленный словарь терминов проекта
{baseKey}/meeting.json
{baseKey}/audio-original.<ext>
{baseKey}/transcript.json
{baseKey}/transcript.raw.json                # сырой ASR (для restore)
{baseKey}/transcript.refined.json            # результат улучшения ИИ (+ чекпоинты)
{baseKey}/protocol.json
{baseKey}/protocol.txt
```

## Правила переходов

Основной статус (`meeting.status`):

- `uploading` -> файл ещё не подтверждён;
- `uploaded` -> файл загружен, задача готова к обработке;
- `speechkit_processing` -> идёт распознавание речи (ASR);
- `draft_ready` -> черновик готов (БЕЗ LLM); можно править, улучшать ИИ, подтверждать;
- `protocol_generating` -> идёт сборка финального протокола;
- `done` -> встреча завершена;
- `failed` -> произошла ошибка, можно делать `retry`.

Статус улучшения ИИ (`llmRefine.status`, ортогонален основному):

- `queued` -> улучшение поставлено в очередь;
- `processing` -> идёт по чанкам (поле `done`/`total` — прогресс);
- `done` -> улучшенная расшифровка готова;
- `failed` -> сбой улучшения (не роняет статус встречи);
- `stale` -> текст отредактирован во время работы джобы, результат отброшен.
