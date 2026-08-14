#!/usr/bin/env python3
"""
Diarizes long recordings with offline Sortformer by splitting audio into
overlapping chunks, running the model per chunk, and stitching the fixed
4-slot labels back into one timeline via overlap-based label matching.

Usage (inside the sortformer.Dockerfile container):
  python diarize-sortformer-chunked.py --corpus-dir /data/corpus --out /data/out \
    --chunk-minutes 10 --overlap-sec 60
"""
import argparse
import gc
import itertools
import json
import os
import tempfile
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


def read_wav(path):
    import soundfile as sf

    audio, sr = sf.read(path, dtype="float32", always_2d=False)
    return audio, sr


def write_wav_chunk(audio, sr, start_sample, stop_sample, path):
    import soundfile as sf

    sf.write(path, audio[start_sample:stop_sample], sr)


def overlap_seconds(segs_a, segs_b, window_start, window_stop):
    total = 0.0
    for a_start, a_stop in segs_a:
        a_start, a_stop = max(a_start, window_start), min(a_stop, window_stop)
        if a_stop <= a_start:
            continue
        for b_start, b_stop in segs_b:
            b_start, b_stop = max(b_start, window_start), min(b_stop, window_stop)
            if b_stop <= b_start:
                continue
            lo, hi = max(a_start, b_start), min(a_stop, b_stop)
            if hi > lo:
                total += hi - lo
    return total


def best_label_mapping(canonical_segments, chunk_segments, window_start, window_stop):
    """Tries every permutation of chunk labels -> canonical labels (at most
    4! = 24, since slots are fixed at 4) and returns the one maximizing
    total time overlap with the already-stitched history in the overlap window."""
    canonical_labels = sorted(canonical_segments.keys())
    chunk_labels = sorted(chunk_segments.keys())

    if not canonical_labels or not chunk_labels:
        return {label: label for label in chunk_labels}

    best_score = -1.0
    best_mapping = {label: label for label in chunk_labels}

    for perm in itertools.permutations(canonical_labels, len(chunk_labels)):
        mapping = dict(zip(chunk_labels, perm))
        score = sum(
            overlap_seconds(
                canonical_segments.get(canon_label, []),
                chunk_segments[chunk_label],
                window_start,
                window_stop,
            )
            for chunk_label, canon_label in mapping.items()
        )
        if score > best_score:
            best_score = score
            best_mapping = mapping

    return best_mapping


def diarize_chunked(model, wav_path, chunk_sec, overlap_sec, tmp_dir):
    audio, sr = read_wav(wav_path)
    total_sec = len(audio) / sr
    chunk_samples = int(chunk_sec * sr)
    overlap_samples = int(overlap_sec * sr)
    step_samples = chunk_samples - overlap_samples
    if step_samples <= 0:
        raise ValueError("overlap_sec должен быть меньше chunk_sec")

    canonical = {}  # label -> list[(start, stop)] in absolute time
    chunk_idx = 0
    offset_samples = 0

    while offset_samples < len(audio):
        chunk_start_sample = offset_samples
        chunk_stop_sample = min(offset_samples + chunk_samples, len(audio))
        chunk_start_sec = chunk_start_sample / sr
        chunk_stop_sec = chunk_stop_sample / sr

        chunk_path = os.path.join(tmp_dir, f"chunk-{chunk_idx:03d}.wav")
        write_wav_chunk(audio, sr, chunk_start_sample, chunk_stop_sample, chunk_path)

        predictions = model.diarize(audio=[chunk_path], batch_size=1)
        local_segments = predictions_to_segments(
            predictions[0] if predictions and isinstance(predictions[0], list) else predictions
        )
        os.remove(chunk_path)
        gc.collect()

        chunk_by_label = {}
        for label, start, stop in local_segments:
            chunk_by_label.setdefault(label, []).append((start + chunk_start_sec, stop + chunk_start_sec))

        if chunk_idx == 0:
            canonical = chunk_by_label
            cut_point = chunk_stop_sec
        else:
            window_start = chunk_start_sec
            window_stop = min(chunk_start_sec + overlap_sec, chunk_stop_sec)
            mapping = best_label_mapping(canonical, chunk_by_label, window_start, window_stop)

            # Cut the stitched timeline at the overlap window's midpoint:
            # keep canonical history before it, take the current chunk after it.
            cut_point = window_start + overlap_sec / 2

            for label in list(canonical.keys()):
                canonical[label] = [(s, e) for s, e in canonical[label] if s < cut_point]

            for chunk_label, segs in chunk_by_label.items():
                canon_label = mapping.get(chunk_label, chunk_label)
                kept = [(max(s, cut_point), e) for s, e in segs if e > cut_point]
                canonical.setdefault(canon_label, []).extend(kept)

        chunk_idx += 1
        offset_samples += step_samples
        if chunk_stop_sample >= len(audio):
            break

    flat = []
    for label, segs in canonical.items():
        for s, e in segs:
            if e > s:
                flat.append((label, s, e))
    flat.sort(key=lambda x: (x[1], x[2]))
    return flat, chunk_idx


def main():
    parser = argparse.ArgumentParser(description="Diarization benchmark (offline Sortformer, ручной чанкинг)")
    parser.add_argument("--corpus-dir", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--model", default="nvidia/diar_sortformer_4spk-v1")
    parser.add_argument("--chunk-minutes", type=float, default=10.0)
    parser.add_argument("--overlap-sec", type=float, default=60.0)
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

    with tempfile.TemporaryDirectory() as tmp_dir:
        for session in sessions:
            session_id = session["id"]
            audio_path = corpus_dir / session["audio"]
            ref_rttm_path = corpus_dir / session["rttm"]
            reference = parse_rttm(ref_rttm_path)

            t0 = time.time()
            segments, num_chunks = diarize_chunked(
                model, str(audio_path), args.chunk_minutes * 60, args.overlap_sec, tmp_dir
            )
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
                f"({elapsed:.1f}s, {num_chunks} кусков, длительность {session['durationSec']:.1f}s, "
                f"RTF {elapsed / session['durationSec']:.2f}x)"
            )

            per_session.append({
                "sessionId": session_id,
                "der": der,
                "refSpeakers": session["numSpeakers"],
                "hypSpeakers": hyp_speakers,
                "elapsedSec": elapsed,
                "numChunks": num_chunks,
                "durationSec": session["durationSec"],
                "rtf": elapsed / session["durationSec"] if session["durationSec"] else None,
            })

    overall_der = abs(overall_metric)

    report = {
        "model": args.model,
        "fixedSpeakerSlots": 4,
        "chunkMinutes": args.chunk_minutes,
        "overlapSec": args.overlap_sec,
        "overallDer": overall_der,
        "sessions": per_session,
    }
    report_path = out_dir / "der-report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\nAgregate DER: {overall_der * 100:.1f}% по {len(per_session)} сессиям")
    print(f"Отчёт: {report_path}")


if __name__ == "__main__":
    main()
