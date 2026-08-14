#!/usr/bin/env python3
"""
Diarizes sessions with NeMo Streaming Sortformer
(`nvidia/diar_streaming_sortformer_4spk-v2.1`), feeding audio in fixed-size
chunks with carried-over state so memory stays bounded regardless of
recording length. Writes RTTM and DER in the same report format as
run/diarize.py and run/diarize-sortformer.py.

Usage (inside the sortformer.Dockerfile container):
  python diarize-sortformer-streaming.py --corpus-dir /data/corpus --out /data/out
"""
import argparse
import json
import os
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


MODEL_ID_DEFAULT = "nvidia/diar_streaming_sortformer_4spk-v2.1"
SAMPLE_RATE = 16_000
THRESHOLD = float(os.environ.get("SORTFORMER_THRESHOLD", "0.5"))
FRAME_SEC = float(os.environ.get("FRAME_SEC", "0.08"))
MIN_SEGMENT_SEC = float(os.environ.get("MIN_SEGMENT_SEC", "0.20"))
MAX_GAP_SEC = float(os.environ.get("MAX_GAP_SEC", "0.30"))
CHUNK_SEC = float(os.environ.get("STREAM_CHUNK_SEC", "2.0"))


def load_audio_16k_mono(path):
    import librosa

    samples, _ = librosa.load(path, sr=SAMPLE_RATE, mono=True)
    return samples


def forward_chunk(model, tensor, length, state):
    """NeMo has changed the streaming-step signature across versions; try
    known variants in order so a nemo_toolkit upgrade doesn't fail silently."""
    if hasattr(model, "forward_streaming_step"):
        out = model.forward_streaming_step(
            processed_signal=tensor, processed_signal_length=length, streaming_state=state
        )
        if isinstance(out, tuple):
            return out[0], out[1] if len(out) > 1 else None
        return out, state

    preds = model.forward(input_signal=tensor, input_signal_length=length)
    if isinstance(preds, tuple):
        preds = preds[0]
    return (preds.squeeze(0) if preds.ndim == 3 else preds), state


def diarize_streaming(model, audio_path):
    import numpy as np
    import torch

    samples = load_audio_16k_mono(audio_path)
    chunk_samples = int(CHUNK_SEC * SAMPLE_RATE)

    probabilities = []
    state = None

    with torch.inference_mode():
        for offset in range(0, len(samples), chunk_samples):
            chunk = samples[offset: offset + chunk_samples]
            if len(chunk) == 0:
                continue

            tensor = torch.from_numpy(np.asarray(chunk, dtype="float32")).unsqueeze(0)
            length = torch.tensor([tensor.shape[1]])

            if torch.cuda.is_available():
                tensor, length = tensor.cuda(), length.cuda()

            probs, state = forward_chunk(model, tensor, length, state)
            if probs is not None:
                probabilities.append(probs.detach().cpu().numpy())

    if not probabilities:
        return []

    return binarize(np.concatenate(probabilities, axis=0))


def binarize(array):
    if array.ndim != 2:
        return []

    segments = []
    for slot in range(array.shape[1]):
        active = array[:, slot] >= THRESHOLD
        run_start = None
        for i, value in enumerate(active):
            if value and run_start is None:
                run_start = i
            elif not value and run_start is not None:
                segments.append((f"SPEAKER_{slot:02d}", run_start * FRAME_SEC, i * FRAME_SEC))
                run_start = None
        if run_start is not None:
            segments.append((f"SPEAKER_{slot:02d}", run_start * FRAME_SEC, len(active) * FRAME_SEC))

    return smooth(segments)


def smooth(segments):
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
    parser = argparse.ArgumentParser(description="Diarization benchmark (NeMo Streaming Sortformer)")
    parser.add_argument("--corpus-dir", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--model", default=MODEL_ID_DEFAULT)
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

    if hasattr(model, "setup_streaming_params"):
        model.setup_streaming_params()

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

        t0 = time.time()
        segments = diarize_streaming(model, str(audio_path))
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
            f"({elapsed:.1f}s, длительность {session['durationSec']:.1f}s, RTF {elapsed / session['durationSec']:.2f}x)"
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
        "streamingChunkSec": CHUNK_SEC,
        "overallDer": overall_der,
        "sessions": per_session,
    }
    report_path = out_dir / "der-report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\nAgregate DER: {overall_der * 100:.1f}% по {len(per_session)} сессиям")
    print(f"Отчёт: {report_path}")


if __name__ == "__main__":
    main()
