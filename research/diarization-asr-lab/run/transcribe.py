#!/usr/bin/env python3
"""
Прогоняет faster-whisper (CPU, int8) по сессиям синтетического корпуса,
пишет гипотезу текста с таймкодами сегментов на сессию.

Скоринг (WER/cpWER) делается отдельно в score/*.mjs — этот скрипт только
транскрибирует и сохраняет сырой результат.

Запуск (внутри контейнера whisper.Dockerfile):
  python transcribe.py --corpus-dir /data/corpus --out /data/results \
    [--model medium] [--language ru]
"""
import argparse
import json
import time
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description="ASR benchmark (faster-whisper)")
    parser.add_argument("--corpus-dir", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--model", default="medium",
                         help="faster-whisper model size (tiny/base/small/medium/large-v3)")
    parser.add_argument("--language", default="ru")
    args = parser.parse_args()

    from faster_whisper import WhisperModel

    print(f"Загружаю модель {args.model} (CPU, int8)…")
    model = WhisperModel(args.model, device="cpu", compute_type="int8")

    corpus_dir = Path(args.corpus_dir)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    manifest_path = corpus_dir / "manifest.jsonl"
    sessions = [json.loads(l) for l in manifest_path.read_text(encoding="utf-8").splitlines() if l.strip()]

    report_sessions = []

    for session in sessions:
        session_id = session["id"]
        audio_path = corpus_dir / session["audio"]

        t0 = time.time()
        segments_iter, info = model.transcribe(str(audio_path), language=args.language)
        segments = [
            {"start": s.start, "end": s.end, "text": s.text.strip()}
            for s in segments_iter
        ]
        elapsed = time.time() - t0

        full_text = " ".join(s["text"] for s in segments)

        hyp_path = out_dir / f"{session_id}.asr.json"
        hyp_path.write_text(
            json.dumps({"sessionId": session_id, "segments": segments, "text": full_text}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        rtf = elapsed / session["durationSec"] if session["durationSec"] else None
        print(f"  {session_id}: {len(segments)} сегментов, {elapsed:.1f}s (RTF {rtf:.2f}x)" if rtf else f"  {session_id}: {len(segments)} сегментов")

        report_sessions.append({
            "sessionId": session_id,
            "segments": len(segments),
            "elapsedSec": elapsed,
            "durationSec": session["durationSec"],
            "rtf": rtf,
        })

    report = {"model": args.model, "language": args.language, "sessions": report_sessions}
    report_path = out_dir / "asr-run-report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nОтчёт: {report_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
