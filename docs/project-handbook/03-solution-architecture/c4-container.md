# C4 Container

Схема уровня `Container`: основные исполняемые части решения и их связи.

```mermaid
flowchart TD
  User["Пользователь"] --> Web["Web SPA<br/>React / JavaScript"]
  Web --> APIGW["API Gateway"]
  Web --> Upload["Прямая загрузка файла<br/>в Object Storage"]

  APIGW --> ApiFn["Cloud Function: API"]
  ApiFn --> Storage["Object Storage"]
  ApiFn --> Queue["Message Queue"]

  Queue --> Worker["Cloud Function: Worker"]
  Worker --> Storage
  Worker --> SpeechSense["SpeechSense"]
  Worker --> AIStudio["AI Studio"]

  ApiFn --> MeetingState["Состояние встречи<br/>meeting.json"]
  Worker --> MeetingState
```

## Контейнеры

- `Web SPA`
  пользовательский интерфейс.
- `API Gateway`
  публичная точка входа для фронтенда.
- `Cloud Function: API`
  создание проектов, встреч, выдача upload URL, чтение статусов.
- `Object Storage`
  сайт, аудио, транскрипты и протоколы.
- `Message Queue`
  постановка задач на фоновую обработку.
- `Cloud Function: Worker`
  оркестрация транскрипции, draft и протокола.
- `SpeechSense`
  распознавание и подготовка транскрипта.
- `AI Studio`
  генерация title draft, speaker draft и протокола.
