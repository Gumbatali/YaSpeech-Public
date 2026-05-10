# Карта кодовой базы

## Корневые зоны проекта

### `packages/core`

Домен и use cases:

- создание проекта;
- создание встречи;
- завершение upload;
- retry;
- финализация протокола.

### `apps/server`

Backend-часть:

- HTTP handler;
- pipeline service;
- файловые репозитории;
- локальное хранилище;
- локальная очередь;
- mock-интеграции.

### `apps/web`

Frontend:

- SPA shell;
- mobile-first UI;
- экран проектов;
- экран проекта;
- draft и результат встречи.

### `docs/plans`

История принятых проектных и UI-решений.

## Ключевые файлы

- `packages/core/src/domain/meeting.js`
- `packages/core/src/domain/project.js`
- `apps/server/src/server/create-http-handler.js`
- `apps/server/src/application/meeting-pipeline-service.js`
- `apps/web/app/app.js`
- `apps/web/app/ui-model.js`
- `apps/web/app/styles.css`

## Архитектурные границы

- домен не должен знать про Yandex Cloud;
- инфраструктурный слой можно менять отдельно;
- UI не должен зависеть от конкретной реализации backend storage;
- внешние AI-сервисы должны быть спрятаны за gateway-абстракциями.

## Тесты

Сейчас в проекте есть тесты для:

- core workflow;
- server API;
- web UI model;
- static UI assets.
