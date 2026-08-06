# pyannote Community-1 — self-hosted.
#
# Работает и на CPU (медленнее реального времени примерно ×0.5), поэтому это
# единственный сервис из набора, который осмысленно поднять без GPU.
FROM pytorch/pytorch:2.4.0-cuda12.1-cudnn9-runtime

WORKDIR /app

ENV HF_HOME=/models \
    TORCH_HOME=/models \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        libsndfile1 ffmpeg \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
    "pyannote.audio==3.3.2" \
    fastapi==0.115.0 \
    "uvicorn[standard]==0.30.6" \
    python-multipart==0.0.9 \
    soundfile==0.12.1 \
    librosa==0.10.2

COPY common/ /app/common/
COPY pyannote/app.py /app/app.py

EXPOSE 8000

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
