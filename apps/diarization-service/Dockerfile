# Прод-образ диаризации: pyannote.audio за HTTP, для Yandex Serverless
# Containers (long-lived, до 1 часа на запрос). Модель весов не запечена —
# скачивается при первом запуске через HF_TOKEN, кешируется в контейнере
# между запросами, пока инстанс тёплый.
#
# База — тот же образ, что research/diarization-asr-lab/docker/pyannote.Dockerfile:
# CPU-версия, GPU в этом облачном аккаунте недоступна (нулевая квота).
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# torch + torchaudio должны быть из одного индекса одной командой — иначе
# ABI-рассинхрон между CPU-torch и CUDA-сборкой torchaudio с PyPI.
# Версия 2.2.2 зафиксирована: новее torchaudio убирает legacy I/O API,
# от которого зависит pyannote.audio 3.3.2.
RUN pip install --no-cache-dir torch==2.2.2 torchaudio==2.2.2 --index-url https://download.pytorch.org/whl/cpu
# huggingface_hub<0.26: pyannote.audio 3.3.2 вызывает hf_hub_download с
# удалённым параметром use_auth_token. numpy<2: torch==2.2.2 собран под
# NumPy 1.x ABI.
RUN pip install --no-cache-dir \
    pyannote.audio==3.3.2 \
    soundfile==0.12.1 \
    "huggingface_hub<0.26" \
    "numpy<2"

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY diarize.py merge_clusters.py server.py /app/

ENV PORT=8080
EXPOSE 8080
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080"]
