# YaSpeech — протоколы встреч без ручной расшифровки

[![CI](https://github.com/Gumbatali/YaSpeech/actions/workflows/ci.yml/badge.svg)](https://github.com/Gumbatali/YaSpeech/actions/workflows/ci.yml)

YaSpeech превращает аудиозапись совещания в готовый протокол: кто что сказал,
о чём договорились, какие задачи и сроки. Загрузили запись — за минуту получили
дословную расшифровку, по кнопке улучшили её с помощью ИИ, собрали протокол.
Сделано для строительной компании СТРОЙТЕХЭКСПЕРТ, работает в Яндекс Облаке.

**Прод (пример):** https://d5d9e2us9lmdm12sgsec.tmjd4m4j.apigw.yandexcloud.net

> 🧭 **Куда смотреть:** [что это и зачем](./docs/КАК-ЭТО-РАБОТАЕТ.md) ·
> [руководство пользователя](./docs/РУКОВОДСТВО-ПОЛЬЗОВАТЕЛЯ.md) ·
> [как участвовать в разработке](./CONTRIBUTING.md) ·
> [Project Handbook](./docs/project-handbook/README.md) (вся документация)

---

## Что умеет

| Возможность | Что это даёт |
|-------------|--------------|
| Загрузка аудио | MP3, M4A, WAV, OGG, FLAC, голосовые из мессенджеров |
| Автоматическая расшифровка | Текст встречи без ручного труда |
| Разделение по спикерам | Кто что сказал, у каждого свой цвет |
| Идентификация имён и ролей | Прораб, заказчик — или описание роли, если имя неизвестно |
| Таймкоды | Каждая реплика с временем от начала записи |
| Две версии текста | Дословно (ASR) и с исправлениями (LLM) |
| Редактирование расшифровки | Поправить любой фрагмент вручную |
| Готовый протокол | Обзор, участники, решения, задачи с ответственными и сроками |
| Редактирование итогов | Любой пункт протокола изменить прямо в браузере |
| Вход и личные кабинеты | Логин/пароль, у каждого свои проекты |
| Администрирование | Управление пользователями, банами, квотами |

---

## Как использовать

1. Войти по логину и паролю
2. Создать проект (например, конкретный строительный объект)
3. Добавить команду проекта (необязательно — помогает точнее определять спикеров)
4. Загрузить запись встречи
5. Подождать обработку — статус меняется автоматически
6. Проверить черновик — поправить имена и название встречи
7. Получить протокол — скопировать, скачать или отредактировать

Пошагово, со всеми экранами и кнопками — в
[руководстве пользователя](./docs/РУКОВОДСТВО-ПОЛЬЗОВАТЕЛЯ.md).

---

## Архитектура

```
packages/core       — Домен + Use Cases (ноль зависимостей от облака)
apps/server         — HTTP-слой + инфраструктура
apps/web            — SPA (React + htm, без шага сборки)
```

### Поток обработки

Ключевой принцип: **ноль автоматических LLM-вызовов**. После распознавания речи
черновик готов мгновенно и бесплатно. Всё, что дороже (улучшение текста ИИ,
сборка протокола), запускается только по кнопке пользователя.

```
Браузер                       Yandex Cloud
───────                       ────────────
upload аудио  ──►  Object Storage  ──►  YMQ  ──►  Cloud Function «worker»
                                                       │
                                                       ▼
                                              SpeechKit (ASR) ──► transcript
                                                       │
                                              status = draft_ready   ← БЕЗ LLM, мгновенно
                                                       │
       ┌───────────────────────────────────────────────┘
       ▼
[кнопка «✨ Улучшить с помощью ИИ»]  ──► refine: диаризация · глоссарий ·
       │                                  коррекция ASR (line-ID) · имена спикеров
       ▼
[кнопка «Собрать протокол»]  ──► YandexGPT ──► protocol.json
       │
браузер  ◄──  API Gateway  ◄──  Cloud Function «api»
```

Между этапами пользователь может править текст вручную; правка во время работы
ИИ инвалидирует устаревший результат (защита от гонки).

### Технический стек

- **Runtime:** Node.js 18 на Yandex Cloud Functions (serverless)
- **Хранилище:** Yandex Object Storage (S3-совместимое)
- **Очередь:** Yandex Message Queue
- **Шлюз:** Yandex API Gateway
- **ASR:** Yandex SpeechKit (опционально Groq Whisper)
- **LLM:** YandexGPT (`yandexgpt-lite`) — по кнопке: улучшение расшифровки + сборка протокола
- **Auth:** HMAC-SHA256 сессии + scrypt — только встроенные модули Node, **ноль npm в продакшне**

### Структура HTTP-слоя

```
create-http-handler.js   ← composition root (~170 строк)
router.js                ← табличный роутер (:param-сегменты)
make-use-cases.js        ← единая точка DI
routes/
  auth-routes.js
  admin-routes.js
  project-routes.js
  meeting-routes.js
  static-routes.js
shared/validate.js       ← guard-валидация → 400 вместо 500
```

### Фронтенд

```
app/app.js               ← App-шелл (~1580 строк — главный кандидат на распил)
app/api.js               ← ApiClient
app/format.js            ← дата/время/таймкоды
app/clipboard.js         ← копирование с fallback для HTTP-контекста
app/transcript-model.js  ← чистые функции транскрипта
app/screens/             ← 4 экрана с явными параметрами
lib/                     ← self-hosted React, ReactDOM, htm (без CDN)
```

---

## Запуск локально

```bash
npm test                    # 54 теста
npm run dev                 # http://127.0.0.1:8787

# С аутентификацией
SESSION_SECRET=dev ADMIN_LOGIN=admin node apps/server/src/dev-server.js
```

Локально работают mock-адаптеры — без реальных облачных вызовов и платных API.
Зависимостей npm нет — `npm install` не нужен.

Подробнее: [локальная разработка](./docs/project-handbook/06-development/local-setup.md) ·
[как участвовать](./CONTRIBUTING.md).

---

## Деплой в своё облако

Три команды — и сервис работает в вашем Яндекс Облаке.

**Требования:** `yc` CLI (авторизованный), `jq`, `gettext` (`envsubst`), `python3` + `boto3`.

```bash
# 1. Заполни пять полей: FOLDER_ID, BUCKET, FRONTEND_BUCKET, SESSION_SECRET, ADMIN_LOGIN/PASSWORD
cp scripts/.env.deploy.example scripts/.env.deploy
$EDITOR scripts/.env.deploy

# 2. Создаёт все ресурсы и дописывает SA_ID / KEY_ID / SECRET / QUEUE_URL в .env.deploy
bash scripts/deploy.sh bootstrap

# 3. Деплоит код, фронтенд и API Gateway (создаёт его при первом запуске)
bash scripts/deploy.sh all
#    → в конце выведет URL шлюза: https://…apigw.yandexcloud.net

# 4. Создаёт администратора с двухфакторной аутентификацией
node scripts/seed-admin.js
#    → отсканируй QR в Google Authenticator, сохрани коды восстановления
```

**Что делает bootstrap автоматически:**
- Создаёт сервисный аккаунт `yaspeech-sa` и выдаёт ему роли:
  `storage.editor`, `ymq.admin`, `ai.speechkit-stt.user`, `ai.languageModels.user`, `serverless.functions.invoker`
- Создаёт статический ключ доступа (записывает `KEY_ID`/`SECRET` в `.env.deploy`)
- Создаёт оба бакета и очередь YMQ (записывает `QUEUE_URL`)
- Создаёт заглушки функций `yaspeech-api` и `yaspeech-worker`

Bootstrap идемпотентен — запускай повторно без опаски.

**Обновление кода после изменений:**

```bash
bash scripts/deploy.sh all       # обе функции + фронтенд + шлюз
bash scripts/deploy.sh api       # api-функция + фронтенд + шлюз
bash scripts/deploy.sh worker    # только worker
bash scripts/deploy.sh frontend  # только фронтенд
bash scripts/deploy.sh gateway   # только шлюз
```

**CI/CD:** мерж в `main` → GitHub Actions деплоит автоматически.
Настройка: [CI/CD](./docs/project-handbook/05-delivery-and-operations/ci-cd.md).

Подробности: [облачное развёртывание](./docs/project-handbook/05-delivery-and-operations/cloud-deployment.md)

---

## Диагностика

```bash
# Проверить согласованность индексов встреч в Object Storage
bash scripts/reconcile-indexes.sh          # dry-run
bash scripts/reconcile-indexes.sh --apply  # применить исправления
```

---

## Документация

**Для всех:**
- **[Как это работает (для нетехнических)](./docs/КАК-ЭТО-РАБОТАЕТ.md)** — без жаргона
- **[Руководство пользователя](./docs/РУКОВОДСТВО-ПОЛЬЗОВАТЕЛЯ.md)** — пошагово, со всеми экранами
- **[Project Handbook](./docs/project-handbook/README.md)** — вся документация, по ролям

**Разработчику:**
- **[Как участвовать (CONTRIBUTING)](./CONTRIBUTING.md)** — старт за 5 минут
- **[Локальная разработка](./docs/project-handbook/06-development/local-setup.md)**
- **[Карта кодовой базы](./docs/project-handbook/06-development/codebase-map.md)**
- **[Обзор архитектуры](./docs/project-handbook/03-solution-architecture/architecture-overview.md)**

**Эксплуатация:**
- **[CI/CD](./docs/project-handbook/05-delivery-and-operations/ci-cd.md)** — автотесты и деплой
- **[Мониторинг и логи](./docs/project-handbook/05-delivery-and-operations/monitoring-and-logging.md)**
- **[Runbook](./docs/project-handbook/05-delivery-and-operations/runbook.md)** — что делать, когда сломалось
