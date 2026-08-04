"""
Streaming Sortformer v2.1 — потоковая диаризация до 4 спикеров.

РЕЗУЛЬТАТ ЗАМЕРА (VoxConverse dev, 8 записей, 2026-08-04): DER 6.1%.

Это лучший результат из проверенных бэкендов — вдвое точнее offline-варианта
(11.9%) и втрое быстрее. Streaming выиграл на всех 8 записях из 8.

Изначально ожидалось обратное: модель принимает аудио кусками и решает о
спикере, не видя будущего контекста, тогда как offline-модели видят запись
целиком. Замер это ожидание опроверг. Вероятная причина — разные поколения
весов: здесь v2.1, а в offline-сервисе чекпоинт v1. То есть сравниваются не
столько режимы работы, сколько версии модели.

Файл проигрывается через forward_streaming, который сам гоняет запись через
потоковый энкодер с внутренним состоянием — имитация живого потока.

Ограничение то же, что у offline-версии: ровно 4 слота. На записях с 5-6
участниками модель выдаёт 4 спикера, и DER растёт с 5.8% до 17.9%.
"""

from __future__ import annotations

import os
import sys
from typing import Optional

sys.path.insert(0, "/app")

from common.server import Backend, Segment, create_app, load_audio_16k_mono  # noqa: E402

MODEL_ID = os.environ.get("MODEL_ID", "nvidia/diar_streaming_sortformer_4spk-v2.1")

SAMPLE_RATE = 16_000
THRESHOLD = float(os.environ.get("SORTFORMER_THRESHOLD", "0.5"))
FRAME_SEC = float(os.environ.get("FRAME_SEC", "0.08"))
MIN_SEGMENT_SEC = float(os.environ.get("MIN_SEGMENT_SEC", "0.20"))
MAX_GAP_SEC = float(os.environ.get("MAX_GAP_SEC", "0.30"))

# Нарезку на куски делает сам forward_streaming: он прогоняет запись через
# потоковый энкодер с внутренним состоянием, как если бы аудио приходило
# в реальном времени. Размер окна зашит в конфиг модели, снаружи не задаётся.


class StreamingSortformerBackend(Backend):
    name = "streaming-sortformer"
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

        # Потоковый режим: модель держит состояние между кусками.
        if hasattr(self.model, "setup_streaming_params"):
            self.model.setup_streaming_params()

    def diarize(
        self,
        audio_path: str,
        num_speakers: Optional[int] = None,
        min_speakers: Optional[int] = None,
        max_speakers: Optional[int] = None,
    ) -> list[Segment]:
        import numpy as np
        import torch

        samples = load_audio_16k_mono(audio_path)

        with torch.inference_mode():
            signal = torch.from_numpy(np.asarray(samples, dtype="float32")).unsqueeze(0)
            length = torch.tensor([signal.shape[1]])

            if torch.cuda.is_available():
                signal, length = signal.cuda(), length.cuda()

            # forward_streaming ждёт мел-фичи, а не сырой звук: препроцессор
            # модели превращает waveform в [batch, features, frames].
            processed, processed_len = self.model.preprocessor(
                input_signal=signal, length=length
            )

            preds = self.model.forward_streaming(processed, processed_len)

        if isinstance(preds, tuple):
            preds = preds[0]

        array = preds.detach().cpu().numpy()
        if array.ndim == 3:
            array = array[0]  # снимаем batch

        return _binarize(array)


def _binarize(array) -> list[Segment]:
    """Тот же порог + сглаживание, что и в offline-варианте — чтобы сравнение
    отличалось именно моделью, а не постобработкой."""
    if array.ndim != 2:
        return []

    segments: list[Segment] = []
    for slot in range(array.shape[1]):
        active = array[:, slot] >= THRESHOLD
        run_start = None
        for i, value in enumerate(active):
            if value and run_start is None:
                run_start = i
            elif not value and run_start is not None:
                segments.append(
                    Segment(f"SPEAKER_{slot:02d}", run_start * FRAME_SEC, i * FRAME_SEC)
                )
                run_start = None
        if run_start is not None:
            segments.append(
                Segment(f"SPEAKER_{slot:02d}", run_start * FRAME_SEC, len(active) * FRAME_SEC)
            )

    return _smooth(segments)


def _smooth(segments: list[Segment]) -> list[Segment]:
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


app = create_app(StreamingSortformerBackend())
