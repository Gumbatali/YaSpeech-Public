# NeMo Sortformer — offline-диаризация до 4 спикеров.
#
# База — официальный образ NeMo: собирать PyTorch+CUDA+NeMo с нуля долго
# и хрупко (совместимость версий CUDA/cuDNN/torch тащит за собой полдня).
FROM nvcr.io/nvidia/nemo:24.07

WORKDIR /app

# Веса кладём в примонтированный том, а не в слой образа: образ NeMo и так
# ~20 ГБ, а веса меняются независимо от кода.
ENV HF_HOME=/models \
    TORCH_HOME=/models \
    PYTHONUNBUFFERED=1

RUN pip install --no-cache-dir \
    fastapi==0.115.0 \
    "uvicorn[standard]==0.30.6" \
    python-multipart==0.0.9 \
    soundfile==0.12.1 \
    librosa==0.10.2

COPY common/ /app/common/
COPY nemo-sortformer/app.py /app/app.py

EXPOSE 8000

# Один воркер намеренно: модель занимает несколько ГБ VRAM, второй процесс
# либо не поместится, либо будет драться за GPU. Параллелизм — на уровне
# нескольких инстансов, а не воркеров внутри одного.
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
