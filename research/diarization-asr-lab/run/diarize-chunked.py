#!/usr/bin/env python3
"""
Diarizes long recordings with pyannote by splitting audio into overlapping
chunks and stitching labels back into one timeline. Unlike sortformer's fixed
4 slots, pyannote's label count varies per chunk, so stitching uses the
Hungarian algorithm on a rectangular time-overlap matrix instead of a
permutation search; unmatched chunk labels become new speakers.

Usage (inside the pyannote.Dockerfile container):
  python diarize-chunked.py --corpus-dir /data/corpus --out /data/out \
    --chunk-minutes 10 --overlap-sec 60
"""
import argparse
import gc
import json
import os
import sys
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


def best_label_mapping(canonical_segments, chunk_segments, window_start, window_stop, next_label_id):
    """Hungarian assignment on the time-overlap matrix in the overlap window.
    Unmatched labels (no real overlap) get a fresh SPEAKER_NN id."""
    import numpy as np
    from scipy.optimize import linear_sum_assignment

    canonical_labels = sorted(canonical_segments.keys())
    chunk_labels = sorted(chunk_segments.keys())

    mapping = {}

    if not canonical_labels or not chunk_labels:
        for label in chunk_labels:
            mapping[label] = f"SPEAKER_{next_label_id:02d}"
            next_label_id += 1
        return mapping, next_label_id

    cost = np.zeros((len(chunk_labels), len(canonical_labels)))
    for i, c_label in enumerate(chunk_labels):
        for j, canon_label in enumerate(canonical_labels):
            score = overlap_seconds(
                chunk_segments[c_label], canonical_segments.get(canon_label, []), window_start, window_stop
            )
            cost[i, j] = -score

    row_ind, col_ind = linear_sum_assignment(cost)

    matched_chunk_labels = set()
    for i, j in zip(row_ind, col_ind):
        score = -cost[i, j]
        if score > 0:
            mapping[chunk_labels[i]] = canonical_labels[j]
            matched_chunk_labels.add(chunk_labels[i])

    for label in chunk_labels:
        if label not in matched_chunk_labels:
            mapping[label] = f"SPEAKER_{next_label_id:02d}"
            next_label_id += 1

    return mapping, next_label_id


def diarize_chunked(pipeline, wav_path, chunk_sec, overlap_sec, tmp_dir, kwargs):
    audio, sr = read_wav(wav_path)
    chunk_samples = int(chunk_sec * sr)
    overlap_samples = int(overlap_sec * sr)
    step_samples = chunk_samples - overlap_samples
    if step_samples <= 0:
        raise ValueError("overlap_sec должен быть меньше chunk_sec")

    canonical = {}
    next_label_id = 0
    chunk_idx = 0
    offset_samples = 0

    while offset_samples < len(audio):
        chunk_start_sample = offset_samples
        chunk_stop_sample = min(offset_samples + chunk_samples, len(audio))
        chunk_start_sec = chunk_start_sample / sr
        chunk_stop_sec = chunk_stop_sample / sr

        chunk_path = os.path.join(tmp_dir, f"chunk-{chunk_idx:03d}.wav")
        write_wav_chunk(audio, sr, chunk_start_sample, chunk_stop_sample, chunk_path)

        local_annotation = pipeline(chunk_path, **kwargs)
        os.remove(chunk_path)
        gc.collect()

        chunk_by_label = {}
        for segment, _, label in local_annotation.itertracks(yield_label=True):
            chunk_by_label.setdefault(label, []).append(
                (segment.start + chunk_start_sec, segment.end + chunk_start_sec)
            )

        if chunk_idx == 0:
            canonical = chunk_by_label
            next_label_id = len(canonical)
        else:
            window_start = chunk_start_sec
            window_stop = min(chunk_start_sec + overlap_sec, chunk_stop_sec)
            mapping, next_label_id = best_label_mapping(
                canonical, chunk_by_label, window_start, window_stop, next_label_id
            )

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
    parser = argparse.ArgumentParser(description="Diarization benchmark (pyannote, ручной чанкинг)")
    parser.add_argument("--corpus-dir", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--model", default="pyannote/speaker-diarization-3.1")
    parser.add_argument("--chunk-minutes", type=float, default=10.0)
    parser.add_argument("--overlap-sec", type=float, default=60.0)
    args = parser.parse_args()

    hf_token = os.environ.get("HF_TOKEN")
    if not hf_token:
        print("ОШИБКА: HF_TOKEN не задан в окружении контейнера.", file=sys.stderr)
        return 1

    from pyannote.audio import Pipeline
    from pyannote.core import Annotation, Segment
    from pyannote.metrics.diarization import DiarizationErrorRate

    print(f"Загружаю пайплайн {args.model}…")
    pipeline = Pipeline.from_pretrained(args.model, use_auth_token=hf_token)

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
                pipeline, str(audio_path), args.chunk_minutes * 60, args.overlap_sec, tmp_dir, {}
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
        "chunkMinutes": args.chunk_minutes,
        "overlapSec": args.overlap_sec,
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
