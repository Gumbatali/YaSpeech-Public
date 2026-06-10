# Карта кодовой базы

## Структура проекта

```
YaSpeech/
├── packages/core/          # Домен и use cases (ноль зависимостей от облака)
├── apps/server/            # Backend-инфраструктура и HTTP-слой
├── apps/web/               # SPA-фронтенд (React + htm, без шага сборки)
├── infra/                  # API Gateway спека
├── scripts/                # deploy.sh, reconcile-indexes.sh, benchmark/
└── docs/                   # Проектная документация
```

---

## `packages/core`

Чистая бизнес-логика без инфраструктурных зависимостей.

```
packages/core/src/
├── domain/
│   ├── meeting.js          # Meeting entity — статусы, baseKey, артефакты
│   ├── project.js          # Project entity
│   └── user.js             # User entity — роли (admin/member), квоты
├── application/
│   ├── create-project.js
│   ├── create-meeting.js
│   ├── mark-upload-completed.js
│   ├── update-project-team.js
│   ├── register-user.js
│   └── login-user.js
└── index.js                # Реэкспорт публичного API пакета
```

### `domain/meeting.js` — ключевые детали

- **baseKey**: `projects/{projectId}/{YYYY-MM-DD}_{meetingId}` — путь в Object Storage.  
  Старый формат `projects/{pid}/meetings/{mid}` поддерживается как fallback в репозитории.
- **Статусы встречи** (полный цикл):
  `created` → `uploading` → `upload_completed` → `speechkit_processing` →
  `transcribed` → `awaiting_draft_confirmation` → `draft_confirmed` →
  `generating_protocol` → `done` | `failed`
- Файлы артефактов: `audio.mp3`, `transcript.json`, `protocol.json`, `protocol.txt`, `meeting.json`

---

## `apps/server`

### HTTP-слой

```
apps/server/src/server/
├── create-http-handler.js  # Composition root (~170 строк, был монолит 809)
├── router.js               # Табличный роутер — Router.add(method, pattern, handler)
├── make-use-cases.js       # Единая точка сборки всех use cases (DI)
└── routes/
    ├── auth-routes.js      # POST /api/auth/register, /login, /logout; GET /api/auth/me
    ├── admin-routes.js     # GET/PATCH /api/admin/users — бан, роль, квота
    ├── project-routes.js   # CRUD /api/projects, PATCH /api/projects/:id/team
    ├── meeting-routes.js   # Полный CRUD встреч + upload-complete + protocol
    └── static-routes.js    # GET / и /app/* и /lib/* (dev-режим)
```

### Shared-утилиты

```
apps/server/src/shared/
├── validate.js             # Guard-функции (requireString, requireId, ...) → UserError → 400
├── http.js                 # json(), notFound(), serverError(), requireAuth()
└── sign-v4.js              # AWS Signature V4 (для Object Storage и YMQ без npm)
```

### Инфраструктура

```
apps/server/src/infrastructure/
├── yc-artifact-storage.js      # S3-совместимое Object Storage
├── yc-meeting-repository.js    # Глобальный meetings/index.json + fallback по проектным индексам
├── yc-project-repository.js
├── yc-user-repository.js       # Пользователи + сессии (httpOnly HMAC-cookie)
├── ymq-queue-runner.js         # Yandex Message Queue (SQS-совместимая)
├── yandex-gpt-gateway.js       # YandexGPT — 5-проходный пайплайн
├── speech-kit-gateway.js       # Yandex SpeechKit / Groq Whisper
├── mock-yandex-gpt-gateway.js  # Mock для тестов и локальной разработки
└── mock-speech-kit-gateway.js
```

### Точки входа

```
apps/server/src/
├── functions/
│   ├── api-handler.js      # Адаптер YC HTTP-событие → createHttpHandler
│   └── worker-handler.js   # Адаптер YC YMQ-событие → MeetingPipelineService
├── application/
│   └── meeting-pipeline-service.js  # Оркестратор стадий (ASR → диаризация → LLM → протокол)
├── dev-server.js           # Локальный HTTP-сервер (порт 8787)
└── runtime-server.js       # Внутренний сервер для Cloud Function adapter
```

### Тесты

```
apps/server/tests/
├── api.test.js             # E2E-тесты всего HTTP API (createTestServer)
├── api-auth.test.js        # Характеризационные тесты auth/admin
├── api-validation.test.js  # Тесты guard-валидации (400 на мусорный вход)
├── meeting-repository.test.js
├── project-repository.test.js
└── static-ui.test.js       # /app/*, /lib/*, / раздают правильные файлы
```

---

## `apps/web`

SPA без шага сборки: React и htm загружаются как UMD-скрипты из `/lib/`.

```
apps/web/app/
├── app.js                  # App-шелл, навигация, upload-флоу (~1480 строк)
├── api.js                  # ApiClient — все методы API
├── format.js               # Дата/время: todayIso, formatMeetingDate, formatTimecode, ...
├── html.js                 # Bootstrap: export React, html, useState, useEffect, useRef
├── transcript-model.js     # Чистые функции: SPEAKER_COLORS, parseLlmTranscript, ...
├── ui-model.js             # Маппинг статусов → экраны
├── screens/
│   ├── login-screen.js     # LoginScreen({ api, onAuth })
│   ├── admin-screen.js     # AdminScreen({ api, authUser, ... })
│   ├── summary-tab.js      # SummaryTab({ api, protocol, onStartEdit, ... })
│   └── transcript-tab.js   # TranscriptTab({ api, activeMeeting, ... })
├── styles.css              # Дизайн-токены + компоненты
└── real-estate-grid.svg    # Фоновый паттерн
```

```
apps/web/lib/               # Self-hosted библиотеки (без CDN)
├── react.production.min.js
├── react-dom.production.min.js
└── htm.umd.js
```

### Тесты

```
apps/web/tests/
├── ui-model.test.js            # Юнит-тесты маппинга статусов → экраны
├── transcript-model.test.js    # Юнит-тесты чистых функций транскрипта
└── screens.smoke.test.js       # Smoke: рендер каждого экрана в Node (React stub)
```

### Кэш-бастинг (критично)

Все `import` внутри `app/*.js` написаны с суффиксом `?v=__BUILD__`.  
`deploy.sh` подставляет версию во всё содержимое JS/CSS/HTML при загрузке в бакет.  
Без этого внутренние ES-импорты кэшировались как immutable навсегда.

---

## Архитектурные инварианты

| Правило | Как проверить |
|---------|---------------|
| `packages/core` ничего не знает про Yandex Cloud | `grep -r "yandex\|ymq\|speechkit" packages/core/src` → пусто |
| В продакшн-коде нет npm-зависимостей | `zip -r apps/server/src` — нет `node_modules` |
| Все экраны получают зависимости явно через параметры | Нет обращений к переменным вне области видимости функции |
| Secrets не в git | `scripts/.env.deploy` в `.gitignore` |

---

## Тесты — итого

Запустить все: `npm test` (из корня — запускает тесты обоих пакетов).

| Группа | Файл | Что проверяет |
|--------|------|---------------|
| Core workflow | `packages/core/tests/meeting-workflow.test.js` | Use cases + состояния |
| API e2e | `apps/server/tests/api.test.js` | Все HTTP-эндпоинты |
| Auth/admin | `apps/server/tests/api-auth.test.js` | Регистрация, вход, роли, бан |
| Валидация | `apps/server/tests/api-validation.test.js` | 400 на мусорный вход |
| Репозитории | `apps/server/tests/meeting-repository.test.js` | In-memory storage |
| Статика | `apps/server/tests/static-ui.test.js` | /app/*, /lib/* отдают файлы |
| UI model | `apps/web/tests/ui-model.test.js` | Статусы → экраны |
| Transcript model | `apps/web/tests/transcript-model.test.js` | Парсинг, цвета спикеров |
| Screens smoke | `apps/web/tests/screens.smoke.test.js` | Рендер экранов без браузера |

Итого: **41 тест**.
