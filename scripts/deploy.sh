#!/bin/bash
# YaSpeech deploy script
# Usage: ./scripts/deploy.sh [api|worker|all]
set -e

YC=~/yandex-cloud/bin/yc
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TARGET="${1:-all}"

# ── environment ──────────────────────────────────────────────
SA_ID="ajesrklt6nieo3idkus2"
BUCKET="yaspeech-artifacts"
QUEUE_URL="https://message-queue.api.cloud.yandex.net/b1gbt4f8teak4qu5r9qc/dj60000000nodhlg00p3/yaspeech-meetings"
KEY_ID="YCAJEczgB9wh9S_VPL4FSwyPN"
SECRET="YCM_4pVKwi_cDNGcgZpFOZ_ewoygqWTUyxL7elQq"
FOLDER_ID="b1gu902hilj9930q2ebn"
API_KEY="f403d7a06f56dbdd9e5ede22a468091f4b494f995c452ae9"

SHARED_FILES=(
  package.json
  apps/server/src/functions/make-deps.js
  apps/server/src/server/create-http-handler.js
  apps/server/src/shared/http.js
  apps/server/src/shared/sign-v4.js
  apps/server/src/shared/logger.js
  apps/server/src/shared/iam-token.js
  apps/server/src/application/meeting-pipeline-service.js
  apps/server/src/application/transcript-postprocessor.js
  apps/server/src/application/transcription/chunker.js
  apps/server/src/infrastructure/yc-artifact-storage.js
  apps/server/src/infrastructure/yc-project-repository.js
  apps/server/src/infrastructure/yc-meeting-repository.js
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
    --environment API_KEY="$API_KEY" \
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
    --execution-timeout 600s \
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

case "$TARGET" in
  api)
    build_api
    deploy_api
    ;;
  worker)
    build_worker
    deploy_worker
    ;;
  all|*)
    build_api
    deploy_api
    build_worker
    deploy_worker
    ;;
esac

echo ""
echo "✅ Deploy complete!"
echo "   https://d5dqn5neqeb4a027grnq.6brbn2wz.apigw.yandexcloud.net"
