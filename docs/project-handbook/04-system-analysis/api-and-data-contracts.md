# API и контракты данных

## HTTP API

### Проекты

- `GET /api/projects`
- `POST /api/projects`
- `PATCH /api/projects/{projectId}`
- `GET /api/projects/{projectId}/team`
- `PUT /api/projects/{projectId}/team`
- `GET /api/projects/{projectId}/meetings`

### Встречи

- `POST /api/meetings`
- `POST /api/meetings/{meetingId}/upload-complete`
- `POST /api/meetings/{meetingId}/confirm-draft`
- `GET /api/meetings/{meetingId}`
- `POST /api/meetings/{meetingId}/retry`
- `GET /api/meetings/{meetingId}/protocol.txt`

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
- `speechSenseTalkId`
- `titleDraft`
- `speakerDrafts`
- `transcriptPreview`
- `transcriptSegments`
- `protocol`
- `error`

## Контракт хранения артефактов

```text
projects/<project-id>/team.json
projects/<project-id>/meetings/index.json
projects/<project-id>/meetings/<meeting-id>/meeting.json
projects/<project-id>/meetings/<meeting-id>/audio-original.<ext>
projects/<project-id>/meetings/<meeting-id>/transcript.json
projects/<project-id>/meetings/<meeting-id>/protocol.json
projects/<project-id>/meetings/<meeting-id>/protocol.txt
```

## Правила переходов

- `uploading` -> файл ещё не подтверждён;
- `uploaded` -> файл загружен, задача готова к обработке;
- `speechsense_processing` -> идёт транскрипция и draft;
- `draft_ready` -> пользователь должен подтвердить черновик;
- `protocol_generating` -> идёт сборка финального протокола;
- `done` -> встреча завершена;
- `failed` -> произошла ошибка, можно делать retry.
