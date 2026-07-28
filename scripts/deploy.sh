#!/bin/bash
# YaSpeech deploy script
#
# Первый запуск в новом облаке:
#   1. Заполни scripts/.env.deploy (FOLDER_ID, BUCKET, FRONTEND_BUCKET, SESSION_SECRET, ADMIN_LOGIN, ADMIN_PASSWORD)
#   2. bash scripts/deploy.sh bootstrap   # создаёт ресурсы, дописывает SA_ID/KEY_ID/SECRET/QUEUE_URL в .env.deploy
#   3. bash scripts/deploy.sh all         # деплоит функции + фронтенд + шлюз
#
# Обычный деплой после изменений кода:
#   bash scripts/deploy.sh all
#   bash scripts/deploy.sh api      # api + фронтенд + шлюз
#   bash scripts/deploy.sh worker   # только worker
#   bash scripts/deploy.sh gateway  # только шлюз
#
# Зависимости: yc CLI, jq, gettext (envsubst), python3 + boto3
set -e

YC="${YC:-$HOME/yandex-cloud/bin/yc}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TARGET="${1:-all}"

# ── Имена ресурсов (переопределяемые для разных стендов) ─────────────────────
# Переопредели через окружение, чтобы два стенда не конфликтовали по именам:
#   SA_NAME=yaspeech-staging bash scripts/deploy.sh all
SA_NAME="${SA_NAME:-yaspeech-sa}"
QUEUE_NAME="${QUEUE_NAME:-yaspeech-queue}"
FUNCTION_API_NAME="${FUNCTION_API_NAME:-yaspeech-api}"
FUNCTION_WORKER_NAME="${FUNCTION_WORKER_NAME:-yaspeech-worker}"
GATEWAY_NAME="${GATEWAY_NAME:-yaspeech-gateway}"

# ── Источник секретов ─────────────────────────────────────────────────────────
ENV_FILE="$ROOT/scripts/.env.deploy"
if [[ -f "$ENV_FILE" ]]; then
  # Читаем построчно: безопасно для значений со спецсимволами (&, $, пробелы)
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ -z "$line" ]] && continue
    key="${line%%=*}"
    value="${line#*=}"
    [[ -n "$key" ]] && export "$key"="$value"
  done < "$ENV_FILE"
elif [[ -z "${FOLDER_ID:-}" ]]; then
  echo "❌  Нет ни $ENV_FILE, ни переменных окружения."
  echo "    Скопируй scripts/.env.deploy.example → scripts/.env.deploy и заполни."
  exit 1
fi

# ── Запись/обновление строки в .env.deploy ───────────────────────────────────
update_env_deploy() {
  local key="$1" value="$2"
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "${key}=${value}" > "$ENV_FILE"
    return
  fi
  if grep -q "^${key}=" "$ENV_FILE"; then
    # BSD sed (macOS) и GNU sed — оба поддерживают -i '' (BSD) или -i (GNU)
    if sed --version 2>/dev/null | grep -q GNU; then
      sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
    else
      sed -i '' "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
    fi
  else
    echo "${key}=${value}" >> "$ENV_FILE"
  fi
}

# ── Bootstrap: создать облачные ресурсы «если ещё нет» ───────────────────────
do_bootstrap() {
  : "${FOLDER_ID:?Заполни FOLDER_ID в $ENV_FILE}"

  # Проверяем зависимости
  for dep in jq envsubst; do
    command -v "$dep" >/dev/null 2>&1 || {
      echo "❌  Не найдена утилита '$dep'."
      echo "    macOS:  brew install jq gettext && brew link --force gettext"
      echo "    Debian: apt-get install jq gettext-base"
      exit 1
    }
  done

  echo "🔧 Bootstrap в каталоге $FOLDER_ID…"

  # 1. Сервисный аккаунт
  echo ""
  echo "── 1/5  Сервисный аккаунт ──────────────────────────────────────────────"
  if $YC iam service-account get --name "$SA_NAME" --folder-id "$FOLDER_ID" \
       >/dev/null 2>&1; then
    echo "   ✓ SA '$SA_NAME' уже существует"
  else
    $YC iam service-account create --name "$SA_NAME" --folder-id "$FOLDER_ID" \
      >/dev/null
    echo "   ✓ SA '$SA_NAME' создан"
  fi
  SA_ID=$($YC iam service-account get --name "$SA_NAME" \
           --folder-id "$FOLDER_ID" --format json | jq -r '.id')
  update_env_deploy "SA_ID" "$SA_ID"
  echo "   SA_ID=$SA_ID"

  # 2. Роли сервисного аккаунта
  echo ""
  echo "── 2/5  Роли SA ────────────────────────────────────────────────────────"
  local roles=(
    storage.editor          # Object Storage: читать/писать артефакты и фронтенд
    ymq.admin               # YMQ: создавать очередь, писать/читать сообщения
    ai.speechkit-stt.user   # SpeechKit STT
    ai.languageModels.user  # YandexGPT
    serverless.functions.invoker  # API Gateway → вызов функции
  )
  for role in "${roles[@]}"; do
    # NB: этот yc принимает --id для указания папки в add-access-binding,
    # НЕ --folder-id (тот молча игнорируется, а `|| true` глушит ошибку).
    $YC resource-manager folder add-access-binding \
      --id "$FOLDER_ID" \
      --role "$role" \
      --service-account-id "$SA_ID" \
      >/dev/null
    echo "   ✓ $role"
  done

  # 3. Статический ключ доступа (KEY_ID/SECRET)
  echo ""
  echo "── 3/5  Статический ключ (S3 + YMQ) ───────────────────────────────────"
  if [[ -n "${KEY_ID:-}" ]]; then
    echo "   ✓ KEY_ID уже задан ($KEY_ID), пропускаю создание"
  else
    KEY_JSON=$($YC iam access-key create \
      --service-account-id "$SA_ID" \
      --folder-id "$FOLDER_ID" \
      --format json)
    KEY_ID=$(echo "$KEY_JSON" | jq -r '.access_key.key_id')
    SECRET=$(echo "$KEY_JSON" | jq -r '.secret')
    update_env_deploy "KEY_ID" "$KEY_ID"
    update_env_deploy "SECRET" "$SECRET"
    echo "   ✓ KEY_ID=$KEY_ID"
    echo "   ⚠️  SECRET записан в $ENV_FILE — больше не показывается"
  fi

  # 4. Бакеты
  echo ""
  echo "── 4/5  Object Storage бакеты ──────────────────────────────────────────"
  : "${BUCKET:?Заполни BUCKET в $ENV_FILE}"
  : "${FRONTEND_BUCKET:?Заполни FRONTEND_BUCKET в $ENV_FILE}"
  for bucket_name in "$BUCKET" "$FRONTEND_BUCKET"; do
    if $YC storage bucket get --name "$bucket_name" \
         --folder-id "$FOLDER_ID" >/dev/null 2>&1; then
      echo "   ✓ бакет '$bucket_name' уже существует"
    else
      $YC storage bucket create --name "$bucket_name" \
        --folder-id "$FOLDER_ID" >/dev/null
      echo "   ✓ бакет '$bucket_name' создан"
    fi
  done

  # 5. YMQ очередь
  # У yc CLI нет команды управления YMQ (`message-queue`/`ymq` отсутствуют
  # как минимум в 1.11–1.16) — очередь создаётся через SQS-совместимый API.
  echo ""
  echo "── 5/5  YMQ очередь ────────────────────────────────────────────────────"
  command -v python3 >/dev/null 2>&1 || { echo "❌  Нужен python3+boto3."; exit 1; }
  QUEUE_URL=$(python3 - "$KEY_ID" "$SECRET" "$QUEUE_NAME" <<'PYEOF'
import sys, boto3, botocore
key_id, secret, queue_name = sys.argv[1], sys.argv[2], sys.argv[3]
sqs = boto3.Session(
    aws_access_key_id=key_id, aws_secret_access_key=secret, region_name="ru-central1"
).client("sqs", endpoint_url="https://message-queue.api.cloud.yandex.net")
  # VisibilityTimeout ДОЛЖЕН быть >= execution-timeout воркера (см. deploy_worker):
  # иначе сообщение "оживает" раньше, чем убьётся зависшая функция — другая
  # копия воркера подхватит ту же задачу, и они будут работать параллельно
  # над одним и тем же чекпоинтом. 320s = 300s таймаут функции + запас.
  # Атрибуты выставляются всегда (не только при первом создании) — иначе
  # на уже существующих стендах остаётся старое значение (60s).
try:
    url = sqs.get_queue_url(QueueName=queue_name)["QueueUrl"]
except botocore.exceptions.ClientError:
    url = sqs.create_queue(
        QueueName=queue_name,
        Attributes={"VisibilityTimeout": "320", "MessageRetentionPeriod": "3600"},
    )["QueueUrl"]
sqs.set_queue_attributes(QueueUrl=url, Attributes={"VisibilityTimeout": "320"})
print(url)
PYEOF
)
  update_env_deploy "QUEUE_URL" "$QUEUE_URL"
  echo "   QUEUE_URL=$QUEUE_URL"

  # 6. Заглушки-функции (контейнеры без кода — код загрузит deploy)
  echo ""
  echo "── Функции (контейнеры) ────────────────────────────────────────────────"
  for fn_name in "$FUNCTION_API_NAME" "$FUNCTION_WORKER_NAME"; do
    if $YC serverless function get --name "$fn_name" \
         --folder-id "$FOLDER_ID" >/dev/null 2>&1; then
      echo "   ✓ функция '$fn_name' уже существует"
    else
      $YC serverless function create --name "$fn_name" \
        --folder-id "$FOLDER_ID" >/dev/null
      echo "   ✓ функция '$fn_name' создана"
    fi
  done

  # 7. YMQ-триггер на worker — БЕЗ него пайплайн мёртв: сообщения копятся
  # в очереди, а worker никогда не запускается (встречи вечно «uploaded»).
  # Исторически создавался руками и потому терялся при переезде в новое облако.
  echo ""
  echo "── Триггер очереди → worker ────────────────────────────────────────────"
  # Имя совпадает с уже существующими стендами (yaspeech-worker-trigger),
  # иначе повторный bootstrap создаст второй триггер и обработку в два потока
  local TRIGGER_NAME="${FUNCTION_WORKER_NAME}-trigger"
  if $YC serverless trigger get --name "$TRIGGER_NAME" \
       --folder-id "$FOLDER_ID" >/dev/null 2>&1; then
    echo "   ✓ триггер '$TRIGGER_NAME' уже существует"
  else
    $YC serverless trigger create message-queue \
      --name "$TRIGGER_NAME" \
      --folder-id "$FOLDER_ID" \
      --queue "yrn:yc:ymq:ru-central1:${FOLDER_ID}:${QUEUE_NAME}" \
      --queue-service-account-id "$SA_ID" \
      --invoke-function-name "$FUNCTION_WORKER_NAME" \
      --invoke-function-service-account-id "$SA_ID" \
      --batch-size 1 \
      --batch-cutoff 0s >/dev/null
    echo "   ✓ триггер '$TRIGGER_NAME' создан"
  fi

  echo ""
  echo "✅ Bootstrap завершён. .env.deploy дополнен значениями SA_ID/KEY_ID/SECRET/QUEUE_URL."
  echo ""
  echo "   Следующий шаг: bash scripts/deploy.sh all"
}

# ── Версия для cache-busting ──────────────────────────────────────────────────
GIT_SHORT=$(git rev-parse --short HEAD 2>/dev/null || echo "dev")
VERSION="${GIT_SHORT}-$(date +%s)"

# ── Сборка zip-архивов ────────────────────────────────────────────────────────
build_api() {
  echo "📦 Building api.zip..."
  rm -f /tmp/api.zip
  zip -q -r /tmp/api.zip package.json apps/server/src/ packages/core/src/ apps/web/ \
    -x "apps/web/tests/*"
  echo "   $(du -sh /tmp/api.zip | cut -f1)"
}

build_worker() {
  echo "📦 Building worker.zip..."
  rm -f /tmp/worker.zip
  zip -q -r /tmp/worker.zip package.json apps/server/src/ packages/core/src/
  echo "   $(du -sh /tmp/worker.zip | cut -f1)"
}

# ── Проверка переменных для деплоя ───────────────────────────────────────────
check_deploy_vars() {
  : "${SA_ID:?Не задана SA_ID — запусти сначала: deploy.sh bootstrap}"
  : "${BUCKET:?Не задана BUCKET в $ENV_FILE}"
  : "${QUEUE_URL:?Не задана QUEUE_URL — запусти сначала: deploy.sh bootstrap}"
  : "${KEY_ID:?Не задана KEY_ID — запусти сначала: deploy.sh bootstrap}"
  : "${SECRET:?Не задана SECRET — запусти сначала: deploy.sh bootstrap}"
  : "${FOLDER_ID:?Не задана FOLDER_ID в $ENV_FILE}"
  : "${FRONTEND_BUCKET:?Не задана FRONTEND_BUCKET в $ENV_FILE}"
  : "${SESSION_SECRET:?Не задана SESSION_SECRET в $ENV_FILE}"
  : "${ADMIN_LOGIN:?Не задана ADMIN_LOGIN в $ENV_FILE}"
  echo "📌 Версия: $VERSION"
}

deploy_api() {
  echo "🚀 Deploying $FUNCTION_API_NAME..."
  # --folder-id обязателен: без него yc резолвит имя функции в дефолтной
  # папке активного профиля, а не в $FOLDER_ID из .env.deploy — если там
  # тоже есть функция с таким именем (другой стенд/прод), задеплоится не туда.
  $YC serverless function version create \
    --folder-id "$FOLDER_ID" \
    --function-name "$FUNCTION_API_NAME" \
    --runtime nodejs22 \
    --entrypoint "apps/server/src/functions/api-handler.index" \
    --memory 256m \
    --execution-timeout 30s \
    --source-path /tmp/api.zip \
    --environment YC_STORAGE_BUCKET="$BUCKET" \
    --environment YC_QUEUE_URL="$QUEUE_URL" \
    --environment YMQ_KEY_ID="$KEY_ID" \
    --environment "YMQ_SECRET=$SECRET" \
    --environment YC_FOLDER_ID="$FOLDER_ID" \
    --environment "SESSION_SECRET=$SESSION_SECRET" \
    --environment ADMIN_LOGIN="$ADMIN_LOGIN" \
    --service-account-id "$SA_ID" \
    > /tmp/deploy-api.out 2>&1 || { cat /tmp/deploy-api.out; exit 1; }
  grep -E "^\.\.\.done|^id:" /tmp/deploy-api.out | head -3
  echo "   ✓ api deployed"
}

deploy_worker() {
  echo "🚀 Deploying $FUNCTION_WORKER_NAME..."
  # 300s (не 60s!): REFINE/DIALOGUE-джобы чекпоинтятся по REFINE_TIME_BUDGET_MS
  # (200s) и сами себя пере-enqueue'ят — но только если функция доживает до
  # проверки бюджета. При 60s таймауте она может быть убита прямо посреди
  # одного (особенно на Pro-модели, дороже и медленнее Lite) вызова LLM, ДО
  # чекпоинта — вся оплаченная работа теряется. 300s даёт запас над 200s.
  $YC serverless function version create \
    --folder-id "$FOLDER_ID" \
    --function-name "$FUNCTION_WORKER_NAME" \
    --runtime nodejs22 \
    --entrypoint "apps/server/src/functions/worker-handler.index" \
    --memory 512m \
    --execution-timeout 300s \
    --source-path /tmp/worker.zip \
    --environment YC_STORAGE_BUCKET="$BUCKET" \
    --environment YC_QUEUE_URL="$QUEUE_URL" \
    --environment YMQ_KEY_ID="$KEY_ID" \
    --environment "YMQ_SECRET=$SECRET" \
    --environment YC_FOLDER_ID="$FOLDER_ID" \
    --service-account-id "$SA_ID" \
    > /tmp/deploy-worker.out 2>&1 || { cat /tmp/deploy-worker.out; exit 1; }
  grep -E "^\.\.\.done|^id:" /tmp/deploy-worker.out | head -3
  echo "   ✓ worker deployed"
}

upload_frontend() {
  echo "📤 Uploading frontend to $FRONTEND_BUCKET (v=$VERSION)..."

  python3 - "$KEY_ID" "$SECRET" "$FRONTEND_BUCKET" "$VERSION" <<'PYEOF'
import sys, os, boto3

key_id, secret, bucket, version = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]

s3 = boto3.Session(
    aws_access_key_id=key_id,
    aws_secret_access_key=secret,
    region_name="ru-central1"
).client("s3", endpoint_url="https://storage.yandexcloud.net")

CONTENT_TYPES = {
    ".js":   "application/javascript; charset=utf-8",
    ".css":  "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".svg":  "image/svg+xml; charset=utf-8",
}

def read_with_version(path):
    ext = os.path.splitext(path)[1]
    with open(path, "rb") as f:
        body = f.read()
    if ext in (".js", ".css", ".html"):
        body = body.replace(b"__BUILD__", version.encode())
    return body

s3.put_object(
    Bucket=bucket, Key="index.html",
    Body=read_with_version("apps/web/index.html"),
    ContentType=CONTENT_TYPES[".html"],
    CacheControl="no-cache"
)
print("   ✓ index.html")

for root_dir, key_prefix in (("apps/web/app", "app"), ("apps/web/lib", "lib")):
    for dirpath, _dirs, files in os.walk(root_dir):
        for name in sorted(files):
            if name.startswith("."):
                continue
            path = os.path.join(dirpath, name)
            rel = os.path.relpath(path, root_dir)
            key = f"{key_prefix}/{rel}"
            ext = os.path.splitext(name)[1]
            s3.put_object(
                Bucket=bucket, Key=key,
                Body=read_with_version(path),
                ContentType=CONTENT_TYPES.get(ext, "application/octet-stream"),
                CacheControl="public, max-age=31536000, immutable"
            )
            print(f"   ✓ {key}")
PYEOF
}

update_gateway() {
  local TPL="$ROOT/infra/api-gateway.yaml.tpl"
  if [[ ! -f "$TPL" ]]; then
    echo "   ⚠️  infra/api-gateway.yaml.tpl not found, skipping gateway update"
    return
  fi

  # Проверяем зависимости
  command -v jq >/dev/null 2>&1 || { echo "❌  jq не найден. brew install jq / apt-get install jq"; exit 1; }
  command -v envsubst >/dev/null 2>&1 || { echo "❌  envsubst не найден. brew install gettext && brew link --force gettext / apt-get install gettext-base"; exit 1; }

  echo "🌐 Rendering & updating API Gateway ($GATEWAY_NAME)..."

  # Резолвим ID функции динамически — его нет до деплоя
  export API_FUNCTION_ID
  API_FUNCTION_ID=$($YC serverless function get --name "$FUNCTION_API_NAME" \
    --folder-id "$FOLDER_ID" --format json | jq -r '.id')

  export SA_ID FRONTEND_BUCKET
  envsubst '${API_FUNCTION_ID} ${SA_ID} ${FRONTEND_BUCKET}' \
    < "$TPL" > /tmp/api-gateway.yaml

  # Вывод — в файл, не в пайп: пайп через grep глотает код возврата yc,
  # и скрипт печатал «✓» даже при упавшем деплое шлюза
  if $YC serverless api-gateway get --name "$GATEWAY_NAME" \
       --folder-id "$FOLDER_ID" >/dev/null 2>&1; then
    $YC serverless api-gateway update \
      --name "$GATEWAY_NAME" \
      --folder-id "$FOLDER_ID" \
      --spec /tmp/api-gateway.yaml \
      > /tmp/deploy-gateway.out 2>&1 || { cat /tmp/deploy-gateway.out; exit 1; }
    grep -E "^\.\.\.done|^id:" /tmp/deploy-gateway.out | head -3
    echo "   ✓ gateway updated"
  else
    $YC serverless api-gateway create \
      --name "$GATEWAY_NAME" \
      --folder-id "$FOLDER_ID" \
      --spec /tmp/api-gateway.yaml \
      > /tmp/deploy-gateway.out 2>&1 || { cat /tmp/deploy-gateway.out; exit 1; }
    grep -E "^\.\.\.done|^id:" /tmp/deploy-gateway.out | head -3
    echo "   ✓ gateway created"
    GW_URL=$($YC serverless api-gateway get --name "$GATEWAY_NAME" \
      --folder-id "$FOLDER_ID" --format json | jq -r '.domain')
    echo ""
    echo "   🌍 URL шлюза: https://${GW_URL}"
  fi

  ensure_bucket_cors
}

# CORS на бакете артефактов: браузер льёт аудио напрямую в Object Storage
# по presigned URL — без CORS с домена шлюза PUT блокируется (xhr.onerror,
# в UI «Ошибка загрузки файла»). Настраивается здесь, а не в bootstrap,
# потому что домен шлюза известен только после его создания.
ensure_bucket_cors() {
  local GW_DOMAIN
  GW_DOMAIN=$($YC serverless api-gateway get --name "$GATEWAY_NAME" \
    --folder-id "$FOLDER_ID" --format json | jq -r '.domain')

  echo "🔓 Ensuring CORS on $BUCKET for https://${GW_DOMAIN}..."
  python3 - "$KEY_ID" "$SECRET" "$BUCKET" "https://${GW_DOMAIN}" <<'PYEOF'
import sys, boto3
key_id, secret, bucket, origin = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
s3 = boto3.Session(
    aws_access_key_id=key_id, aws_secret_access_key=secret, region_name="ru-central1"
).client("s3", endpoint_url="https://storage.yandexcloud.net")
s3.put_bucket_cors(
    Bucket=bucket,
    CORSConfiguration={"CORSRules": [{
        "AllowedOrigins": [origin],
        "AllowedMethods": ["PUT", "GET", "HEAD"],
        "AllowedHeaders": ["*"],
        "MaxAgeSeconds": 3600,
    }]},
)
print("   ✓ CORS настроен")
PYEOF
}

# ── Команды ───────────────────────────────────────────────────────────────────
case "$TARGET" in
  bootstrap)
    do_bootstrap
    ;;
  api)
    check_deploy_vars
    build_api
    deploy_api
    upload_frontend
    update_gateway
    ;;
  worker)
    check_deploy_vars
    build_worker
    deploy_worker
    ;;
  gateway)
    check_deploy_vars
    update_gateway
    ;;
  frontend|web)
    check_deploy_vars
    upload_frontend
    ;;
  all|*)
    check_deploy_vars
    build_api
    deploy_api
    build_worker
    deploy_worker
    upload_frontend
    update_gateway
    ;;
esac

[[ "$TARGET" != "bootstrap" ]] && echo "" && echo "✅ Deploy complete! (v=$VERSION)"
