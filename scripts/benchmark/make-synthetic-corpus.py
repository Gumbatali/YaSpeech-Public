#!/usr/bin/env python3
"""
Генератор синтетического корпуса для замера DER.

Зачем синтетика: чтобы посчитать DER, нужна поспикерная разметка с точностью
до долей секунды. Размечать реальные планёрки вручную — часы работы на каждую
запись. Здесь мы СОБИРАЕМ запись из отдельных реплик, поэтому эталон известен
по построению, с точностью до сэмпла.

Что синтетика честно моделирует:
  • число участников и структуру чередования реплик
  • перекрывающуюся речь (перебивания) — задаётся параметром
  • паузы между репликами
  • разную длину реплик

Чего синтетика НЕ моделирует (и поэтому абсолютные значения DER будут
оптимистичнее, чем на реальных записях):
  • реверберацию помещения и удалённый микрофон
  • шум стройки, эхо, обрывы связи
  • естественную просодию перебивания — склейка на границе всегда «резкая»
  • то, что один и тот же человек звучит по-разному в разные моменты встречи

Вывод: синтетика годится, чтобы РАНЖИРОВАТЬ бэкенды между собой и ловить
грубые поломки. Она не даёт числа, которое можно обещать заказчику.

Источники голосов:
  --voices DIR   папка с моно-WAV, по одному файлу на говорящего
                 (можно нарезать из Golos, см. download_golos.py)

Пример:
  python3 make-synthetic-corpus.py --voices ./voices --out ./data/synthetic \\
      --sessions 10 --speakers 3 --duration 300 --overlap-ratio 0.12
"""

from __future__ import annotations

import argparse
import json
import os
import random
import wave
from dataclasses import dataclass, asdict

TARGET_RATE = 16_000


@dataclass
class RefSegment:
    speaker: str
    start: float
    stop: float


def read_wav_mono16k(path: str) -> bytes:
    """Читает WAV как сырые PCM-байты, проверяя формат."""
    with wave.open(path, "rb") as w:
        if w.getnchannels() != 1:
            raise ValueError(f"{path}: ожидается моно")
        if w.getsampwidth() != 2:
            raise ValueError(f"{path}: ожидается 16-bit PCM")
        if w.getframerate() != TARGET_RATE:
            raise ValueError(f"{path}: ожидается {TARGET_RATE} Hz, получено {w.getframerate()}")
        return w.readframes(w.getnframes())


def mix_pcm(base: bytearray, overlay: bytes, offset_frames: int) -> None:
    """
    Подмешивает overlay в base со сдвигом, с насыщением вместо переполнения.

    Простое сложение int16 переполняется на громких участках и даёт треск,
    который диаризатор воспринимает как посторонний голос — это исказило бы
    замер.
    """
    import struct

    overlay_frames = len(overlay) // 2
    needed = (offset_frames + overlay_frames) * 2
    if len(base) < needed:
        base.extend(bytes(needed - len(base)))

    for i in range(overlay_frames):
        bi = (offset_frames + i) * 2
        a = struct.unpack_from("<h", base, bi)[0]
        b = struct.unpack_from("<h", overlay, i * 2)[0]
        struct.pack_into("<h", base, bi, max(-32768, min(32767, a + b)))


def build_session(
    voices: dict[str, list[bytes]],
    speakers: list[str],
    duration_sec: float,
    overlap_ratio: float,
    rng: random.Random,
) -> tuple[bytes, list[RefSegment]]:
    """Собирает одну «встречу» из реплик и возвращает аудио + эталон."""
    audio = bytearray()
    reference: list[RefSegment] = []

    cursor_sec = 0.0
    last_speaker = None

    while cursor_sec < duration_sec:
        # Не даём одному человеку говорить дважды подряд — иначе получается
        # монолог, на котором диаризация тривиальна и замер неинформативен.
        candidates = [s for s in speakers if s != last_speaker] or speakers
        speaker = rng.choice(candidates)

        clip = rng.choice(voices[speaker])
        clip_sec = len(clip) / 2 / TARGET_RATE

        is_overlap = last_speaker is not None and rng.random() < overlap_ratio

        if is_overlap:
            # Перебивание: новая реплика начинается ДО конца предыдущей.
            back_off = min(clip_sec * 0.5, rng.uniform(0.3, 1.5))
            start_sec = max(0.0, cursor_sec - back_off)
        else:
            start_sec = cursor_sec + rng.uniform(0.1, 0.8)  # естественная пауза

        offset_frames = int(start_sec * TARGET_RATE)
        mix_pcm(audio, clip, offset_frames)

        reference.append(RefSegment(speaker, round(start_sec, 3), round(start_sec + clip_sec, 3)))

        cursor_sec = start_sec + clip_sec
        last_speaker = speaker

    reference.sort(key=lambda s: s.start)
    return bytes(audio), reference


def load_voices(voices_dir: str, speakers_needed: int) -> dict[str, list[bytes]]:
    """
    Загружает голоса. Каждый WAV-файл = отдельный говорящий; если файлов
    больше, чем нужно спикеров, лишние игнорируются.
    """
    files = sorted(f for f in os.listdir(voices_dir) if f.lower().endswith(".wav"))
    if len(files) < speakers_needed:
        raise SystemExit(
            f"Нужно минимум {speakers_needed} WAV-файлов в {voices_dir}, найдено {len(files)}"
        )

    voices: dict[str, list[bytes]] = {}
    for i, filename in enumerate(files[:speakers_needed]):
        pcm = read_wav_mono16k(os.path.join(voices_dir, filename))
        # Режем длинную запись на реплики по 2–6 секунд.
        clips = []
        pos = 0
        rng = random.Random(i)
        while pos < len(pcm):
            length = int(rng.uniform(2.0, 6.0) * TARGET_RATE) * 2
            clip = pcm[pos : pos + length]
            if len(clip) > TARGET_RATE:  # не короче 0.5с
                clips.append(clip)
            pos += length
        if not clips:
            raise SystemExit(f"{filename}: слишком короткий файл")
        voices[f"SPEAKER_{i}"] = clips

    return voices


def write_wav(path: str, pcm: bytes) -> None:
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(TARGET_RATE)
        w.writeframes(pcm)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--voices", required=True, help="папка с моно-WAV 16kHz, по файлу на голос")
    parser.add_argument("--out", required=True, help="куда сложить корпус")
    parser.add_argument("--sessions", type=int, default=10, help="сколько записей сгенерировать")
    parser.add_argument("--speakers", type=int, default=3, help="участников в каждой записи")
    parser.add_argument("--duration", type=float, default=300, help="длительность записи, сек")
    parser.add_argument(
        "--overlap-ratio",
        type=float,
        default=0.12,
        help="доля реплик, начинающихся с перебивания (0 = без перекрытий)",
    )
    parser.add_argument("--seed", type=int, default=42, help="для воспроизводимости")
    args = parser.parse_args()

    os.makedirs(args.out, exist_ok=True)
    rng = random.Random(args.seed)
    voices = load_voices(args.voices, args.speakers)
    speakers = list(voices.keys())

    manifest_path = os.path.join(args.out, "manifest.jsonl")

    with open(manifest_path, "w", encoding="utf-8") as manifest:
        for i in range(args.sessions):
            audio, reference = build_session(
                voices, speakers, args.duration, args.overlap_ratio, rng
            )

            session_id = f"synthetic-{i:03d}"
            audio_name = f"{session_id}.wav"
            write_wav(os.path.join(args.out, audio_name), audio)

            manifest.write(
                json.dumps(
                    {
                        "id": session_id,
                        "audio": audio_name,
                        "reference": [asdict(s) for s in reference],
                        "num_speakers": len(speakers),
                        "tags": ["synthetic", f"overlap-{args.overlap_ratio}"],
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )

            overlap_count = sum(
                1
                for a in range(len(reference))
                for b in range(a + 1, len(reference))
                if reference[b].start < reference[a].stop
            )
            print(
                f"  {session_id}: {len(reference)} реплик, "
                f"{len(speakers)} спикеров, {overlap_count} перекрытий"
            )

    print(f"\n✓ Корпус готов: {manifest_path}")
    print("  ВАЖНО: синтетика годится для ранжирования бэкендов, а не для")
    print("  абсолютных обещаний по качеству — см. заголовок этого файла.")


if __name__ == "__main__":
    main()
