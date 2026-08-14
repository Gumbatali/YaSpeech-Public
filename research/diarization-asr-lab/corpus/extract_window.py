#!/usr/bin/env python3
"""
Crops an arbitrary [start, end] time window out of an existing session's
audio and ref.json (unlike crop-session.mjs, which only trims from time 0),
writing a standalone mini-session + manifest.jsonl for isolated ASR testing.
"""
import argparse
import json
from pathlib import Path

import soundfile as sf


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--ref-json", required=True)
    parser.add_argument("--start-sec", type=float, required=True)
    parser.add_argument("--end-sec", type=float, required=True)
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    audio, sr = sf.read(args.audio, dtype="float32", always_2d=False)
    start_sample = int(args.start_sec * sr)
    end_sample = int(args.end_sec * sr)
    chunk = audio[start_sample:end_sample]
    sf.write(out_dir / f"{args.session_id}.wav", chunk, sr)

    ref = json.loads(Path(args.ref_json).read_text(encoding="utf-8"))
    kept = []
    for s in ref["segments"]:
        if s["endSec"] <= args.start_sec or s["startSec"] >= args.end_sec:
            continue
        kept.append({
            **s,
            "startSec": max(0.0, s["startSec"] - args.start_sec),
            "endSec": min(args.end_sec - args.start_sec, s["endSec"] - args.start_sec),
        })

    duration = args.end_sec - args.start_sec
    (out_dir / f"{args.session_id}.ref.json").write_text(
        json.dumps({"sessionId": args.session_id, "durationSec": duration, "segments": kept}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    manifest_entry = {
        "id": args.session_id,
        "audio": f"{args.session_id}.wav",
        "ref": f"{args.session_id}.ref.json",
        "numSpeakers": len(set(s["speaker"] for s in kept)),
        "durationSec": duration,
    }
    (out_dir / "manifest.jsonl").write_text(json.dumps(manifest_entry) + "\n", encoding="utf-8")

    print(f"{args.session_id}: {len(kept)} реплик, {duration:.1f}s -> {out_dir}")


if __name__ == "__main__":
    main()
