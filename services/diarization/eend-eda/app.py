"""
EEND-EDA — end-to-end нейросетевая диаризация, pretrained CALLHOME.

⚠️ ЧЕГО ЖДАТЬ ОТ ЭТОГО СЕРВИСА

Готовых весов EEND-EDA под русскую речь не существует. Публично доступны
чекпоинты, обученные на CALLHOME — это АНГЛИЙСКИЕ ТЕЛЕФОННЫЕ РАЗГОВОРЫ,
8 kHz, два-три говорящих, узкополосный кодек.

Строительная планёрка на русском отличается от этого по всем осям сразу:
язык, полоса частот, число участников, акустика помещения, дистанция до
микрофона. Модель почти наверняка покажет заметно худший DER, чем pyannote.

Это ожидаемый и полезный результат: он показывает цену «взять research-модель
как есть» и обосновывает, почему пункт 5 из списка — это трек с обучением на
своих данных, а не готовое решение. Разворачиваем сервис именно ради честной
цифры в сравнении, а не как кандидата в прод.

Чтобы обучать своё, нужен размеченный корпус встреч (десятки часов с
поспикерной разметкой). Пока его нет, обучение начинать не с чего.
"""

from __future__ import annotations

import os
import sys
from typing import Optional

sys.path.insert(0, "/app")

from common.server import Backend, Segment, create_app, load_audio_16k_mono  # noqa: E402

# Путь к чекпоинту внутри контейнера. Веса не вшиты в образ — кладутся томом,
# см. services/diarization/README.md
CHECKPOINT = os.environ.get("EEND_CHECKPOINT", "/models/eend/callhome.pth")

THRESHOLD = float(os.environ.get("EEND_THRESHOLD", "0.5"))
# EEND работает с шагом 10 мс на кадр после субсэмплинга ×10 от 100 fps.
FRAME_SEC = float(os.environ.get("EEND_FRAME_SEC", "0.10"))
MIN_SEGMENT_SEC = float(os.environ.get("MIN_SEGMENT_SEC", "0.20"))
MAX_GAP_SEC = float(os.environ.get("MAX_GAP_SEC", "0.30"))

# EDA (encoder-decoder attractor) сам решает, сколько спикеров в записи,
# но верхняя граница нужна, чтобы декодер не разошёлся на шумной записи.
MAX_SPEAKERS_CAP = int(os.environ.get("EEND_MAX_SPEAKERS", "6"))


class EendEdaBackend(Backend):
    name = "eend-eda"
    model_id = f"EEND-EDA CALLHOME ({os.path.basename(CHECKPOINT)})"
    fixed_speaker_slots = None  # EDA определяет число спикеров сам

    def __init__(self) -> None:
        self.model = None

    def load(self) -> None:
        import torch

        if not os.path.exists(CHECKPOINT):
            raise FileNotFoundError(
                f"EEND checkpoint not found at {CHECKPOINT}. "
                "Скачай веса CALLHOME и примонтируй их томом — см. README сервисов."
            )

        # Архитектура берётся из репозитория BUTSpeechFIT/EEND, установленного
        # в образ. Импорт внутри load(), чтобы ошибка отражалась в /health,
        # а не убивала процесс на старте.
        from eend.pytorch_backend.models import TransformerEDADiarization

        device = "cuda" if torch.cuda.is_available() else "cpu"

        self.model = TransformerEDADiarization(
            in_size=345,  # 23 мел-фильтра × контекст 15 кадров
            n_units=256,
            n_heads=4,
            n_layers=4,
            dropout=0.0,
            attractor_loss_ratio=1.0,
            attractor_encoder_dropout=0.0,
            attractor_decoder_dropout=0.0,
        )

        state = torch.load(CHECKPOINT, map_location=device)
        self.model.load_state_dict(state.get("model", state), strict=False)
        self.model.to(device).eval()
        self.device = device

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
        features = _log_mel_features(samples)

        cap = min(max_speakers or MAX_SPEAKERS_CAP, MAX_SPEAKERS_CAP)

        with torch.inference_mode():
            batch = torch.from_numpy(features).float().unsqueeze(0).to(self.device)
            outputs = self.model.estimate_sequential(
                batch, n_speakers=num_speakers, th=THRESHOLD, shuffle=False
            )

        probs = outputs[0] if isinstance(outputs, (list, tuple)) else outputs
        array = probs.detach().cpu().numpy() if hasattr(probs, "detach") else np.asarray(probs)

        if array.ndim != 2:
            return []

        return _binarize(array[:, :cap])


def _log_mel_features(samples):
    """23 лог-мел коэффициента — вход, на котором обучался EEND."""
    import librosa
    import numpy as np

    mel = librosa.feature.melspectrogram(
        y=samples, sr=16_000, n_fft=400, hop_length=160, n_mels=23
    )
    log_mel = np.log(np.maximum(mel, 1e-10)).T

    # Субсэмплинг ×10: EEND ожидает 10 кадров в секунду, а не 100.
    return log_mel[::10]


def _binarize(array) -> list[Segment]:
    segments: list[Segment] = []

    for slot in range(array.shape[1]):
        active = array[:, slot] >= THRESHOLD
        run_start = None
        for i, value in enumerate(active):
            if value and run_start is None:
                run_start = i
            elif not value and run_start is not None:
                segments.append(Segment(f"SPEAKER_{slot:02d}", run_start * FRAME_SEC, i * FRAME_SEC))
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


app = create_app(EendEdaBackend())
