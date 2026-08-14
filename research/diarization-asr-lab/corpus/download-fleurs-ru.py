#!/usr/bin/env python3
"""
Downloads N samples from the Russian Google FLEURS test split and writes
manifest.jsonl in the same format as scripts/benchmark/download_golos.py
(compatible with corpus/build-corpus.mjs as-is). FLEURS has no speaker id,
so each utterance is treated as its own synthetic "speaker", same as Golos.

Usage:
  python3 download-fleurs-ru.py --count 40 --out results/fleurs-ru-raw
"""
import argparse
import json
import os
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description="Download FLEURS ru_ru test samples")
    parser.add_argument("--count", type=int, default=40)
    parser.add_argument("--out", default="data")
    parser.add_argument("--min-words", type=int, default=4)
    args = parser.parse_args()

    try:
        import soundfile as sf
        from datasets import load_dataset
    except ImportError:
        print("Нужны зависимости: pip install -r scripts/benchmark/requirements.txt", file=sys.stderr)
        return 1

    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)
    manifest_path = os.path.join(out_dir, "manifest.jsonl")

    print(f"Скачиваю FLEURS ru_ru / test — первые ~{args.count} образцов…")
    dataset = load_dataset("google/fleurs", "ru_ru", split="test", streaming=True)

    written = 0
    with open(manifest_path, "w", encoding="utf-8") as manifest:
        for row in dataset:
            if written >= args.count:
                break
            ref = (row.get("raw_transcription") or row.get("transcription") or "").strip()
            if len(ref.split()) < args.min_words:
                continue

            audio = row["audio"]
            sample_id = f"fleurs-ru-{written:03d}"
            wav_name = f"{sample_id}.wav"
            wav_path = os.path.join(out_dir, wav_name)
            sf.write(wav_path, audio["array"], audio["sampling_rate"])

            manifest.write(
                json.dumps(
                    {"id": sample_id, "audio": wav_name, "ref": ref, "tags": ["fleurs", "ru"]},
                    ensure_ascii=False,
                )
                + "\n"
            )
            written += 1
            print(f"  {sample_id}  «{ref[:60]}{'…' if len(ref) > 60 else ''}»")

    if written == 0:
        print("Ничего не записано.", file=sys.stderr)
        return 1

    print(f"\n{written} образцов -> {manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
