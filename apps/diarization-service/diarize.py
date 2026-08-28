#!/usr/bin/env python3
"""
Диаризация одного аудиофайла через pyannote.audio — прод-инференс.

В отличие от research/diarization-asr-lab/run/diarize.py (бенчмарк:
manifest.jsonl + эталонная RTTM + расчёт DER) — здесь просто
audio -> RTTM, без эталонной разметки, которой для реальных встреч
не существует. Модель и параметры (num_speakers не передаём) —
те же, что провалидированы в лабе, см. FINDINGS.md.
"""
import argparse
import os
import sys

_pipeline_cache = {}


def get_pipeline(model: str, device: str, hf_token: str):
    """Загружает pipeline один раз и переиспользует между вызовами —
    загрузка модели занимает секунды, не должна повторяться на каждую встречу."""
    key = (model, device)
    if key not in _pipeline_cache:
        import torch
        from pyannote.audio import Pipeline

        print(f"Загружаю пайплайн {model} (device={device})…")
        pipeline = Pipeline.from_pretrained(model, use_auth_token=hf_token)
        pipeline.to(torch.device(device))
        _pipeline_cache[key] = pipeline
    return _pipeline_cache[key]


def annotation_to_rttm(annotation, uri, path):
    with open(path, "w", encoding="utf-8") as f:
        for segment, _, speaker in annotation.itertracks(yield_label=True):
            f.write(
                f"SPEAKER {uri} 1 {segment.start:.3f} {segment.duration:.3f} "
                f"<NA> <NA> {speaker} <NA> <NA>\n"
            )


def run_diarize(
    audio_path: str,
    session_id: str,
    out_rttm_path: str,
    model: str = "pyannote/speaker-diarization-3.1",
    min_speakers: int | None = None,
    max_speakers: int | None = None,
    device: str = "cpu",
) -> int:
    """Возвращает число найденных спикеров."""
    hf_token = os.environ.get("HF_TOKEN")
    if not hf_token:
        raise RuntimeError("HF_TOKEN не задан в окружении контейнера")

    pipeline = get_pipeline(model, device, hf_token)

    kwargs = {}
    if min_speakers is not None:
        kwargs["min_speakers"] = min_speakers
    if max_speakers is not None:
        kwargs["max_speakers"] = max_speakers

    diarization = pipeline(audio_path, **kwargs)
    annotation_to_rttm(diarization, session_id, out_rttm_path)
    return len(diarization.labels())


def main():
    parser = argparse.ArgumentParser(description="Диаризация одного аудиофайла (pyannote.audio)")
    parser.add_argument("--audio", required=True)
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--out-rttm", required=True)
    parser.add_argument("--model", default="pyannote/speaker-diarization-3.1")
    parser.add_argument("--min-speakers", type=int, default=None)
    parser.add_argument("--max-speakers", type=int, default=None)
    parser.add_argument("--device", default="cpu")
    args = parser.parse_args()

    try:
        speakers = run_diarize(
            args.audio, args.session_id, args.out_rttm,
            model=args.model, min_speakers=args.min_speakers,
            max_speakers=args.max_speakers, device=args.device,
        )
    except RuntimeError as e:
        print(f"ОШИБКА: {e}", file=sys.stderr)
        return 1

    print(f"Готово: {speakers} спикеров -> {args.out_rttm}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
