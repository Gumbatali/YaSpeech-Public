#!/usr/bin/env python3
"""
Diarizes sessions with pyannote.audio, writes hypothesis RTTM, and computes
DER against the reference RTTM via pyannote.metrics. num_speakers is not
passed to the pipeline by default; enable with --hint-num-speakers.

Usage (inside the pyannote.Dockerfile container):
  python diarize.py --corpus-dir /data/corpus --out /data/results \
    [--model pyannote/speaker-diarization-3.1] [--hint-num-speakers]

HF_TOKEN должен быть в окружении контейнера (--env HF_TOKEN=$HF_TOKEN).
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path


def parse_rttm(path):
    from pyannote.core import Annotation, Segment

    annotation = Annotation()
    with open(path, encoding="utf-8") as f:
        for line in f:
            parts = line.strip().split()
            if not parts or parts[0] != "SPEAKER":
                continue
            start = float(parts[3])
            duration = float(parts[4])
            speaker = parts[7]
            annotation[Segment(start, start + duration)] = speaker
    return annotation


def annotation_to_rttm(annotation, uri, path):
    with open(path, "w", encoding="utf-8") as f:
        for segment, _, speaker in annotation.itertracks(yield_label=True):
            f.write(
                f"SPEAKER {uri} 1 {segment.start:.3f} {segment.duration:.3f} "
                f"<NA> <NA> {speaker} <NA> <NA>\n"
            )


def main():
    parser = argparse.ArgumentParser(description="Diarization benchmark (pyannote.audio)")
    parser.add_argument("--corpus-dir", required=True, help="директория с manifest.jsonl из build-corpus.mjs")
    parser.add_argument("--out", required=True, help="куда писать гипотезы и отчёт")
    parser.add_argument("--model", default="pyannote/speaker-diarization-3.1")
    parser.add_argument("--hint-num-speakers", action="store_true",
                         help="передавать num_speakers пайплайну (по умолчанию выключено)")
    parser.add_argument("--min-speakers", type=int, default=None,
                         help="мягкая нижняя граница числа спикеров (в отличие от num_speakers, не фиксирует точное число)")
    parser.add_argument("--max-speakers", type=int, default=None,
                         help="мягкая верхняя граница числа спикеров")
    parser.add_argument("--clustering-threshold", type=float, default=None,
                         help="переопределить порог агломеративной кластеризации (по умолчанию — из конфига модели). "
                              "Выше — охотнее сливает кластеры (меньше спикеров), ниже — охотнее дробит.")
    args = parser.parse_args()

    hf_token = os.environ.get("HF_TOKEN")
    if not hf_token:
        print("ОШИБКА: HF_TOKEN не задан в окружении контейнера.", file=sys.stderr)
        return 1

    from pyannote.audio import Pipeline
    from pyannote.metrics.diarization import DiarizationErrorRate

    print(f"Загружаю пайплайн {args.model}…")
    pipeline = Pipeline.from_pretrained(args.model, use_auth_token=hf_token)

    if args.clustering_threshold is not None:
        params = pipeline.parameters(instantiated=True)
        old_threshold = params["clustering"]["threshold"]
        params["clustering"]["threshold"] = args.clustering_threshold
        pipeline.instantiate(params)
        print(f"clustering.threshold переопределён: {old_threshold:.4f} -> {args.clustering_threshold:.4f}")

    corpus_dir = Path(args.corpus_dir)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    manifest_path = corpus_dir / "manifest.jsonl"
    sessions = [json.loads(l) for l in manifest_path.read_text(encoding="utf-8").splitlines() if l.strip()]

    overall_metric = DiarizationErrorRate()
    per_session = []

    for session in sessions:
        session_id = session["id"]
        audio_path = corpus_dir / session["audio"]
        ref_rttm_path = corpus_dir / session["rttm"]

        reference = parse_rttm(ref_rttm_path)

        kwargs = {}
        if args.hint_num_speakers:
            kwargs["num_speakers"] = session["numSpeakers"]
        if args.min_speakers is not None:
            kwargs["min_speakers"] = args.min_speakers
        if args.max_speakers is not None:
            kwargs["max_speakers"] = args.max_speakers

        t0 = time.time()
        diarization = pipeline(str(audio_path), **kwargs)
        elapsed = time.time() - t0

        hyp_rttm_path = out_dir / f"{session_id}.hyp.rttm"
        annotation_to_rttm(diarization, session_id, hyp_rttm_path)

        session_metric = DiarizationErrorRate()
        der = session_metric(reference, diarization)
        overall_metric(reference, diarization)

        hyp_speakers = len(diarization.labels())
        print(
            f"  {session_id}: DER={der * 100:.1f}%  "
            f"спикеров: реф={session['numSpeakers']} гип={hyp_speakers}  "
            f"({elapsed:.1f}s, длительность {session['durationSec']:.1f}s)"
        )

        per_session.append({
            "sessionId": session_id,
            "der": der,
            "refSpeakers": session["numSpeakers"],
            "hypSpeakers": hyp_speakers,
            "elapsedSec": elapsed,
            "durationSec": session["durationSec"],
            "rtf": elapsed / session["durationSec"] if session["durationSec"] else None,
        })

    overall_der = abs(overall_metric)  # pyannote.metrics: abs(metric) == агрегированное значение

    report = {
        "model": args.model,
        "hintNumSpeakers": args.hint_num_speakers,
        "minSpeakers": args.min_speakers,
        "maxSpeakers": args.max_speakers,
        "clusteringThreshold": args.clustering_threshold,
        "overallDer": overall_der,
        "sessions": per_session,
    }
    report_path = out_dir / "der-report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\nAgregate DER: {overall_der * 100:.1f}% по {len(per_session)} сессиям")
    print(f"Отчёт: {report_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
