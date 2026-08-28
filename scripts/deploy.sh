#!/bin/bash
# YaSpeech deploy script
# Usage: ./scripts/deploy.sh [api|worker|all]
#
# Перед запуском скопируй scripts/.env.deploy.example → scripts/.env.deploy
# и заполни значениями. Файл .env.deploy НЕ коммитится в git.
set -e

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
  $YC serverless function version create \
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
    --service-account-id "$SA_ID" \
    2>&1 | grep -E "^\.\.\.done|^id:" | head -3
  echo "   ✓ api deployed"
}

deploy_worker() {
  echo "🚀 Deploying yaspeech-worker..."
  $YC serverless function version create \
    --function-name yaspeech-worker \
    --runtime nodejs22 \
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
