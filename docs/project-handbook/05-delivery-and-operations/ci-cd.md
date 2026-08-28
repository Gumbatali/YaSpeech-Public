# CI/CD — автоматические тесты и деплой

Как устроена автоматизация в GitHub Actions и что нужно настроить один раз,
чтобы она заработала.

---

## Два пайплайна

| Workflow | Файл | Когда | Что делает |
|----------|------|-------|------------|
| **CI** | [`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml) | push и PR в `main` | Прогоняет `npm test`. Ничего не деплоит. |
| **Deploy** | [`.github/workflows/deploy.yml`](../../../.github/workflows/deploy.yml) | push в `main` + ручной запуск | Тесты → деплой в Yandex Cloud. |

**Логика простая:**

```
PR открыт ──► CI: тесты ──► зелёный? ──► можно мержить
                                          │
мерж в main ──► Deploy: тесты ──► деплой в прод
```

`Deploy` всегда сначала гоняет тесты в отдельной job и деплоит только если они
прошли. Конкурентные деплои сериализуются (`concurrency: deploy-production`) —
два выката в прод одновременно не пойдут.

### Ручной запуск

Actions → **Deploy** → **Run workflow** → выбрать цель (`all` / `api` / `worker`
/ `frontend` / `gateway` / `diarization`). Удобно, когда нужно выкатить только фронтенд без
пересборки функций.

---

## Настройка (делается один раз)

CI (тесты) работает сразу — ничего настраивать не нужно. А вот **Deploy**
требует доступов к Yandex Cloud. Шаги ниже выполняются **вручную тобой** —
создание сервисных аккаунтов и ключей нельзя и не нужно автоматизировать.

### Шаг 1. Deployer-сервисный аккаунт

`deploy.sh` обращается к YC от имени сервисного аккаунта. Нужен SA с правами на
выкатку. В консоли YC или через CLI:

```bash
# создать SA для деплоя
yc iam service-account create --name yaspeech-deployer

# роли: создавать версии функций и обновлять gateway
yc resource-manager folder add-access-binding <FOLDER_ID> \
  --role functions.editor \
  --service-account-name yaspeech-deployer
yc resource-manager folder add-access-binding <FOLDER_ID> \
  --role api-gateway.editor \
  --service-account-name yaspeech-deployer

# право назначать рантайм-SA (yaspeech-sa) на функции
yc iam service-account add-access-binding yaspeech-sa \
  --role iam.serviceAccounts.user \
  --service-account-name yaspeech-deployer
```

### Шаг 2. Авторизованный ключ деплоера

```bash
yc iam key create \
  --service-account-name yaspeech-deployer \
  --output deployer-key.json
```

Содержимое `deployer-key.json` целиком пойдёт в секрет `YC_SA_JSON_KEY`.
**Файл после этого удали — он больше не нужен на диске.**

### Шаг 3. Секреты в GitHub

Settings → Secrets and variables → **Actions** → New repository secret.

| Секрет | Что это | Откуда взять |
|--------|---------|--------------|
| `YC_SA_JSON_KEY` | Ключ деплоера (весь JSON) | `deployer-key.json` из шага 2 |
| `SA_ID` | ID рантайм-SA `yaspeech-sa` | `yc iam service-account get yaspeech-sa` |
| `FOLDER_ID` | ID каталога в YC | консоль / `yc config list` |
| `BUCKET` | Приватный бакет артефактов | напр. `yaspeech-artifacts` |
| `FRONTEND_BUCKET` | Публичный бакет фронтенда | напр. `yaspeech-frontend` |
| `QUEUE_URL` | URL очереди YMQ | консоль YMQ |
| `KEY_ID` | Статический access key (S3/YMQ) | ключ доступа SA |
| `SECRET` | Статический secret key | пара к `KEY_ID` |
| `SESSION_SECRET` | Соль для сессий | `openssl rand -hex 32` |
| `ADMIN_LOGIN` | Логин первого админа | любая строка |
| `HF_TOKEN` | HuggingFace-токен для сервиса диаризации (pyannote) | huggingface.co/settings/tokens, с принятыми условиями `pyannote/speaker-diarization-3.1` и `pyannote/wespeaker-voxceleb-resnet34-LM` |

> Это те же значения, что лежат в локальном `scripts/.env.deploy`. GitHub
> Actions подставит их как переменные окружения — `deploy.sh` умеет брать
> секреты и из файла (локально), и из окружения (в CI).

### Шаг 4. (Рекомендуется) Ручной approval на прод

Settings → Environments → **production** → включить **Required reviewers**.
Тогда каждый автодеплой будет ждать твоего подтверждения в интерфейсе — полезно,
пока доверие к пайплайну не устоялось.

---

## Как это работает под капотом

`deploy.yml` на job `deploy`:

1. ставит Node.js 18 и Python 3.11 + `boto3` (boto3 нужен для загрузки фронтенда
   в Object Storage);
2. устанавливает Yandex Cloud CLI в `$HOME/yandex-cloud`;
3. авторизует CLI ключом из `YC_SA_JSON_KEY` и задаёт `folder-id`;
4. запускает `bash scripts/deploy.sh <target>` с секретами в окружении.

Дальше всё делает [`deploy.sh`](../../../scripts/deploy.sh) — он же, что и при
ручном деплое (см. [cloud-deployment.md](./cloud-deployment.md)).

---

## Первый запуск: проверь, что работает

После настройки секретов:

1. Actions → **Deploy** → **Run workflow** → цель `frontend` (самое безопасное —
   не трогает функции).
2. Дождись зелёного прогона.
3. Открой прод-URL, проверь, что сайт отвечает.
4. Если ок — следующий push в `main` задеплоит автоматически.

Если упало — смотри логи шага в Actions. Частые причины: не хватает роли у
deployer-SA (шаг 1), опечатка в секрете, протухший ключ.

---

## Безопасность

- Ключ деплоера (`YC_SA_JSON_KEY`) даёт права на выкатку — храни только в GitHub
  Secrets, никогда в коде.
- Ротация ключей и реакция на утечку — в
  [iam-and-access.md](./iam-and-access.md).
- Workflow удаляет файл ключа после деплоя (`if: always()`), чтобы он не оседал
  в окружении runner'а.
