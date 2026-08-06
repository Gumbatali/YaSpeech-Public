"""
NeMo Sortformer — offline-диаризация, до 4 спикеров.

Sortformer выдаёт настоящий multi-label тензор: для каждого кадра — вероятность
речи по каждому из 4 слотов независимо. Поэтому перекрывающаяся речь выражается
естественно (два слота активны одновременно), в отличие от кластеризующих
подходов, где каждый кадр принадлежит ровно одному спикеру.

Ограничение: ровно 4 слота, зашитых в архитектуру. Пятый участник, говорящий
одновременно с четырьмя другими, физически не может быть представлен. Подсказки
num_speakers/min/max игнорируются — менять нечего.
"""

from __future__ import annotations

import os
import sys
from typing import Optional

sys.path.insert(0, "/app")

from common.server import Backend, Segment, create_app  # noqa: E402

MODEL_ID = os.environ.get("MODEL_ID", "nvidia/diar_sortformer_4spk-v1")

# Порог бинаризации вероятностей. 0.5 — нейтральный старт; ниже даёт больше
# перекрытий (растёт false alarm), выше — консервативнее (растёт missed speech).
THRESHOLD = float(os.environ.get("SORTFORMER_THRESHOLD", "0.5"))

# Кадры короче этого схлопываются: модель на границах реплик часто выдаёт
# «дребезг» в один-два кадра, который в протоколе выглядит как обрывки слов.
MIN_SEGMENT_SEC = float(os.environ.get("MIN_SEGMENT_SEC", "0.20"))

# Разрыв короче этого внутри речи одного спикера заполняется: люди делают
# микропаузы, дробить из-за них реплику не нужно.
MAX_GAP_SEC = float(os.environ.get("MAX_GAP_SEC", "0.30"))


class SortformerBackend(Backend):
    name = "nemo-sortformer"
    model_id = MODEL_ID
    fixed_speaker_slots = 4

    def __init__(self) -> None:
        self.model = None

    def load(self) -> None:
        from nemo.collections.asr.models import SortformerEncLabelModel

        self.model = SortformerEncLabelModel.from_pretrained(MODEL_ID)
        self.model.eval()

        import torch

        if torch.cuda.is_available():
            self.model = self.model.cuda()

    def diarize(
        self,
        audio_path: str,
        num_speakers: Optional[int] = None,
        min_speakers: Optional[int] = None,
        max_speakers: Optional[int] = None,
    ) -> list[Segment]:
        # Подсказки о числе спикеров осознанно игнорируются: слотов всегда 4.
        predictions = self.model.diarize(audio=[audio_path], batch_size=1)
        return self._to_segments(predictions)

    def _to_segments(self, predictions) -> list[Segment]:
        """
        NeMo отдаёт либо готовые строки "start end speaker", либо тензор
        вероятностей — в зависимости от версии. Поддерживаем оба варианта,
        чтобы сервис не разваливался при обновлении NeMo.
        """
        if not predictions:
            return []

        first = predictions[0]

        # Вариант 1: список строк RTTM-подобного вида.
        if isinstance(first, (list, tuple)) and first and isinstance(first[0], str):
            return _parse_prediction_strings(first)
        if isinstance(first, str):
            return _parse_prediction_strings(predictions)

        # Вариант 2: тензор [frames, speakers] с вероятностями.
        return _binarize_probabilities(first)


def _parse_prediction_strings(rows) -> list[Segment]:
    segments: list[Segment] = []
    for row in rows:
        parts = str(row).split()
        if len(parts) < 3:
            continue
        try:
            start, stop = float(parts[0]), float(parts[1])
        except ValueError:
            continue
        segments.append(Segment(speaker=str(parts[2]), start=start, stop=stop))
    return segments


def _binarize_probabilities(probs) -> list[Segment]:
    """
    Превращает [frames, speakers] вероятности в отрезки.

    Каждый слот обрабатывается независимо — в этом и смысл multi-label:
    одновременная активность двух слотов означает перекрывающуюся речь,
    а не конфликт, который нужно разрешать.
    """
    import numpy as np

    array = probs.detach().cpu().numpy() if hasattr(probs, "detach") else np.asarray(probs)
    if array.ndim != 2:
        return []

    # Sortformer работает с шагом 0.08с (80 мс) на кадр.
    frame_sec = float(os.environ.get("FRAME_SEC", "0.08"))
    segments: list[Segment] = []

    for slot in range(array.shape[1]):
        active = array[:, slot] >= THRESHOLD
        for start_frame, stop_frame in _contiguous_runs(active):
            segments.append(
                Segment(
                    speaker=f"SPEAKER_{slot:02d}",
                    start=start_frame * frame_sec,
                    stop=stop_frame * frame_sec,
                )
            )

    return _smooth(segments)


def _contiguous_runs(mask) -> list[tuple[int, int]]:
    """Индексы непрерывных True-участков как полуинтервалы [start, stop)."""
    runs: list[tuple[int, int]] = []
    start = None
    for i, value in enumerate(mask):
        if value and start is None:
            start = i
        elif not value and start is not None:
            runs.append((start, i))
            start = None
    if start is not None:
        runs.append((start, len(mask)))
    return runs


def _smooth(segments: list[Segment]) -> list[Segment]:
    """Склеивает микропаузы и выбрасывает дребезг на границах реплик."""
    by_speaker: dict[str, list[Segment]] = {}
    for seg in segments:
        by_speaker.setdefault(seg.speaker, []).append(seg)

    out: list[Segment] = []
    for speaker, group in by_speaker.items():
        group.sort(key=lambda s: s.start)
        merged: list[Segment] = []
        for seg in group:
            if merged and seg.start - merged[-1].stop <= MAX_GAP_SEC:
                merged[-1] = Segment(speaker, merged[-1].start, max(merged[-1].stop, seg.stop))
            else:
                merged.append(Segment(speaker, seg.start, seg.stop))
        out.extend(s for s in merged if s.stop - s.start >= MIN_SEGMENT_SEC)

    out.sort(key=lambda s: (s.start, s.stop))
    return out


app = create_app(SortformerBackend())
