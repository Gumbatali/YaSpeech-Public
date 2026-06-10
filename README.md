# YaSpeech — протоколы встреч без ручной расшифровки

YaSpeech превращает аудиозапись совещания в готовый протокол: кто что сказал,
о чём договорились, какие задачи и сроки. Загрузили запись — через несколько
минут получили структурированный документ. Сделано для строительной компании
СТРОЙТЕХЭКСПЕРТ, работает в Яндекс Облаке.

**Прод:** https://d5dk1on1i3j14e4gemus.z2ka767n.apigw.yandexcloud.net

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

---

## Архитектура

```
packages/core       — Домен + Use Cases (ноль зависимостей от облака)
apps/server         — HTTP-слой + инфраструктура
apps/web            — SPA (React + htm, без шага сборки)
```

### Поток обработки

```
Браузер                       Yandex Cloud
───────                       ────────────
upload аудио  ──►  Object Storage (audio.mp3)
                       │
                       ▼
               Message Queue (YMQ)
                       │
                       ▼
               Cloud Function «worker»
                   ├─ SpeechKit ────────► transcript
                   ├─ LLM-диаризация ───► спикеры
                   ├─ коррекция ASR ────► исправление ошибок
                   ├─ идентификация ────► имена и роли
                   └─ YandexGPT ────────► protocol.json
                       │
браузер  ◄──  API Gateway ◄──  Cloud Function «api»
```

### Технический стек

- **Runtime:** Node.js 18 на Yandex Cloud Functions (serverless)
- **Хранилище:** Yandex Object Storage (S3-совместимое)
- **Очередь:** Yandex Message Queue
- **Шлюз:** Yandex API Gateway
- **ASR:** Yandex SpeechKit (опционально Groq Whisper)
- **LLM:** YandexGPT (5-проходный пайплайн)
- **Auth:** HMAC-SHA256 сессии + scrypt — только встроенные модули Node, **ноль npm в продакшне**

### Структура HTTP-слоя (после рефакторинга)

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
app/app.js               ← App-шелл (~1480 строк)
app/api.js               ← ApiClient
app/format.js            ← дата/время/таймкоды
app/transcript-model.js  ← чистые функции транскрипта
app/screens/             ← 4 экрана с явными параметрами
lib/                     ← self-hosted React, ReactDOM, htm (без CDN)
```

---

## Запуск локально

```bash
npm test                    # 41 тест
npm run dev                 # http://127.0.0.1:8787

# С аутентификацией
SESSION_SECRET=dev ADMIN_LOGIN=admin node apps/server/src/dev-server.js
```

Локально работают mock-адаптеры — без реальных облачных вызовов и платных API.

---

## Деплой в Яндекс Облако

Секреты в `scripts/.env.deploy` (в `.gitignore`):

```bash
bash scripts/deploy.sh all       # обе функции + фронтенд + шлюз
bash scripts/deploy.sh api       # api-функция + фронтенд + шлюз
bash scripts/deploy.sh worker    # только worker-функция
bash scripts/deploy.sh frontend  # только фронтенд
bash scripts/deploy.sh gateway   # только API Gateway
```

`deploy.sh` обходит `apps/server/src/` рекурсивно — новые файлы попадают в zip автоматически,
без ручного сопровождения списка файлов.

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

- **[Как это работает (для нетехнических)](./docs/КАК-ЭТО-РАБОТАЕТ.md)**
- **[Project Handbook](./docs/project-handbook/README.md)** — продукт, архитектура (C4), API, деплой, runbook
- **[Карта кодовой базы](./docs/project-handbook/06-development/codebase-map.md)**
- **[Обзор архитектуры](./docs/project-handbook/03-solution-architecture/architecture-overview.md)**
