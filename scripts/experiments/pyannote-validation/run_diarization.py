#!/usr/bin/env python3
"""Разовый скрипт для валидации локального pyannote.audio pipeline.

См. docs/plans/2026-07-30-pyannote-diarization.md (Фаза A).
Не часть прод-кода.

Usage:
    HF_TOKEN=hf_... python run_diarization.py path/to/audio.m4a
"""
import os
import sys
import time


def main():
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <audio-file>", file=sys.stderr)
        sys.exit(1)

    audio_path = sys.argv[1]
    if not os.path.isfile(audio_path):
        print(f"Файл не найден: {audio_path}", file=sys.stderr)
        sys.exit(1)

    hf_token = os.environ.get("HF_TOKEN")
    if not hf_token:
        print("Не задан HF_TOKEN (см. README.md).", file=sys.stderr)
        sys.exit(1)

    from pyannote.audio import Pipeline

    print("Загружаю pipeline pyannote/speaker-diarization-3.1...")
    load_start = time.monotonic()
    # В pyannote.audio 4.x параметр называется `token`, не `use_auth_token`.
    pipeline = Pipeline.from_pretrained(
        "pyannote/speaker-diarization-3.1", token=hf_token
    )
    print(f"Pipeline загружен за {time.monotonic() - load_start:.1f}s")

    print(f"Обрабатываю {audio_path}...")
    infer_start = time.monotonic()
    result = pipeline(audio_path)
    infer_elapsed = time.monotonic() - infer_start

    # В 4.x результат — обёртка SpeakerDiarizationOutput,
    # сама диаризация лежит в .speaker_diarization (pyannote.core.Annotation).
    diarization = result.speaker_diarization

    speakers = set()
    segments = []
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        speakers.add(speaker)
        segments.append((turn.start, turn.end, speaker))

    segments.sort(key=lambda s: s[0])
    for start, end, speaker in segments:
        print(f"{speaker:<12} {start:7.2f}s -> {end:7.2f}s")

    audio_duration = diarization.get_timeline().extent().end
    print()
    print(f"Спикеров найдено: {len(speakers)}")
    print(f"Сегментов: {len(segments)}")
    print(f"Длина аудио: {audio_duration:.1f}s")
    print(f"Время обработки: {infer_elapsed:.1f}s")
    if audio_duration > 0:
        print(f"Relative real-time: {infer_elapsed / audio_duration:.2f}x")


if __name__ == "__main__":
    main()
