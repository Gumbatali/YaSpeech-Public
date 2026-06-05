# C4 Component

Схема уровня `Component` для backend-части текущего проекта.

```mermaid
flowchart LR
  Http["createHttpHandler"] --> UseCases["Use Cases<br/>CreateProject / CreateMeeting / UpdateTeam / MarkUploadCompleted"]
  Http --> Pipeline["MeetingPipelineService"]

  UseCases --> ProjectRepo["ProjectRepository"]
  UseCases --> MeetingRepo["MeetingRepository"]
  UseCases --> Storage["ArtifactStorage"]

  Pipeline --> MeetingRepo
  Pipeline --> ProjectRepo
  Pipeline --> Storage
  Pipeline --> SpeechGateway["SpeechKitGateway"]
  Pipeline --> AiGateway["YandexGptGateway"]
  Pipeline --> Queue["QueueRunner"]

  Core["packages/core"] --> UseCases
  Core --> Domain["Domain Model"]
```

## Компоненты

### `createHttpHandler`

HTTP-слой. Маршрутизирует запросы и вызывает use case или pipeline.

### `packages/core`

Домен и application-логика без привязки к облачным сервисам.

### `MeetingPipelineService`

Оркестратор стадий:

- transcript;
- draft;
- confirm draft;
- final protocol;
- retry / failed.

### Репозитории и шлюзы

- репозитории отвечают за хранение;
- шлюзы отвечают за внешние интеграции;
- очередь отвечает за фоновые задачи.
