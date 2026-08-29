#!/bin/bash
# YaSpeech deploy script
# Usage: ./scripts/deploy.sh [api|worker|all]
#
# Перед запуском скопируй scripts/.env.deploy.example → scripts/.env.deploy
# и заполни значениями. Файл .env.deploy НЕ коммитится в git.
set -e
set -o pipefail

# Путь к yc CLI можно переопределить через окружение (нужно в CI, где CLI
# ставится в другое место). По умолчанию — стандартная установка для разработчика.
YC="${YC:-$HOME/yandex-cloud/bin/yc}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TARGET="${1:-all}"

# ── Источник секретов: файл .env.deploy ИЛИ переменные окружения ──────────────
# Локально — читаем из scripts/.env.deploy. В CI (GitHub Actions) файла нет,
# а переменные уже экспортированы из секретов — тогда просто пропускаем source.
ENV_FILE="$ROOT/scripts/.env.deploy"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck source=/dev/null
  source "$ENV_FILE"
elif [[ -z "${KEY_ID:-}" ]]; then
  echo "❌  Нет ни $ENV_FILE, ни переменных окружения с секретами."
  echo "    Локально: скопируй scripts/.env.deploy.example → scripts/.env.deploy."
  echo "    В CI: задай секреты как переменные окружения (см. docs .../ci-cd.md)."
  exit 1
fi

# Проверяем что все обязательные переменные заданы
: "${SA_ID:?Не задана переменная SA_ID в .env.deploy}"
: "${BUCKET:?Не задана переменная BUCKET в .env.deploy}"
: "${QUEUE_URL:?Не задана переменная QUEUE_URL в .env.deploy}"
: "${KEY_ID:?Не задана переменная KEY_ID в .env.deploy}"
: "${SECRET:?Не задана переменная SECRET в .env.deploy}"
: "${FOLDER_ID:?Не задана переменная FOLDER_ID в .env.deploy}"
: "${FRONTEND_BUCKET:?Не задана переменная FRONTEND_BUCKET в .env.deploy}"
: "${SESSION_SECRET:?Не задана переменная SESSION_SECRET в .env.deploy}"
: "${ADMIN_LOGIN:?Не задана переменная ADMIN_LOGIN в .env.deploy}"
: "${HF_TOKEN:?Не задана переменная HF_TOKEN в .env.deploy (нужен для pyannote-диаризации)}"
: "${DIARIZATION_QUEUE_URL:?Не задана переменная DIARIZATION_QUEUE_URL в .env.deploy}"
: "${DIARIZATION_QUEUE_ARN:?Не задана переменная DIARIZATION_QUEUE_ARN в .env.deploy}"
: "${DIARIZATION_QUEUE_URL_2:?Не задана переменная DIARIZATION_QUEUE_URL_2 в .env.deploy}"
: "${DIARIZATION_QUEUE_ARN_2:?Не задана переменная DIARIZATION_QUEUE_ARN_2 в .env.deploy}"
: "${DIARIZATION_QUEUE_URL_3:?Не задана переменная DIARIZATION_QUEUE_URL_3 в .env.deploy}"
: "${DIARIZATION_QUEUE_ARN_3:?Не задана переменная DIARIZATION_QUEUE_ARN_3 в .env.deploy}"

# ── Версия для cache-busting ──────────────────────────────────────────────────
# git-хэш + epoch: уникальна на каждый деплой, поэтому мобильные браузеры
# (которые кэшируют ассеты как immutable) гарантированно тянут свежий URL.
GIT_SHORT=$(git rev-parse --short HEAD 2>/dev/null || echo "dev")
VERSION="${GIT_SHORT}-$(date +%s)"
echo "📌 Версия: $VERSION"

# ── Сборка zip-архивов ────────────────────────────────────────────────────────
# Берём apps/server/src рекурсивно: новые модули (routes/* и т.п.) попадают
# в архив автоматически — раньше захардкоженный список файлов был источником
# ошибки «локально работает, в облаке падает на import».
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

deploy_api() {
  echo "🚀 Deploying yaspeech-api..."
  local output
  if ! output=$($YC serverless function version create \
    --function-name yaspeech-api \
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
    --environment DIARIZATION_QUEUE_URL="$DIARIZATION_QUEUE_URL" \
    --environment DIARIZATION_QUEUE_URL_2="$DIARIZATION_QUEUE_URL_2" \
    --environment DIARIZATION_QUEUE_URL_3="$DIARIZATION_QUEUE_URL_3" \
    --service-account-id "$SA_ID" 2>&1); then
    echo "$output"
    echo "❌ deploy_api failed" >&2
    exit 1
  fi
  echo "$output" | grep -E "^\.\.\.done|^id:" | head -3
  echo "   ✓ api deployed"
}

deploy_worker() {
  echo "🚀 Deploying yaspeech-worker..."
  local output
  # 600s (платформенный максимум для Cloud Functions), не 60s: generateProtocol
  # делает 12-20+ последовательных LLM-вызовов (B2×7 + C1×5 + QA, ещё больше
  # для длинных встреч через map-reduce) и, в отличие от runRefinePhase, НЕ
  # чекпоинтится — при 60s функцию убивает платформа посреди работы, и
  # обработка перезапускается с нуля на каждой redelivery до бесконечности
  # (реальный инцидент 2026-08-29: встреча "висела" час именно так).
  if ! output=$($YC serverless function version create \
    --function-name yaspeech-worker \
    --runtime nodejs22 \
    --entrypoint "apps/server/src/functions/worker-handler.index" \
    --memory 512m \
    --execution-timeout 600s \
    --source-path /tmp/worker.zip \
    --environment YC_STORAGE_BUCKET="$BUCKET" \
    --environment YC_QUEUE_URL="$QUEUE_URL" \
    --environment YMQ_KEY_ID="$KEY_ID" \
    --environment "YMQ_SECRET=$SECRET" \
    --environment YC_FOLDER_ID="$FOLDER_ID" \
    --environment DIARIZATION_QUEUE_URL="$DIARIZATION_QUEUE_URL" \
    --environment DIARIZATION_QUEUE_URL_2="$DIARIZATION_QUEUE_URL_2" \
    --environment DIARIZATION_QUEUE_URL_3="$DIARIZATION_QUEUE_URL_3" \
    --service-account-id "$SA_ID" 2>&1); then
    echo "$output"
    echo "❌ deploy_worker failed" >&2
    exit 1
  fi
  echo "$output" | grep -E "^\.\.\.done|^id:" | head -3
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
    """Подставляет VERSION вместо __BUILD__ в текстовых ассетах.

    Это критично для ES-module импортов внутри app/*.js: без версии в URL
    браузеры держали бы импортируемые модули в immutable-кэше навсегда.
    """
    ext = os.path.splitext(path)[1]
    with open(path, "rb") as f:
        body = f.read()
    if ext in (".js", ".css", ".html"):
        body = body.replace(b"__BUILD__", version.encode())
    return body

# index.html — всегда свежий (no-cache), точка входа для cache-busting
s3.put_object(
    Bucket=bucket, Key="index.html",
    Body=read_with_version("apps/web/index.html"),
    ContentType=CONTENT_TYPES[".html"],
    CacheControl="no-cache"
)
print("   ✓ index.html")

# Все ассеты app/ и lib/ — обходим директории целиком, чтобы новые
# модули нельзя было забыть добавить в список вручную.
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

deploy_diarization() {
  local REPO="crp68puemkf30m3ufjhg/yaspeech-diar-pyannote-cpu"
  local IMAGE="cr.yandex/${REPO}:latest"

  echo "🧠 Building diarization image..."
  docker build -t "$IMAGE" apps/diarization-service

  echo "🔐 Authenticating to Container Registry..."
  $YC container registry configure-docker

  echo "📤 Pushing image..."
  docker push "$IMAGE"

  echo "🚀 Deploying yaspeech-diarization container..."
  # create падает, если контейнер с таким именем уже есть — это ожидаемо
  # при повторных деплоях, не считаем ошибкой.
  $YC serverless container create --name yaspeech-diarization >/dev/null 2>&1 || true

  local output
  # --container-id (не --container-name): резолвинг имени в id требует
  # права на листинг контейнеров в папке, которых у деплоер-SA может не
  # быть, даже когда конкретные права на сам ресурс есть.
  if ! output=$($YC serverless container revision deploy \
    --container-id bbaeste93e4dpg7h4d99 \
    --image "$IMAGE" \
    --memory 4GB \
    --cores 2 \
    --execution-timeout 3600s \
    --concurrency 1 \
    --zone-instances-limit 3 \
    --environment STORAGE_KEY_ID="$KEY_ID" \
    --environment "STORAGE_SECRET=$SECRET" \
    --environment STORAGE_BUCKET="$BUCKET" \
    --environment "HF_TOKEN=$HF_TOKEN" \
    --service-account-id "$SA_ID" 2>&1); then
    echo "$output"
    echo "❌ deploy_diarization failed" >&2
    exit 1
  fi
  echo "$output" | grep -E "^\.\.\.done|^id:" | head -3
  echo "   ✓ diarization container deployed"

  # YMQ-триггер держит соединение с контейнером открытым на всё время
  # обработки одного сообщения (см. apps/diarization-service/server.py) —
  # без него диаризация не досчитывается (Serverless Container не держит
  # фоновый поток между HTTP-запросами). Создаём один раз, идемпотентно.
  #
  # Три очереди/триггера вместо одной: YMQ-триггер — последовательный
  # consumer (держит одно сообщение за раз), и Yandex Cloud запрещает вешать
  # второй триггер на ту же очередь. Реальный параллелизм — только через
  # round-robin по нескольким независимым очередям (см. pyannote-diarization.js).
  MSYS_NO_PATHCONV=1 $YC serverless trigger create message-queue yaspeech-diarization-trigger \
    --queue "$DIARIZATION_QUEUE_ARN" \
    --queue-service-account-id "$SA_ID" \
    --batch-size 1 \
    --invoke-container-id bbaeste93e4dpg7h4d99 \
    --invoke-container-path /process \
    --invoke-container-service-account-id "$SA_ID" >/dev/null 2>&1 || true

  MSYS_NO_PATHCONV=1 $YC serverless trigger create message-queue yaspeech-diarization-trigger-2 \
    --queue "$DIARIZATION_QUEUE_ARN_2" \
    --queue-service-account-id "$SA_ID" \
    --batch-size 1 \
    --invoke-container-id bbaeste93e4dpg7h4d99 \
    --invoke-container-path /process \
    --invoke-container-service-account-id "$SA_ID" >/dev/null 2>&1 || true

  MSYS_NO_PATHCONV=1 $YC serverless trigger create message-queue yaspeech-diarization-trigger-3 \
    --queue "$DIARIZATION_QUEUE_ARN_3" \
    --queue-service-account-id "$SA_ID" \
    --batch-size 1 \
    --invoke-container-id bbaeste93e4dpg7h4d99 \
    --invoke-container-path /process \
    --invoke-container-service-account-id "$SA_ID" >/dev/null 2>&1 || true
}

update_gateway() {
  local SPEC="$ROOT/infra/api-gateway.yaml"
  if [[ -f "$SPEC" ]]; then
    echo "🌐 Updating API Gateway..."
    local output
    if ! output=$($YC serverless api-gateway update --name yaspeech-gateway --spec "$SPEC" 2>&1); then
      echo "$output"
      echo "❌ update_gateway failed" >&2
      exit 1
    fi
    echo "$output" | grep -E "^\.\.\.done|^id:" | head -3
    echo "   ✓ gateway updated"
  else
    echo "   ⚠️  infra/api-gateway.yaml not found, skipping gateway update"
  fi
}

case "$TARGET" in
  api)
    build_api
    deploy_api
    upload_frontend
    update_gateway
    ;;
  worker)
    build_worker
    deploy_worker
    ;;
  gateway)
    update_gateway
    ;;
  frontend|web)
    upload_frontend
    ;;
  diarization)
    deploy_diarization
    ;;
  all|*)
    deploy_diarization
    build_api
    deploy_api
    build_worker
    deploy_worker
    upload_frontend
    update_gateway
    ;;
esac

echo ""
echo "✅ Deploy complete! (v=$VERSION)"
