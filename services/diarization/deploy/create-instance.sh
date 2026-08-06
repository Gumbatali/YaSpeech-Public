#!/bin/bash
# Создание GPU-инстанса в Yandex Cloud под сервис диаризации.
#
# ⚠️ ЭТОТ СКРИПТ ТРАТИТ ДЕНЬГИ.
#
# GPU в Яндекс Облаке тарифицируется по времени существования инстанса, а не по
# числу запросов. Инстанс с T4 стоит порядка нескольких десятков рублей в час,
# то есть ~20-30 тысяч рублей в месяц при круглосуточной работе — независимо от
# того, обработал он одну встречу или тысячу.
#
# Поэтому по умолчанию скрипт работает в РЕЖИМЕ ПРЕДПРОСМОТРА: печатает команду
# и выходит. Чтобы действительно создать инстанс, нужен явный флаг --confirm.
#
# Для эксперимента почти всегда дешевле поднять инстанс на час, прогнать
# бенчмарк и удалить (см. подсказку в конце вывода), чем держать его постоянно.
#
# Usage:
#   ./create-instance.sh <backend> --registry <id> [--confirm]
set -euo pipefail

YC="${YC:-$HOME/yandex-cloud/bin/yc}"

BACKEND="${1:-}"
shift || true

REGISTRY_ID="${YC_REGISTRY_ID:-}"
ZONE="${YC_ZONE:-ru-central1-a}"
SA_ID="${YC_SA_ID:-}"
SUBNET_ID="${YC_SUBNET_ID:-}"
GPU_PLATFORM="${GPU_PLATFORM:-gpu-standard-v3}"  # T4
GPU_COUNT="${GPU_COUNT:-1}"
CORES="${CORES:-8}"
MEMORY="${MEMORY:-48}"
DISK_GB="${DISK_GB:-200}"        # образы NeMo крупные — 100 ГБ не хватает
CONFIRM=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --registry) REGISTRY_ID="$2"; shift 2 ;;
    --zone)     ZONE="$2"; shift 2 ;;
    --sa)       SA_ID="$2"; shift 2 ;;
    --subnet)   SUBNET_ID="$2"; shift 2 ;;
    --cpu-only) GPU_PLATFORM=""; GPU_COUNT=0; CORES=8; MEMORY=32; shift ;;
    --confirm)  CONFIRM=true; shift ;;
    *) echo "Неизвестный аргумент: $1"; exit 1 ;;
  esac
done

if [[ -z "$BACKEND" ]]; then
  echo "Usage: $0 <backend> --registry <id> [--sa <id>] [--subnet <id>] [--confirm]"
  echo "Бэкенды: nemo-sortformer streaming-sortformer diart eend-eda pyannote"
  echo ""
  echo "Подсказка: pyannote и eend-eda работают и на CPU — добавь --cpu-only,"
  echo "это на порядок дешевле GPU-инстанса."
  exit 1
fi

for required in REGISTRY_ID SA_ID SUBNET_ID; do
  if [[ -z "${!required}" ]]; then
    echo "❌ Не задан $required."
    echo "   registry: yc container registry list"
    echo "   sa:       yc iam service-account list"
    echo "   subnet:   yc vpc subnet list"
    exit 1
  fi
done

NAME="yaspeech-diar-$BACKEND"
IMAGE="cr.yandex/$REGISTRY_ID/yaspeech-diar-$BACKEND:latest"

# cloud-init: ставим драйверы NVIDIA (в GPU-образе они уже есть), логинимся
# в реестр и поднимаем контейнер с автоперезапуском.
DOCKER_GPU_FLAG=""
[[ "$GPU_COUNT" -gt 0 ]] && DOCKER_GPU_FLAG="--gpus all"

CLOUD_INIT=$(cat <<EOF
#cloud-config
runcmd:
  - mkdir -p /models
  - docker login --username iam --password \$(curl -s -H "Metadata-Flavor: Google" http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token | grep -o '"access_token":"[^"]*' | cut -d'"' -f4) cr.yandex
  - docker pull $IMAGE
  - docker run -d --restart always $DOCKER_GPU_FLAG -p 8000:8000 -v /models:/models -e HF_TOKEN=\${HF_TOKEN:-} --name diarization $IMAGE
EOF
)

PLATFORM_ARGS=""
if [[ "$GPU_COUNT" -gt 0 ]]; then
  PLATFORM_ARGS="--platform $GPU_PLATFORM --gpus $GPU_COUNT"
  IMAGE_FAMILY="ubuntu-2004-lts-gpu"
else
  IMAGE_FAMILY="container-optimized-image"
fi

echo "═══ План создания инстанса ═══"
echo "  имя:        $NAME"
echo "  образ:      $IMAGE"
echo "  зона:       $ZONE"
if [[ "$GPU_COUNT" -gt 0 ]]; then
  echo "  платформа:  $GPU_PLATFORM, GPU ×$GPU_COUNT  ⚠️  тарифицируется постоянно"
else
  echo "  платформа:  CPU-only (существенно дешевле)"
fi
echo "  ресурсы:    $CORES vCPU, $MEMORY ГБ RAM, диск $DISK_GB ГБ"
echo ""

if [[ "$CONFIRM" != true ]]; then
  echo "🔍 РЕЖИМ ПРЕДПРОСМОТРА — ничего не создано, деньги не потрачены."
  echo ""
  echo "Чтобы создать инстанс, повтори команду с флагом --confirm:"
  echo "  $0 $BACKEND --registry $REGISTRY_ID --sa $SA_ID --subnet $SUBNET_ID --confirm"
  echo ""
  echo "Не забудь удалить инстанс после экспериментов:"
  echo "  $YC compute instance delete $NAME"
  exit 0
fi

echo "🚀 Создаём инстанс (тарификация начнётся сразу)…"

# shellcheck disable=SC2086
$YC compute instance create \
  --name "$NAME" \
  --zone "$ZONE" \
  --service-account-id "$SA_ID" \
  $PLATFORM_ARGS \
  --cores "$CORES" \
  --memory "${MEMORY}G" \
  --create-boot-disk "type=network-ssd,size=${DISK_GB}G,image-family=$IMAGE_FAMILY" \
  --network-interface "subnet-id=$SUBNET_ID,nat-ip-version=ipv4" \
  --metadata-from-file "user-data=/dev/stdin" <<< "$CLOUD_INIT"

echo ""
echo "✅ Инстанс создан."
echo ""
echo "Внешний IP:"
$YC compute instance get "$NAME" --format json | grep -o '"address": "[0-9.]*"' | tail -1

echo ""
echo "Модель грузится несколько минут. Готовность:"
echo "  curl http://<IP>:8000/health"
echo ""
echo "⚠️  Удали инстанс, когда закончишь — иначе он тарифицируется круглосуточно:"
echo "  $YC compute instance delete $NAME"
