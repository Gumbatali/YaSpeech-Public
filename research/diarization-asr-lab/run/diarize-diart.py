#!/usr/bin/env python3
"""
Diarizes sessions with diart (no fixed speaker-slot ceiling, unlike
sortformer's 4 slots). Writes RTTM and DER in the same report format as
run/diarize.py and run/diarize-sortformer.py.

Usage (inside the diart.Dockerfile container):
  python diarize-diart.py --corpus-dir /data/corpus --out /data/out
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


SEGMENTATION_MODEL = os.environ.get("DIART_SEGMENTATION", "pyannote/segmentation-3.0")
EMBEDDING_MODEL = os.environ.get("DIART_EMBEDDING", "pyannote/wespeaker-voxceleb-resnet34-LM")

TAU_ACTIVE = float(os.environ.get("DIART_TAU_ACTIVE", "0.507"))
RHO_UPDATE = float(os.environ.get("DIART_RHO_UPDATE", "0.006"))
DELTA_NEW = float(os.environ.get("DIART_DELTA_NEW", "1.057"))
STEP_SEC = float(os.environ.get("DIART_STEP_SEC", "0.5"))
LATENCY_SEC = float(os.environ.get("DIART_LATENCY_SEC", "0.5"))


def build_pipeline_config(hf_token):
    from diart import SpeakerDiarizationConfig
    from diart.models import EmbeddingModel, SegmentationModel

    segmentation = SegmentationModel.from_pretrained(SEGMENTATION_MODEL, use_hf_token=hf_token)
    embedding = EmbeddingModel.from_pretrained(EMBEDDING_MODEL, use_hf_token=hf_token)

    return SpeakerDiarizationConfig(
        segmentation=segmentation,
        embedding=embedding,
        step=STEP_SEC,
        latency=LATENCY_SEC,
        tau_active=TAU_ACTIVE,
        rho_update=RHO_UPDATE,
        delta_new=DELTA_NEW,
    )


def diarize_file(pipeline_config, audio_path):
    from diart import SpeakerDiarization
    from diart.sources import FileAudioSource
    from diart.inference import StreamingInference

    # A fresh pipeline per file avoids speaker labels leaking between sessions.
    pipeline = SpeakerDiarization(pipeline_config)
    source = FileAudioSource(audio_path, sample_rate=16_000)
    inference = StreamingInference(
        pipeline,
        source,
        do_profile=False,
        do_plot=False,
        show_progress=False,
    )
    annotation = inference()
    if isinstance(annotation, tuple):
        annotation = annotation[0]
    return annotation


def main():
    parser = argparse.ArgumentParser(description="Diarization benchmark (diart)")
    parser.add_argument("--corpus-dir", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    hf_token = os.environ.get("HF_TOKEN")
    if not hf_token:
        print("ОШИБКА: HF_TOKEN не задан в окружении контейнера.", file=sys.stderr)
        return 1

    from pyannote.core import Annotation
    from pyannote.metrics.diarization import DiarizationErrorRate

    print(f"Загружаю модели diart ({SEGMENTATION_MODEL} + {EMBEDDING_MODEL})…")
    pipeline_config = build_pipeline_config(hf_token)

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
        hypothesis = diarize_file(pipeline_config, str(audio_path))
        elapsed = time.time() - t0

        if hypothesis is None:
            hypothesis = Annotation(uri=session_id)
        else:
            hypothesis.uri = session_id

        hyp_rttm_path = out_dir / f"{session_id}.hyp.rttm"
        annotation_to_rttm(hypothesis, session_id, hyp_rttm_path)

        session_metric = DiarizationErrorRate()
        der = session_metric(reference, hypothesis)
        overall_metric(reference, hypothesis)

        hyp_speakers = len(hypothesis.labels())
        print(
            f"  {session_id}: DER={der * 100:.1f}%  "
            f"спикеров: реф={session['numSpeakers']} гип={hyp_speakers}  "
            f"({elapsed:.1f}s, длительность {session['durationSec']:.1f}s, "
            f"RTF {elapsed / session['durationSec']:.2f}x)"
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
        "model": f"{SEGMENTATION_MODEL} + {EMBEDDING_MODEL}",
        "tauActive": TAU_ACTIVE,
        "rhoUpdate": RHO_UPDATE,
        "deltaNew": DELTA_NEW,
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
