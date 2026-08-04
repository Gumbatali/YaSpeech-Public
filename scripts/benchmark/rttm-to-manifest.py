#!/usr/bin/env python3
"""
Конвертер RTTM → манифест бенчмарка.

RTTM — стандартный формат разметки диаризации (NIST). В нём размечены
VoxConverse, AMI, CALLHOME, DIHARD и почти всё остальное публичное.
Поддержав его, мы получаем доступ к реальным размеченным корпусам вместо
синтетики.

Формат строки RTTM:
  SPEAKER <file> <chan> <start> <duration> <NA> <NA> <speaker> <NA> <NA>

Обрати внимание: в RTTM четвёртое поле — ДЛИТЕЛЬНОСТЬ, а не время конца.
Перепутать их — классическая ошибка, дающая бессмысленный DER.

Пример:
  python3 rttm-to-manifest.py --rttm-dir corpus/rttm/dev --audio-dir corpus/wav \\
      --out corpus/manifest.jsonl
"""

from __future__ import annotations

import argparse
import json
import os
import wave


def parse_rttm(path: str) -> list[dict]:
    """Читает RTTM и возвращает сегменты в формате контракта."""
    segments = []

    for line in open(path, encoding="utf-8"):
        parts = line.split()
        if len(parts) < 8 or parts[0] != "SPEAKER":
            continue

        start = float(parts[3])
        duration = float(parts[4])  # именно длительность, не время конца
        speaker = parts[7]

        if duration <= 0:
            continue

        segments.append(
            {"speaker": speaker, "start": round(start, 3), "stop": round(start + duration, 3)}
        )

    segments.sort(key=lambda s: (s["start"], s["stop"]))
    return segments


def audio_duration(path: str) -> float | None:
    try:
        with wave.open(path, "rb") as w:
            return round(w.getnframes() / w.getframerate(), 2)
    except Exception:
        return None


def overlap_ratio(segments: list[dict]) -> float:
    """Доля времени с одновременной речью — главный показатель сложности."""
    speech = sum(s["stop"] - s["start"] for s in segments)
    if speech <= 0:
        return 0.0

    overlap = 0.0
    for i, a in enumerate(segments):
        for b in segments[i + 1 :]:
            if b["start"] >= a["stop"]:
                break
            overlap += min(a["stop"], b["stop"]) - b["start"]

    return overlap / speech * 100


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--rttm-dir", required=True)
    ap.add_argument("--audio-dir", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--only", help="файл со списком id (по одному на строку)")
    args = ap.parse_args()

    wanted = None
    if args.only and os.path.exists(args.only):
        wanted = {line.strip() for line in open(args.only) if line.strip()}

    written = 0
    with open(args.out, "w", encoding="utf-8") as out:
        for filename in sorted(os.listdir(args.audio_dir)):
            if not filename.lower().endswith(".wav"):
                continue

            file_id = os.path.splitext(filename)[0]
            if wanted and file_id not in wanted:
                continue

            rttm_path = os.path.join(args.rttm_dir, f"{file_id}.rttm")
            if not os.path.exists(rttm_path):
                print(f"  ! нет разметки для {file_id}, пропускаю")
                continue

            segments = parse_rttm(rttm_path)
            if not segments:
                continue

            speakers = sorted({s["speaker"] for s in segments})
            duration = audio_duration(os.path.join(args.audio_dir, filename))

            out.write(
                json.dumps(
                    {
                        "id": file_id,
                        "audio": filename,
                        "reference": segments,
                        "num_speakers": len(speakers),
                        "duration_sec": duration,
                        "tags": ["voxconverse", f"spk{len(speakers)}"],
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )

            print(
                f"  {file_id}: {duration:.0f}с, {len(speakers)} спикеров, "
                f"{len(segments)} сегментов, перекрытий {overlap_ratio(segments):.1f}%"
            )
            written += 1

    print(f"\n✓ {written} записей → {args.out}")


if __name__ == "__main__":
    main()
