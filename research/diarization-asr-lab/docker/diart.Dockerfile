# diart — streaming diarization with no fixed speaker-slot ceiling (unlike
# sortformer's 4 slots). CPU-only build.
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libsndfile1 ffmpeg git build-essential pkg-config libportaudio2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV HF_HOME=/models \
    TORCH_HOME=/models \
    PYTHONUNBUFFERED=1

# torchvision pinned to match torch==2.2.2 — diart pulls it in transitively
# via torchmetrics/pytorch-lightning, and an unpinned install resolves to a
# version that crashes on import with a circular-import error.
RUN pip install --no-cache-dir torch==2.2.2 torchaudio==2.2.2 torchvision==0.17.2 --index-url https://download.pytorch.org/whl/cpu
RUN pip install --no-cache-dir \
    diart==0.9.1 \
    pyannote.metrics==3.2.1 \
    soundfile==0.12.1 \
    "huggingface_hub<0.26" \
    "numpy<2"

COPY run/diarize-diart.py /app/diarize-diart.py

ENTRYPOINT ["python", "/app/diarize-diart.py"]
