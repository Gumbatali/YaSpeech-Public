# diart — потоковая диаризация с неограниченным числом спикеров.
#
# В отличие от NeMo-сервисов, здесь база — обычный CUDA-образ: diart тянет
# pyannote и torch сам, официального образа у проекта нет.
FROM pytorch/pytorch:2.4.0-cuda12.1-cudnn9-runtime

WORKDIR /app

ENV HF_HOME=/models \
    TORCH_HOME=/models \
    PYTHONUNBUFFERED=1

# libsndfile нужен soundfile/librosa для чтения WAV; ffmpeg — для всего остального.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libsndfile1 ffmpeg git \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
    diart==0.9.1 \
    fastapi==0.115.0 \
    "uvicorn[standard]==0.30.6" \
    python-multipart==0.0.9 \
    soundfile==0.12.1 \
    librosa==0.10.2

COPY common/ /app/common/
COPY diart/app.py /app/app.py

EXPOSE 8000

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
