# Доменная модель

## Основные сущности

```mermaid
classDiagram
  class Project {
    +id
    +name
    +team[]
    +createdAt
    +updatedAt
  }

  class TeamMember {
    +id
    +name
    +role
  }

  class Meeting {
    +id
    +projectId
    +date
    +participantIds[]
    +guests[]
    +status
    +currentStage
    +speechKitJobId
    +titleDraft
    +speakerDrafts[]
    +transcriptSegments[]
    +llmTranscriptSegments[]
    +llmRefine
    +artifacts
  }

  class ArtifactSet {
    +audioOriginalKey
    +transcriptKey
    +protocolJsonKey
    +protocolTextKey
    +manifestKey
  }

  class Protocol {
    +summary
    +decisions[]
    +actionItems[]
    +fullText
  }

  Project "1" --> "*" TeamMember
  Project "1" --> "*" Meeting
  Meeting "1" --> "1" ArtifactSet
  Meeting "0..1" --> "1" Protocol
```

## Смысл сущностей

### `Project`

Контекст, внутри которого создаются встречи и хранится команда.

### `TeamMember`

Известный участник проекта, с которым система может сопоставлять имена из транскрипта.

### `Meeting`

Центральная сущность обработки. Содержит состояние, артефакты и draft-данные.

### `ArtifactSet`

Набор ключей до файлов и JSON-артефактов в хранилище.

### `Protocol`

Результат финальной AI-обработки.

## Главное правило модели

`meeting.json` является главным агрегатом состояния встречи для UI и backend orchestration.
