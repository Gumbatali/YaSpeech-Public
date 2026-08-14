#!/usr/bin/env python3
"""
Diarizes sessions with offline NeMo Sortformer (fixed 4 speaker slots,
native multi-label overlap support), writing RTTM and DER in the same
report format as run/diarize.py.

Usage (inside the sortformer.Dockerfile container):
  python diarize-sortformer.py --corpus-dir /data/corpus --out /data/out
"""
import argparse
import json
import os
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


THRESHOLD = float(os.environ.get("SORTFORMER_THRESHOLD", "0.5"))
MIN_SEGMENT_SEC = float(os.environ.get("MIN_SEGMENT_SEC", "0.20"))
MAX_GAP_SEC = float(os.environ.get("MAX_GAP_SEC", "0.30"))
FRAME_SEC = float(os.environ.get("FRAME_SEC", "0.08"))


def predictions_to_segments(predictions):
    if not predictions:
        return []
    first = predictions[0]
    if isinstance(first, (list, tuple)) and first and isinstance(first[0], str):
        return _parse_prediction_strings(first)
    if isinstance(first, str):
        return _parse_prediction_strings(predictions)
    return _binarize_probabilities(first)


def _parse_prediction_strings(rows):
    segments = []
    for row in rows:
        parts = str(row).split()
        if len(parts) < 3:
            continue
        try:
            start, stop = float(parts[0]), float(parts[1])
        except ValueError:
            continue
        segments.append((str(parts[2]), start, stop))
    return segments


def _binarize_probabilities(probs):
    import numpy as np

    array = probs.detach().cpu().numpy() if hasattr(probs, "detach") else np.asarray(probs)
    if array.ndim != 2:
        return []

    segments = []
    for slot in range(array.shape[1]):
        active = array[:, slot] >= THRESHOLD
        for start_frame, stop_frame in _contiguous_runs(active):
            segments.append((f"SPEAKER_{slot:02d}", start_frame * FRAME_SEC, stop_frame * FRAME_SEC))
    return _smooth(segments)


def _contiguous_runs(mask):
    runs = []
    start = None
    for i, value in enumerate(mask):
        if value and start is None:
            start = i
        elif not value and start is not None:
            runs.append((start, i))
            start = None
    if start is not None:
        runs.append((start, len(mask)))
    return runs


def _smooth(segments):
    by_speaker = {}
    for speaker, start, stop in segments:
        by_speaker.setdefault(speaker, []).append((start, stop))

    out = []
    for speaker, group in by_speaker.items():
        group.sort(key=lambda s: s[0])
        merged = []
        for start, stop in group:
            if merged and start - merged[-1][1] <= MAX_GAP_SEC:
                merged[-1] = (merged[-1][0], max(merged[-1][1], stop))
            else:
                merged.append((start, stop))
        out.extend((speaker, s, e) for s, e in merged if e - s >= MIN_SEGMENT_SEC)

    out.sort(key=lambda s: (s[1], s[2]))
    return out


def main():
    parser = argparse.ArgumentParser(description="Diarization benchmark (NeMo Sortformer, offline)")
    parser.add_argument("--corpus-dir", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--model", default="nvidia/diar_sortformer_4spk-v1")
    args = parser.parse_args()

    from nemo.collections.asr.models import SortformerEncLabelModel
    from pyannote.core import Annotation, Segment
    from pyannote.metrics.diarization import DiarizationErrorRate
    import torch

    print(f"Загружаю модель {args.model}…")
    model = SortformerEncLabelModel.from_pretrained(args.model)
    model.eval()
    if torch.cuda.is_available():
        model = model.cuda()
        print("CUDA доступна, использую GPU")
    else:
        print("CUDA недоступна, работаю на CPU")

    corpus_dir = Path(args.corpus_dir)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    manifest_path = corpus_dir / "manifest.jsonl"
    sessions = [json.loads(l) for l in manifest_path.read_text(encoding="utf-8").splitlines() if l.strip()]

    overall_metric = DiarizationErrorRate()
    per_session = []

    import time

    for session in sessions:
        session_id = session["id"]
        audio_path = corpus_dir / session["audio"]
        ref_rttm_path = corpus_dir / session["rttm"]
        reference = parse_rttm(ref_rttm_path)

        t0 = time.time()
        predictions = model.diarize(audio=[str(audio_path)], batch_size=1)
        segments = predictions_to_segments(predictions[0] if predictions and isinstance(predictions[0], list) else predictions)
        elapsed = time.time() - t0

        hypothesis = Annotation(uri=session_id)
        for speaker, start, stop in segments:
            if stop > start:
                hypothesis[Segment(start, stop)] = speaker

        hyp_rttm_path = out_dir / f"{session_id}.hyp.rttm"
        annotation_to_rttm(hypothesis, session_id, hyp_rttm_path)

        session_metric = DiarizationErrorRate()
        der = session_metric(reference, hypothesis)
        overall_metric(reference, hypothesis)

        hyp_speakers = len(hypothesis.labels())
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

    overall_der = abs(overall_metric)

    report = {
        "model": args.model,
        "fixedSpeakerSlots": 4,
        "overallDer": overall_der,
        "sessions": per_session,
    }
    report_path = out_dir / "der-report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\nAgregate DER: {overall_der * 100:.1f}% по {len(per_session)} сессиям")
    print(f"Отчёт: {report_path}")


if __name__ == "__main__":
    main()
