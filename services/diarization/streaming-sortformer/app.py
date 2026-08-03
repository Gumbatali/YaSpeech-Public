"""
Streaming Sortformer v2.1 — потоковая диаризация до 4 спикеров.

⚠️ ВАЖНО ПРО ЧЕСТНОСТЬ ЗАМЕРА

Эта модель создана для живого потока: она принимает аудио кусками и решает
о спикере, видя только прошлое. В YaSpeech живого потока нет — пользователь
загружает готовый файл, который лежит в S3 целиком.

Чтобы вообще получить число для сравнения, мы проигрываем файл через модель
как поддельный поток. Из-за этого сравнение с offline-моделями заведомо
несимметрично: streaming-модель работает без доступа к будущему контексту,
а offline-модели — с полным. Практически всегда это даёт streaming-варианту
худший DER, и это НЕ означает, что модель плохая: она решает другую задачу.

Единственный сценарий, где такой сервис был бы оправдан в проде — живая
транскрипция совещания в реальном времени. Такой функции в продукте нет.
Держим сервис ради полноты сравнения, а не как кандидата на внедрение.
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

# Размер куска, которым «проигрываем» файл. Влияет на результат: чем меньше
# кусок, тем меньше контекста у модели и тем ближе к реальному стримингу.
CHUNK_SEC = float(os.environ.get("STREAM_CHUNK_SEC", "2.0"))


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
        chunk_samples = int(CHUNK_SEC * SAMPLE_RATE)

        probabilities: list = []
        state = None

        with torch.inference_mode():
            for offset in range(0, len(samples), chunk_samples):
                chunk = samples[offset : offset + chunk_samples]
                if len(chunk) == 0:
                    continue

                tensor = torch.from_numpy(np.asarray(chunk, dtype="float32")).unsqueeze(0)
                length = torch.tensor([tensor.shape[1]])

                if torch.cuda.is_available():
                    tensor, length = tensor.cuda(), length.cuda()

                probs, state = self._forward_chunk(tensor, length, state)
                if probs is not None:
                    probabilities.append(probs.detach().cpu().numpy())

        if not probabilities:
            return []

        return _binarize(np.concatenate(probabilities, axis=0))

    def _forward_chunk(self, tensor, length, state):
        """
        NeMo менял сигнатуру потокового шага между версиями. Пробуем известные
        варианты по очереди, чтобы обновление NeMo не роняло сервис молча.
        """
        if hasattr(self.model, "forward_streaming_step"):
            out = self.model.forward_streaming_step(
                processed_signal=tensor, processed_signal_length=length, streaming_state=state
            )
            if isinstance(out, tuple):
                return out[0], out[1] if len(out) > 1 else None
            return out, state

        preds = self.model.forward(input_signal=tensor, input_signal_length=length)
        if isinstance(preds, tuple):
            preds = preds[0]
        return preds.squeeze(0) if preds.ndim == 3 else preds, state


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
