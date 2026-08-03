"""
Общий HTTP-слой для всех сервисов диаризации.

Все бэкенды (NeMo Sortformer, Streaming Sortformer, diart, EEND-EDA,
self-hosted pyannote) различаются только тем, как превратить аудио в сегменты.
Приём файла, декодирование, валидация, формат ответа и /health — одинаковы,
поэтому живут здесь, а каждый сервис реализует один класс Backend.

Контракт: apps/server/src/infrastructure/diarization/contract.md
"""

from __future__ import annotations

import abc
import logging
import os
import tempfile
import time
from dataclasses import dataclass
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse

logger = logging.getLogger("diarization")
logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)


@dataclass
class Segment:
    """Один отрезок речи одного спикера. Секунды от начала записи."""

    speaker: str
    start: float
    stop: float

    def as_dict(self) -> dict:
        return {"speaker": self.speaker, "start": round(self.start, 3), "stop": round(self.stop, 3)}


class Backend(abc.ABC):
    """Интерфейс, который реализует каждый сервис диаризации."""

    name: str = "unknown"
    model_id: str = "unknown"

    #: Модели с фиксированным числом слотов (Sortformer, EEND) игнорируют
    #: подсказки о числе спикеров — сообщаем об этом честно в /health.
    fixed_speaker_slots: Optional[int] = None

    @abc.abstractmethod
    def load(self) -> None:
        """Загружает веса в память. Вызывается один раз на старте."""

    @abc.abstractmethod
    def diarize(
        self,
        audio_path: str,
        num_speakers: Optional[int] = None,
        min_speakers: Optional[int] = None,
        max_speakers: Optional[int] = None,
    ) -> list[Segment]:
        """Возвращает сегменты речи. Перекрытия допустимы и не считаются ошибкой."""

    @property
    def device(self) -> str:
        try:
            import torch

            return "cuda" if torch.cuda.is_available() else "cpu"
        except ImportError:
            return "cpu"


def normalize_segments(segments: list[Segment]) -> list[Segment]:
    """
    Приводит выход модели к инвариантам контракта.

    Отбрасываем вырожденные отрезки (stop <= start) — они появляются на
    границах окон у всех бэкендов и ломают выравнивание с текстом на стороне
    Node. Перекрытия при этом СОХРАНЯЕМ: это overlapped speech, ради него
    multi-label модели и нужны.
    """
    clean = [
        s
        for s in segments
        if s.stop > s.start and s.start >= 0 and _is_finite(s.start) and _is_finite(s.stop)
    ]
    clean.sort(key=lambda s: (s.start, s.stop))
    return clean


def _is_finite(x: float) -> bool:
    return x == x and x not in (float("inf"), float("-inf"))


def create_app(backend: Backend) -> FastAPI:
    app = FastAPI(title=f"YaSpeech diarization — {backend.name}")
    state = {"loaded": False, "load_error": None}

    @app.on_event("startup")
    def _startup() -> None:
        started = time.time()
        logger.info("loading model %s on %s", backend.model_id, backend.device)
        try:
            backend.load()
            state["loaded"] = True
            logger.info("model ready in %.1fs", time.time() - started)
        except Exception as exc:  # noqa: BLE001 — стартовая ошибка должна быть видна в /health
            state["load_error"] = str(exc)
            logger.exception("model failed to load")

    @app.get("/health")
    def health() -> JSONResponse:
        body = {
            "status": "ok" if state["loaded"] else "loading",
            "backend": backend.name,
            "model": backend.model_id,
            "device": backend.device,
            "model_loaded": state["loaded"],
            "fixed_speaker_slots": backend.fixed_speaker_slots,
        }
        if state["load_error"]:
            body["status"] = "error"
            body["error"] = state["load_error"]
            return JSONResponse(body, status_code=503)
        # 503 пока грузимся — деплой-скрипты ждут именно ok, а не открытого порта.
        return JSONResponse(body, status_code=200 if state["loaded"] else 503)

    @app.post("/diarize")
    async def diarize(
        audio: UploadFile = File(...),
        num_speakers: Optional[int] = Form(None),
        min_speakers: Optional[int] = Form(None),
        max_speakers: Optional[int] = Form(None),
    ) -> JSONResponse:
        if not state["loaded"]:
            raise HTTPException(status_code=503, detail="model is still loading")

        started = time.time()
        suffix = os.path.splitext(audio.filename or "audio.wav")[1] or ".wav"

        with tempfile.NamedTemporaryFile(suffix=suffix, delete=True) as tmp:
            content = await audio.read()
            if not content:
                raise HTTPException(status_code=400, detail="empty audio upload")
            tmp.write(content)
            tmp.flush()

            duration = _probe_duration(tmp.name)

            try:
                segments = backend.diarize(
                    tmp.name,
                    num_speakers=num_speakers,
                    min_speakers=min_speakers,
                    max_speakers=max_speakers,
                )
            except Exception as exc:  # noqa: BLE001
                logger.exception("diarization failed")
                return JSONResponse(
                    {"error": str(exc), "backend": backend.name}, status_code=500
                )

        segments = normalize_segments(segments)
        elapsed = time.time() - started

        logger.info(
            "diarized %.1fs of audio in %.1fs → %d segments, %d speakers",
            duration or -1,
            elapsed,
            len(segments),
            len({s.speaker for s in segments}),
        )

        return JSONResponse(
            {
                "backend": backend.name,
                "model": backend.model_id,
                "audio_duration_sec": duration,
                "processing_time_sec": round(elapsed, 2),
                "num_speakers_detected": len({s.speaker for s in segments}),
                "segments": [s.as_dict() for s in segments],
            }
        )

    return app


def _probe_duration(path: str) -> Optional[float]:
    """Длительность в секундах. Только для отчётности, на разметку не влияет."""
    try:
        import soundfile as sf

        info = sf.info(path)
        return round(info.frames / info.samplerate, 2)
    except Exception:  # noqa: BLE001 — не знать длительность не фатально
        return None


def load_audio_16k_mono(path: str):
    """
    Читает аудио как float32 моно 16 kHz — общий вход для всех моделей.

    Браузер уже отдаёт WAV 16 kHz mono, так что ресемплинг обычно no-op,
    но бенчмарк и ручные прогоны кормят сервис чем попало.
    """
    import librosa

    samples, _ = librosa.load(path, sr=16_000, mono=True)
    return samples
