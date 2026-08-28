# Облачное развёртывание

## Продакшн-URL

```
https://d5dk1on1i3j14e4gemus.z2ka767n.apigw.yandexcloud.net
```

> **Основной путь — автоматический.** Мерж в `main` запускает деплой через
> GitHub Actions; ручной запуск — Actions → Deploy → Run workflow. Настройка и
> детали: [ci-cd.md](./ci-cd.md). Ниже — ручной деплой с локальной машины тем же
> скриптом.

## Деплой-скрипт

Секреты хранятся в `scripts/.env.deploy` (в `.gitignore` — **не коммитить**) —
локально. В CI те же значения берутся из GitHub Secrets как переменные окружения.
Пример конфига: `scripts/.env.deploy.example`.

```bash
bash scripts/deploy.sh all       # обе функции + фронтенд + шлюз
bash scripts/deploy.sh api       # api-функция + фронтенд + шлюз
bash scripts/deploy.sh worker    # только worker-функция
bash scripts/deploy.sh frontend  # только фронтенд в Object Storage
bash scripts/deploy.sh gateway   # только конфигурация API Gateway
bash scripts/deploy.sh diarization  # только контейнер диаризации (Docker-образ)
```

### Что делает deploy.sh

1. **Фронтенд** (`frontend`-таргет):
   - Обходит `apps/web/{app,lib}` рекурсивно
   - Подставляет `__BUILD__` = `{git-sha}-{timestamp}` во весь текст JS/CSS/HTML
   - Загружает в бакет `yaspeech-frontend`
   - Это версионирует ВСЕ внутренние ES-импорты, не только `<script src>` в index.html

2. **API-функция** (`api`-таргет):
   - `zip -r apps/server/src/` — новые файлы подхватываются автоматически (нет хардкода)
   - Добавляет `packages/core/src/`
   - Деплоит версию через `yc serverless function version create`

3. **Worker-функция** (`worker`-таргет): аналогично api

4. **Gateway** (`gateway`-таргет): `yc serverless api-gateway update --spec infra/api-gateway.yaml`

5. **Диаризация** (`diarization`-таргет, `apps/diarization-service/`):
   - Собирает Docker-образ (pyannote.audio + сервис на FastAPI), пушит в
     Yandex Container Registry, деплоит как Serverless Container
     (`yaspeech-diarization`) и создаёт (идемпотентно) YMQ-триггер
     `yaspeech-diarization-trigger`, связывающий очередь диаризации с
     эндпоинтом `/process` контейнера
   - Требует Docker и `HF_TOKEN` (HuggingFace-токен с принятыми условиями
     моделей `pyannote/speaker-diarization-3.1` и
     `pyannote/wespeaker-voxceleb-resnet34-LM`)
   - **Архитектура**: Node (api/worker) не вызывает контейнер по HTTP
     напрямую — кладёт сообщение в YMQ-очередь (`DIARIZATION_QUEUE_URL`),
     дальше статус/результат читаются из S3. YMQ-триггер
     (`--invoke-container-*`) вызывает контейнер по `/process` и держит
     соединение открытым на всё время обработки одного сообщения (до
     3600с) — необходимо, так как диаризация на CPU длится время,
     сравнимое с длиной встречи (RTF ~1x)

## Облачные ресурсы

| Ресурс | Имя | Назначение |
|--------|-----|-----------|
| Cloud Function | `yaspeech-api` | HTTP API |
| Cloud Function | `yaspeech-worker` | Обработка встреч |
| Object Storage | `yaspeech-artifacts` | JSON + аудио (приватный) |
| Object Storage | `yaspeech-frontend` | SPA-статика (публичный) |
| API Gateway | `yaspeech-gateway` | Маршрутизация |
| Message Queue | `yaspeech-queue` | YMQ — очередь задач |
| Service Account | `yaspeech-sa` | Роли: storage.editor, ymq.writer, functions.invoker |
| Container Registry | `yaspeech-diarization` | Образы сервиса диаризации |
| Serverless Container | `yaspeech-diarization` | pyannote.audio — реальная acoustic-диаризация (CPU, до 1ч на сообщение) |
| Message Queue | `yaspeech-diarization-queue` | Задачи диаризации (Node → очередь, не напрямую в контейнер) |
| Trigger | `yaspeech-diarization-trigger` | YMQ → `yaspeech-diarization` (`/process`), держит вызов открытым на всё время обработки |

## Переменные окружения функций

| Переменная | Функция | Назначение |
|------------|---------|-----------|
| `YC_STORAGE_BUCKET` | api + worker | Бакет артефактов |
| `YC_QUEUE_URL` | api + worker | URL очереди YMQ |
| `STORAGE_KEY_ID` / `STORAGE_SECRET` | api + worker | S3-ключи для Object Storage |
| `YMQ_KEY_ID` / `YMQ_SECRET` | api + worker | Ключи для YMQ |
| `SPEECHKIT_API_KEY` | worker | Ключ SpeechKit |
| `YANDEX_GPT_API_KEY` | worker | Ключ YandexGPT |
| `SESSION_SECRET` | api | HMAC-секрет для сессионных cookies |
| `ADMIN_LOGIN` | api | Логин первого юзера, получающего роль admin |
| `USE_MOCKS` | worker | `true` → mock-адаптеры |
| `ASR_PROVIDER` | worker | `speechkit` \| `groq` \| `mock` |
| `GPT_B2_VOTES` | worker | Число голосов ансамбля identifySpeakers (B2). По умолчанию `7`; `1` — старое однократное поведение |
| `GPT_C1_SAMPLES` | worker | Число сэмплов ансамбля extractProtocol (C1). По умолчанию `5`; `1` — старое однократное поведение |
| `DIARIZATION_QUEUE_URL` | api + worker | URL очереди `yaspeech-diarization-queue`. Пусто → диаризация пропускается без ошибки (спикеры — как их разделил ASR) |
| `STORAGE_KEY_ID` / `STORAGE_SECRET` / `STORAGE_BUCKET` | контейнер `yaspeech-diarization` | Доступ к тому же бакету артефактов, что у api/worker |
| `HF_TOKEN` | контейнер `yaspeech-diarization` | HuggingFace-токен для pyannote (гейтед-модели) |

## API Gateway — маршруты (`infra/api-gateway.yaml`)

| Путь | Куда |
|------|------|
| `/api/{path+}` | Cloud Function `yaspeech-api` |
| `/` | Object Storage `yaspeech-frontend` → `index.html` |
| `/app/{path+}` | Object Storage `yaspeech-frontend` → `app/{path}` |
| `/lib/{path+}` | Object Storage `yaspeech-frontend` → `lib/{path}` |

## Диагностика индексов

После сбоя или ручного удаления файлов — проверить согласованность индексов:

```bash
# dry-run (только отчёт)
bash scripts/reconcile-indexes.sh

# применить исправления
bash scripts/reconcile-indexes.sh --apply
```

Скрипт различает «файл удалён намеренно» (файл есть, в индексе нет → репорт без изменений)
и «перекрёстное расхождение» (запись в глобальном индексе не совпадает с проектным → --apply исправит).

## Последовательность первого деплоя

1. Создать SA с ролями `storage.editor`, `ymq.writer`, `serverless.functions.invoker`, `api-gateway.admin`
2. Создать бакеты: `yaspeech-artifacts` (приватный), `yaspeech-frontend` (публичный)
3. Создать очередь `yaspeech-queue` в YMQ
4. Заполнить `scripts/.env.deploy` — шаблон: `scripts/.env.deploy.example`
5. `bash scripts/deploy.sh all`
6. Проверить: `curl https://<gateway>/api/projects` → `{"projects":[]}`
