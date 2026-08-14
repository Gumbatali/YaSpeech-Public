# NeMo Sortformer (offline, up to 4 speakers) batch runner for DER benchmarking.
# Base image is python:3.11-slim + pip-installed nemo_toolkit, not the
# official nvcr.io/nvidia/nemo image (unreachable from some cloud IP ranges).
FROM python:3.11-slim

WORKDIR /app

ENV HF_HOME=/models \
    TORCH_HOME=/models \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    libsndfile1 \
    ffmpeg \
    git \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
    "nemo_toolkit[asr]" \
    pyannote.metrics==3.2.1 \
    soundfile==0.12.1

COPY run/diarize-sortformer.py /app/diarize-sortformer.py

ENTRYPOINT ["python", "/app/diarize-sortformer.py"]
