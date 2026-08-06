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

РЕЗУЛЬТАТ ЗАМЕРА (VoxConverse dev, 8 записей, 2026-08-04): DER 13.4%.

Главное — не общий DER, а распределение ошибки: pyannote угадал число
спикеров на 8 записях из 8 (100%), включая все с 5-6 участниками. Sortformer
на тех же записях выдавал ровно 4 и попадал в 50% случаев.

    записи <=4 спикеров:  DER 13.9%   (Sortformer: 2.7%)
    записи  >4 спикеров:  DER 12.9%   (Sortformer: 9.5%)

То есть качество pyannote почти не зависит от числа участников, тогда как
Sortformer резко деградирует за пределами своих четырёх слотов. На простых
записях Sortformer заметно точнее и в 13 раз быстрее (RTF 0.04x против 0.52x).

Практический вывод: pyannote берут не за среднюю точность, а за способность
вообще увидеть пятого и шестого участника.

Ограничение подхода: pyannote кластеризует эмбеддинги, а не предсказывает
multi-label маску. Сильно перекрывающуюся речь он размечает хуже, чем
Sortformer, — там, где двое говорят одновременно, кластеризация вынуждена
выбрать одного. Это видно в замере: speaker-error 9.2% против 2.6%
у streaming-Sortformer.
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

        # В pyannote.audio 4.x параметр переименован из use_auth_token в token.
        # Пробуем новый, откатываемся на старый — сервис должен работать
        # с обеими ветками библиотеки.
        try:
            self.pipeline = Pipeline.from_pretrained(MODEL_ID, token=hf_token)
        except TypeError:
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

        result = self.pipeline(audio_path, **kwargs)

        # pyannote 4.x возвращает DiarizeOutput — контейнер, внутри которого
        # лежит Annotation в поле speaker_diarization (плюс отдельная
        # exclusive-версия без перекрытий и эмбеддинги). В 3.x пайплайн
        # отдавал Annotation напрямую. Поддерживаем оба варианта.
        #
        # Берём именно speaker_diarization, а не exclusive_*: перекрывающаяся
        # речь — валидные данные по нашему контракту, схлопывать её нельзя.
        annotation = getattr(result, "speaker_diarization", result)

        return [
            Segment(speaker=str(label), start=float(turn.start), stop=float(turn.end))
            for turn, _track, label in annotation.itertracks(yield_label=True)
        ]


app = create_app(PyannoteBackend())
