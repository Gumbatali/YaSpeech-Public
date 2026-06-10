# Обзор архитектуры

## Кратко

YaSpeech построен как тонкая `web + orchestration` оболочка вокруг облачных AI-сервисов Яндекса.
Само приложение не распознаёт речь и не пишет текст — оно принимает действия пользователя,
хранит артефакты, управляет статусами, запускает внешнюю обработку и собирает результат в UI.

## Три слоя

```
packages/core           — Домен + Use Cases (ноль зависимостей от облака)
apps/server             — Инфраструктура + HTTP-слой
apps/web                — SPA (React + htm, без шага сборки)
```

### `packages/core`

Чистая бизнес-логика: `Meeting`, `Project`, `User` + use cases.
Тестируется в изоляции без mock-облака.

### `apps/server`

Два подслоя:

**HTTP-слой** (`apps/server/src/server/`):
- `create-http-handler.js` — composition root (~170 строк)
- `router.js` — табличный роутер с `:param`-сегментами
- `make-use-cases.js` — единая точка DI
- `routes/` — 5 модулей (auth, admin, project, meeting, static)
- `shared/validate.js` — guard-валидация на API-границе → 400 вместо 500

**Инфраструктура** (`apps/server/src/infrastructure/`):
- адаптеры Object Storage, SpeechKit, YandexGPT, YMQ
- `YcMeetingRepository` — два индекса + fallback для старых путей
- mock-адаптеры для локальной разработки и тестов

### `apps/web`

- Фреймворк: React + htm (UMD), без babel/webpack
- Модули: `api.js`, `format.js`, `transcript-model.js`, `html.js`
- Экраны: `screens/{login,admin,summary-tab,transcript-tab}.js`
- Экраны вызываются как функции с явными параметрами — нет free variables из внешней области

## Поток обработки

```
Браузер                     Yandex Cloud
───────                     ────────────
upload аудио  ──►  Object Storage (audio.mp3)
                       │
                       ▼
               Message Queue (YMQ)
                       │
                       ▼
               Cloud Function «worker»
                   ├─ SpeechKit ────────► transcript.json
                   ├─ LLM-диаризация ───► разделение спикеров
                   ├─ коррекция ASR ────► исправление распознавания
                   ├─ идентификация ────► имена и роли
                   └─ YandexGPT ────────► protocol.json
                       │
браузер  ◄──  API Gateway ◄──  Cloud Function «api»
```

## Статусный цикл встречи

```
created → uploading → upload_completed → speechkit_processing →
transcribed → awaiting_draft_confirmation → draft_confirmed →
generating_protocol → done
                   ↘ failed (в любой стадии worker)
```

## Ключевые архитектурные решения

### Ноль npm в продакшне

Cloud Functions деплоятся как zip с исходниками — `node_modules` нет.
AWS Signature V4, HMAC-сессии, scrypt — всё через встроенные модули Node.
Это упрощает деплой и исключает supply-chain уязвимости.

### Прямой upload в Object Storage

Аудиофайлы крупные, API Gateway не должен быть каналом бинарных данных.
Backend генерирует presigned URL и возвращает клиенту — клиент льёт напрямую.

### Draft-шаг перед протоколом

Имена и роли спикеров определяются не идеально.
Пользователь подтверждает черновик (имена, название встречи) до запуска
дорогого LLM-пайплайна генерации протокола.

### Два индекса встреч

Глобальный `meetings/index.json` — O(1) поиск по meetingId со ссылкой на `baseKey`.
Проектные индексы `projects/{id}/meetings/index.json` — legacy, поддерживаются как fallback.
Object Storage не транзакционна — `reconcile-indexes.sh` умеет диагностировать расхождения.

### Кэш-бастинг ES-модулей

Все `import` в `app/*.js` имеют суффикс `?v=__BUILD__`.
`deploy.sh` подставляет версию во весь текст JS/CSS/HTML при загрузке в бакет —
не только в `<script src>`, но и во внутренние ES-импорты.

## Облачный контур (production)

| Ресурс | Назначение |
|--------|-----------|
| Cloud Function `yaspeech-api` | HTTP API, сессии |
| Cloud Function `yaspeech-worker` | Обработка встреч |
| Object Storage `yaspeech-artifacts` | JSON + аудио |
| Object Storage `yaspeech-frontend` | SPA-статика |
| API Gateway | Маршрутизация, rate limiting |
| Message Queue | Асинхронная очередь задач |
| SpeechKit | ASR |
| YandexGPT | LLM-пайплайн |

## Локальный контур

| Компонент | Замена |
|-----------|--------|
| Object Storage | JSON-файлы на диске (`LocalArtifactStorage`) |
| YMQ | In-process `LocalQueueRunner` |
| SpeechKit | `MockSpeechKitGateway` |
| YandexGPT | `MockYandexGptGateway` |
