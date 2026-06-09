#!/bin/bash
# YaSpeech deploy script
# Usage: ./scripts/deploy.sh [api|worker|all]
#
# Перед запуском скопируй scripts/.env.deploy.example → scripts/.env.deploy
# и заполни значениями. Файл .env.deploy НЕ коммитится в git.
set -e

YC=~/yandex-cloud/bin/yc
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TARGET="${1:-all}"

# ── Загружаем секреты из .env.deploy ─────────────────────────────────────────
ENV_FILE="$ROOT/scripts/.env.deploy"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "❌  Файл $ENV_FILE не найден."
  echo "    Скопируй scripts/.env.deploy.example → scripts/.env.deploy и заполни значения."
  exit 1
fi
# shellcheck source=/dev/null
source "$ENV_FILE"

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

# ── Версия для cache-busting ──────────────────────────────────────────────────
# git-хэш + epoch: уникальна на каждый деплой, поэтому мобильные браузеры
# (которые кэшируют ассеты как immutable) гарантированно тянут свежий URL.
GIT_SHORT=$(git rev-parse --short HEAD 2>/dev/null || echo "dev")
VERSION="${GIT_SHORT}-$(date +%s)"
echo "📌 Версия: $VERSION"

# ── Список файлов для обеих функций ──────────────────────────────────────────
SHARED_FILES=(
  package.json
  apps/server/src/functions/make-deps.js
  apps/server/src/server/create-http-handler.js
  apps/server/src/shared/http.js
  apps/server/src/shared/sign-v4.js
  apps/server/src/shared/logger.js
  apps/server/src/shared/iam-token.js
  apps/server/src/shared/password.js
  apps/server/src/shared/session.js
  apps/server/src/application/meeting-pipeline-service.js
  apps/server/src/application/transcript-postprocessor.js
  apps/server/src/application/transcription/chunker.js
  apps/server/src/infrastructure/yc-artifact-storage.js
  apps/server/src/infrastructure/yc-project-repository.js
  apps/server/src/infrastructure/yc-meeting-repository.js
  apps/server/src/infrastructure/yc-user-repository.js
  apps/server/src/infrastructure/ymq-queue-runner.js
  apps/server/src/infrastructure/mock-speech-kit-gateway.js
  apps/server/src/infrastructure/mock-yandex-gpt-gateway.js
  apps/server/src/infrastructure/yc-speech-kit-gateway.js
  apps/server/src/infrastructure/yc-yandex-gpt-gateway.js
  apps/server/src/infrastructure/smart-asr-gateway.js
  apps/server/src/infrastructure/groq-whisper-gateway.js
  apps/server/src/infrastructure/pyannote-diarization.js
  apps/server/src/infrastructure/llm/yandex-gpt-client.js
  apps/server/src/infrastructure/llm/prompts.js
)

build_api() {
  echo "📦 Building api.zip..."
  rm -f /tmp/api.zip
  zip /tmp/api.zip apps/server/src/functions/api-handler.js "${SHARED_FILES[@]}"
  zip -r /tmp/api.zip packages/core/src/ apps/web/
  echo "   $(du -sh /tmp/api.zip | cut -f1)"
}

build_worker() {
  echo "📦 Building worker.zip..."
  rm -f /tmp/worker.zip
  zip /tmp/worker.zip apps/server/src/functions/worker-handler.js "${SHARED_FILES[@]}"
  zip -r /tmp/worker.zip packages/core/src/
  echo "   $(du -sh /tmp/worker.zip | cut -f1)"
}

deploy_api() {
  echo "🚀 Deploying yaspeech-api..."
  $YC serverless function version create \
    --function-name yaspeech-api \
    --runtime nodejs18 \
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
    2>&1 | grep -E "^\.\.\.done|^id:" | head -3
  echo "   ✓ api deployed"
}

deploy_worker() {
  echo "🚀 Deploying yaspeech-worker..."
  $YC serverless function version create \
    --function-name yaspeech-worker \
    --runtime nodejs18 \
    --entrypoint "apps/server/src/functions/worker-handler.index" \
    --memory 512m \
    --execution-timeout 60s \
    --source-path /tmp/worker.zip \
    --environment YC_STORAGE_BUCKET="$BUCKET" \
    --environment YC_QUEUE_URL="$QUEUE_URL" \
    --environment YMQ_KEY_ID="$KEY_ID" \
    --environment "YMQ_SECRET=$SECRET" \
    --environment YC_FOLDER_ID="$FOLDER_ID" \
    --service-account-id "$SA_ID" \
    2>&1 | grep -E "^\.\.\.done|^id:" | head -3
  echo "   ✓ worker deployed"
}

upload_frontend() {
  echo "📤 Uploading frontend to $FRONTEND_BUCKET (v=$VERSION)..."

  # Подставляем версию в index.html (из плейсхолдера __BUILD__)
  TMP_HTML=$(mktemp /tmp/yaspeech-index-XXXXXX.html)
  sed "s/__BUILD__/$VERSION/g" apps/web/index.html > "$TMP_HTML"

  python3 - "$TMP_HTML" "$KEY_ID" "$SECRET" "$FRONTEND_BUCKET" "$VERSION" <<'PYEOF'
import sys, boto3

tmp_html, key_id, secret, bucket, version = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]

s3 = boto3.Session(
    aws_access_key_id=key_id,
    aws_secret_access_key=secret,
    region_name="ru-central1"
).client("s3", endpoint_url="https://storage.yandexcloud.net")

# index.html — всегда свежий
with open(tmp_html, "rb") as f:
    s3.put_object(
        Bucket=bucket, Key="index.html", Body=f.read(),
        ContentType="text/html; charset=utf-8",
        CacheControl="no-cache"
    )
print("   ✓ index.html")

# Статические ассеты — кэшируем агрессивно (URL версионирован)
assets = {
    "app/app.js":                         ("apps/web/app/app.js",                    "application/javascript; charset=utf-8"),
    "app/styles.css":                     ("apps/web/app/styles.css",                "text/css; charset=utf-8"),
    "app/ui-model.js":                    ("apps/web/app/ui-model.js",               "application/javascript; charset=utf-8"),
    "app/audio/preprocessor.js":          ("apps/web/app/audio/preprocessor.js",     "application/javascript; charset=utf-8"),
    "app/audio/quality-analyzer.js":      ("apps/web/app/audio/quality-analyzer.js", "application/javascript; charset=utf-8"),
    "lib/react.production.min.js":        ("apps/web/lib/react.production.min.js",   "application/javascript; charset=utf-8"),
    "lib/react-dom.production.min.js":    ("apps/web/lib/react-dom.production.min.js", "application/javascript; charset=utf-8"),
    "lib/htm.umd.js":                     ("apps/web/lib/htm.umd.js",               "application/javascript; charset=utf-8"),
}
for key, (path, ct) in assets.items():
    with open(path, "rb") as f:
        s3.put_object(
            Bucket=bucket, Key=key, Body=f.read(),
            ContentType=ct,
            CacheControl="public, max-age=31536000, immutable"
        )
    print(f"   ✓ {key}")
PYEOF

  rm -f "$TMP_HTML"
}

update_gateway() {
  local SPEC="$ROOT/infra/api-gateway.yaml"
  if [[ -f "$SPEC" ]]; then
    echo "🌐 Updating API Gateway..."
    $YC serverless api-gateway update --name yaspeech-gateway --spec "$SPEC" \
      2>&1 | grep -E "^\.\.\.done|^id:" | head -3
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
  all|*)
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
