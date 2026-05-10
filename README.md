# YaSpeech MVP

Веб-интерфейс для протоколирования встреч через `SpeechSense` с асинхронным пайплайном и финальной генерацией протокола.

## Что уже реализовано

- список проектов и создание нового проекта;
- CRUD команды проекта;
- создание встречи с датой, участниками, гостями и одним аудиофайлом;
- прямая загрузка файла по выданному upload URL;
- асинхронный pipeline со статусами `uploading -> uploaded -> speechsense_processing -> protocol_generating -> done/failed`;
- история встреч проекта;
- экран итогового протокола с копированием и скачиванием `TXT`;
- retry после ошибки генерации.

## Технический контур

- `packages/core`
  доменные объекты и use cases;
- `apps/server`
  файловые репозитории, mock `SpeechSense`, mock `AI Studio`, локальный queue runner, HTTP API;
- `apps/web`
  статический SPA shell и UI.

В локальной реализации backend работает без внешних npm-зависимостей и хранит данные в JSON-манифестах:

- `projects/<project-id>/team.json`
- `projects/<project-id>/meetings/index.json`
- `projects/<project-id>/meetings/<meeting-id>/meeting.json`
- `projects/<project-id>/meetings/<meeting-id>/audio-original.<ext>`
- `projects/<project-id>/meetings/<meeting-id>/transcript.json`
- `projects/<project-id>/meetings/<meeting-id>/protocol.json`
- `projects/<project-id>/meetings/<meeting-id>/protocol.txt`

## Запуск

```bash
npm test
npm run build
npm run dev
```

После `npm run dev` приложение доступно на [http://127.0.0.1:8787](http://127.0.0.1:8787).

## Что важно про интеграции

Сейчас включены локальные mock-адаптеры:

- `MockSpeechSenseGateway`
- `MockAiStudioGateway`

Они уже спрятаны за инфраструктурным слоем, поэтому следующая итерация — заменить их на реальные Yandex adapters без перелома UI и доменной модели.

## Документация по проекту

Для передачи и проектной работы добавлен отдельный handbook:

- [Project Handbook](./docs/project-handbook/README.md)

Внутри есть:

- продуктовая часть;
- пользовательские сценарии;
- solution-архитектура;
- C4-диаграммы;
- системный анализ;
- API и модель данных;
- облачное развёртывание;
- IAM и runbook;
- handoff-материалы для разработки.
