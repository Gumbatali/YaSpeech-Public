# EEND-EDA — pretrained CALLHOME, только для сравнительного замера.
#
# Веса НЕ вшиты в образ: их нужно скачать отдельно и примонтировать в /models
# (см. services/diarization/README.md). Так образ остаётся небольшим, а замена
# чекпоинта не требует пересборки.
FROM pytorch/pytorch:2.4.0-cuda12.1-cudnn9-runtime

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONPATH=/opt/EEND

RUN apt-get update && apt-get install -y --no-install-recommends \
        libsndfile1 ffmpeg git \
    && rm -rf /var/lib/apt/lists/*

# Референсная реализация EEND от BUT — нужна ради определения архитектуры.
RUN git clone --depth 1 https://github.com/BUTSpeechFIT/EEND.git /opt/EEND

RUN pip install --no-cache-dir \
    fastapi==0.115.0 \
    "uvicorn[standard]==0.30.6" \
    python-multipart==0.0.9 \
    soundfile==0.12.1 \
    librosa==0.10.2 \
    scipy==1.14.1

COPY common/ /app/common/
COPY eend-eda/app.py /app/app.py

EXPOSE 8000

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
