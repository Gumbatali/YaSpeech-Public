"""
diart — потоковая диаризация с неизвестным числом участников.

Отличие от Sortformer: у diart нет фиксированных слотов. Он строит эмбеддинги
речи и наращивает кластеры инкрементально, поэтому число спикеров ограничено
только тем, что реально звучит. Это единственный бэкенд в наборе, способный
честно ответить на вопрос из пункта 6 — «а если голосов больше четырёх».

Как и Streaming Sortformer, diart создан для живого потока. Файл проигрывается
через него искусственно (см. ниже), и по той же причине сравнение с offline
моделями смещено не в его пользу.

Компромисс качества: tau_active / rho_update / delta_new — пороги активности,
обновления кластера и заведения нового спикера. Значения по умолчанию взяты
из рекомендаций diart для микрофонных записей; на записях с телефона их
обычно приходится ослаблять, иначе один человек дробится на нескольких.
"""

from __future__ import annotations

import os
import sys
from typing import Optional

sys.path.insert(0, "/app")

from common.server import Backend, Segment, create_app  # noqa: E402

SEGMENTATION_MODEL = os.environ.get("DIART_SEGMENTATION", "pyannote/segmentation-3.0")
EMBEDDING_MODEL = os.environ.get("DIART_EMBEDDING", "pyannote/wespeaker-voxceleb-resnet34-LM")

TAU_ACTIVE = float(os.environ.get("DIART_TAU_ACTIVE", "0.507"))
RHO_UPDATE = float(os.environ.get("DIART_RHO_UPDATE", "0.006"))
DELTA_NEW = float(os.environ.get("DIART_DELTA_NEW", "1.057"))

# Длина окна и шаг. Меньший шаг = выше точность границ, но линейно дороже.
STEP_SEC = float(os.environ.get("DIART_STEP_SEC", "0.5"))
LATENCY_SEC = float(os.environ.get("DIART_LATENCY_SEC", "0.5"))


class DiartBackend(Backend):
    name = "diart"
    model_id = f"{SEGMENTATION_MODEL} + {EMBEDDING_MODEL}"
    fixed_speaker_slots = None  # число участников не ограничено архитектурой

    def __init__(self) -> None:
        self.pipeline_config = None

    def load(self) -> None:
        from diart import SpeakerDiarizationConfig
        from diart.models import EmbeddingModel, SegmentationModel

        hf_token = os.environ.get("HF_TOKEN")

        segmentation = SegmentationModel.from_pretrained(SEGMENTATION_MODEL, use_hf_token=hf_token)
        embedding = EmbeddingModel.from_pretrained(EMBEDDING_MODEL, use_hf_token=hf_token)

        # Конфиг создаём один раз, а сам pipeline — на каждый запрос:
        # он накапливает состояние кластеров и между записями его нужно сбрасывать.
        self.pipeline_config = SpeakerDiarizationConfig(
            segmentation=segmentation,
            embedding=embedding,
            step=STEP_SEC,
            latency=LATENCY_SEC,
            tau_active=TAU_ACTIVE,
            rho_update=RHO_UPDATE,
            delta_new=DELTA_NEW,
        )

    def diarize(
        self,
        audio_path: str,
        num_speakers: Optional[int] = None,
        min_speakers: Optional[int] = None,
        max_speakers: Optional[int] = None,
    ) -> list[Segment]:
        from diart import SpeakerDiarization
        from diart.sources import FileAudioSource
        from diart.inference import StreamingInference

        # Свежий pipeline на каждый файл — иначе спикеры прошлой встречи
        # «протекают» в следующую и нумерация едет.
        pipeline = SpeakerDiarization(self.pipeline_config)

        source = FileAudioSource(audio_path, sample_rate=16_000)
        inference = StreamingInference(
            pipeline,
            source,
            do_profile=False,
            do_plot=False,
            show_progress=False,
        )

        annotation = inference()
        return _annotation_to_segments(annotation)


def _annotation_to_segments(annotation) -> list[Segment]:
    """
    diart возвращает pyannote.core.Annotation (иногда в кортеже с эмбеддингами).
    Перекрытия в Annotation выражаются отдельными треками, поэтому просто
    разворачиваем все дорожки — склеивать их не нужно.
    """
    if annotation is None:
        return []

    if isinstance(annotation, tuple):
        annotation = annotation[0]

    segments: list[Segment] = []
    for segment, _track, label in annotation.itertracks(yield_label=True):
        segments.append(Segment(speaker=str(label), start=float(segment.start), stop=float(segment.end)))

    return segments


app = create_app(DiartBackend())
