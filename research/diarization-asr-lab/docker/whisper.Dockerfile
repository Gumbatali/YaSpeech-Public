# CPU-образ для распознавания речи: faster-whisper (CTranslate2, int8 на CPU).
# Веса модели качаются при первом запуске в volume /models — тот же принцип,
# что и в pyannote.Dockerfile.
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# requests не подтягивается транзитивно в этой версии faster-whisper, но
# нужен faster_whisper/utils.py на импорте (проверено 2026-08-10)
RUN pip install --no-cache-dir faster-whisper==1.0.3 soundfile==0.12.1 requests

COPY run/transcribe.py /app/transcribe.py

ENTRYPOINT ["python", "/app/transcribe.py"]
