#!/bin/bash
# Сборка образов диаризации и публикация в Yandex Container Registry.
#
# Деньги тратятся только на хранение образов (копейки). Дорогое — GPU-инстансы,
# они создаются отдельным скриптом create-instance.sh.
#
# Usage:
#   ./build-and-push.sh <backend> [--registry <id>] [--push]
#   ./build-and-push.sh all --push
#
# Без --push только собирает локально, ничего не отправляя.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICES_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

BACKENDS=(nemo-sortformer streaming-sortformer diart eend-eda pyannote)

TARGET="${1:-}"
shift || true

REGISTRY_ID="${YC_REGISTRY_ID:-}"
PUSH=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --registry) REGISTRY_ID="$2"; shift 2 ;;
    --push)     PUSH=true; shift ;;
    *) echo "Неизвестный аргумент: $1"; exit 1 ;;
  esac
done

if [[ -z "$TARGET" ]]; then
  echo "Usage: $0 <backend|all> [--registry <id>] [--push]"
  echo "Бэкенды: ${BACKENDS[*]}"
  exit 1
fi

if [[ "$PUSH" == true && -z "$REGISTRY_ID" ]]; then
  echo "❌ Для --push нужен registry id: --registry <id> или YC_REGISTRY_ID."
  echo "   Создать реестр: yc container registry create --name yaspeech-diarization"
  exit 1
fi

if [[ "$TARGET" == "all" ]]; then
  SELECTED=("${BACKENDS[@]}")
else
  # shellcheck disable=SC2076
  if [[ ! " ${BACKENDS[*]} " =~ " ${TARGET} " ]]; then
    echo "❌ Неизвестный бэкенд «$TARGET». Доступны: ${BACKENDS[*]}"
    exit 1
  fi
  SELECTED=("$TARGET")
fi

echo "🔨 Собираем: ${SELECTED[*]}"
[[ "$PUSH" == true ]] && echo "📤 Публикация в cr.yandex/$REGISTRY_ID" || echo "💡 Локальная сборка (без --push)"
echo ""

for backend in "${SELECTED[@]}"; do
  tag="yaspeech-diar-$backend:latest"
  echo "── $backend ─────────────────────────────────────────"

  # Контекст сборки — services/diarization, чтобы в образ попала общая папка
  # common/ вместе с кодом конкретного бэкенда.
  docker build \
    -f "$SERVICES_DIR/$backend/Dockerfile" \
    -t "$tag" \
    "$SERVICES_DIR"

  if [[ "$PUSH" == true ]]; then
    remote="cr.yandex/$REGISTRY_ID/yaspeech-diar-$backend:latest"
    docker tag "$tag" "$remote"
    docker push "$remote"
    echo "   ✓ $remote"
  else
    echo "   ✓ $tag (локально)"
  fi
  echo ""
done

echo "✅ Готово."
if [[ "$PUSH" != true ]]; then
  echo "   Запустить локально:"
  echo "     docker run --rm --gpus all -p 8000:8000 -v \$PWD/models:/models yaspeech-diar-${SELECTED[0]}:latest"
fi
