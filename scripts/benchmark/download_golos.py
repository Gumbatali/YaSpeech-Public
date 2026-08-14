#!/usr/bin/env python3
"""
Скачивает N образцов из тестового набора Golos (SberDevices) и готовит
manifest.jsonl для run-benchmark.mjs.

Golos — крупнейший русский размеченный речевой корпус. Тестовый набор
содержит два домена:
  - crowd    — речь с телефонов/гарнитур (близкий микрофон)
  - farfield — речь с дальнего микрофона умной колонки (наш кейс B3/B4)

Каждый образец сохраняется как WAV + строка в manifest.jsonl:
  { "id": "...", "audio": "data/<id>.wav", "ref": "<эталон>", "tags": [...] }

Зависимости: pip install -r requirements.txt
Использование:
  python3 download_golos.py --count 15 --domain farfield
  python3 download_golos.py --count 10 --domain crowd --out data
"""
import argparse
import json
import os
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description="Download Golos test samples")
    parser.add_argument("--count", type=int, default=15, help="сколько образцов")
    parser.add_argument(
        "--domain",
        choices=["crowd", "farfield"],
        default="farfield",
        help="домен Golos: crowd (близкий микрофон) или farfield (дальний)",
    )
    parser.add_argument("--out", default="data", help="директория для WAV + manifest")
    parser.add_argument(
        "--min-words",
        type=int,
        default=4,
        help="пропускать слишком короткие эталоны (меньше N слов)",
    )
    args = parser.parse_args()

    try:
        import soundfile as sf
        from datasets import load_dataset
    except ImportError:
        print(
            "Нужны зависимости: pip install -r scripts/benchmark/requirements.txt",
            file=sys.stderr,
        )
        return 1

    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)
    manifest_path = os.path.join(out_dir, "manifest.jsonl")

    # "SberDevices/Golos" опустел (проверено 2026-08-10 — в репозитории
    # остались только .gitattributes и README.md, ни одного файла с данными).
    # Используем зеркало bond005, у него те же данные в Parquet, по одному
    # репозиторию на домен (без параметра config).
    dataset_repo = {
        "crowd": "bond005/sberdevices_golos_10h_crowd",
        "farfield": "bond005/sberdevices_golos_100h_farfield",
    }[args.domain]

    print(f"Golos / {args.domain} / test — стримим первые ~{args.count} образцов ({dataset_repo})…")
    # streaming=True не качает весь корпус, берём только нужное.
    dataset = load_dataset(dataset_repo, split="test", streaming=True)

    written = 0
    with open(manifest_path, "w", encoding="utf-8") as manifest:
        for idx, row in enumerate(dataset):
            if written >= args.count:
                break
            # Колонка с эталоном называется "transcription" (иногда "text").
            ref = (row.get("transcription") or row.get("text") or "").strip()
            if len(ref.split()) < args.min_words:
                continue

            audio = row["audio"]
            sample_id = f"golos-{args.domain}-{written:03d}"
            wav_name = f"{sample_id}.wav"
            wav_path = os.path.join(out_dir, wav_name)
            sf.write(wav_path, audio["array"], audio["sampling_rate"])

            manifest.write(
                json.dumps(
                    {
                        "id": sample_id,
                        # относительно manifest.jsonl (он пишется в тот же out_dir,
                        # что и WAV) — таков контракт run-benchmark.mjs/build-corpus.mjs
                        "audio": wav_name,
                        "ref": ref,
                        "tags": ["golos", args.domain],
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
            written += 1
            print(f"  {sample_id}  «{ref[:60]}{'…' if len(ref) > 60 else ''}»")

    if written == 0:
        print("Ничего не записано — проверь название колонки/домена.", file=sys.stderr)
        return 1

    print(f"\n{written} образцов → {manifest_path}")
    print("   Дальше: BENCH_BASE_URL=… BENCH_LOGIN=… BENCH_PASSWORD=… \\")
    print(f"           node scripts/benchmark/run-benchmark.mjs {manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
