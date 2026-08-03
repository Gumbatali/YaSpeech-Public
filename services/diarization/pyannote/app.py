"""
pyannote Community-1 — self-hosted.

Зачем отдельный сервис, если есть HuggingFace Inference API:

  1. Нет лимита 24 МБ. Часовая планёрка обрабатывается целиком, без нарезки
     на чанки и без эвристической сшивки спикеров на стыках — а значит без
     класса ошибок, который эта сшивка неизбежно вносит.
  2. Нет холодного старта на каждый запрос. HF выгружает модель между
     вызовами и отвечает 503 «loading» — здесь веса лежат в памяти постоянно.
  3. Можно задавать num_speakers / min_speakers / max_speakers. Это и есть
     ответ на пункт 6 списка: в отличие от Sortformer с его четырьмя слотами,
     здесь верхняя граница числа участников — параметр, а не свойство
     архитектуры.
  4. Аудио не покидает наш периметр. Для записей совещаний заказчика это
     скорее требование, чем удобство.

Ограничение подхода: pyannote кластеризует эмбеддинги, а не предсказывает
multi-label маску. Сильно перекрывающуюся речь он размечает хуже, чем
Sortformer, — там, где двое говорят одновременно, кластеризация вынуждена
выбрать одного. Ради этого в наборе и остаётся NeMo.
"""

from __future__ import annotations

import os
import sys
from typing import Optional

sys.path.insert(0, "/app")

from common.server import Backend, Segment, create_app  # noqa: E402

MODEL_ID = os.environ.get("MODEL_ID", "pyannote/speaker-diarization-community-1")


class PyannoteBackend(Backend):
    name = "pyannote-selfhosted"
    model_id = MODEL_ID
    fixed_speaker_slots = None  # число спикеров задаётся параметрами запроса

    def __init__(self) -> None:
        self.pipeline = None

    def load(self) -> None:
        import torch
        from pyannote.audio import Pipeline

        hf_token = os.environ.get("HF_TOKEN")
        if not hf_token:
            # Веса гейтятся лицензией: без токена pyannote молча отдаёт None,
            # и сервис падал бы позже с невнятным AttributeError.
            raise RuntimeError(
                "HF_TOKEN is required to download pyannote weights. "
                "Прими условия модели на huggingface.co и задай токен."
            )

        self.pipeline = Pipeline.from_pretrained(MODEL_ID, use_auth_token=hf_token)
        if self.pipeline is None:
            raise RuntimeError(
                f"Pipeline.from_pretrained({MODEL_ID}) вернул None — "
                "скорее всего не приняты условия лицензии модели."
            )

        if torch.cuda.is_available():
            self.pipeline.to(torch.device("cuda"))

    def diarize(
        self,
        audio_path: str,
        num_speakers: Optional[int] = None,
        min_speakers: Optional[int] = None,
        max_speakers: Optional[int] = None,
    ) -> list[Segment]:
        kwargs: dict = {}

        # num_speakers жёстко фиксирует число кластеров и исключает min/max.
        if num_speakers:
            kwargs["num_speakers"] = int(num_speakers)
        else:
            if min_speakers:
                kwargs["min_speakers"] = int(min_speakers)
            if max_speakers:
                kwargs["max_speakers"] = int(max_speakers)

        annotation = self.pipeline(audio_path, **kwargs)

        return [
            Segment(speaker=str(label), start=float(turn.start), stop=float(turn.end))
            for turn, _track, label in annotation.itertracks(yield_label=True)
        ]


app = create_app(PyannoteBackend())
