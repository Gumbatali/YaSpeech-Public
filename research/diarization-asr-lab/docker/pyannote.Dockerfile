# CPU image for diarization: pyannote.audio + pyannote.metrics. Model weights
# are not baked in — downloaded at first run via HF_TOKEN into /models.
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# torch + torchaudio must come from the same index in one command — mixing
# a CPU torch with a CUDA-build torchaudio from PyPI crashes on import with
# an ABI mismatch. Pinned to 2.2.2: newer torchaudio drops the legacy I/O API
# pyannote.audio 3.3.2 depends on.
RUN pip install --no-cache-dir torch==2.2.2 torchaudio==2.2.2 --index-url https://download.pytorch.org/whl/cpu
# huggingface_hub<0.26: pyannote.audio 3.3.2 calls hf_hub_download with the
# removed use_auth_token param. numpy<2: torch==2.2.2 is built against the
# NumPy 1.x ABI.
RUN pip install --no-cache-dir \
    pyannote.audio==3.3.2 \
    pyannote.metrics==3.2.1 \
    soundfile==0.12.1 \
    "huggingface_hub<0.26" \
    "numpy<2"

COPY run/diarize.py /app/diarize.py
COPY run/filter-short-segments.py /app/filter-short-segments.py

ENTRYPOINT ["python", "/app/diarize.py"]
