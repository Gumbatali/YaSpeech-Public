#!/usr/bin/env python3
"""
Post-processes an existing diarization hypothesis: segments shorter than
--min-duration are relabeled to the nearest neighboring segment's speaker
instead of keeping their own label. Works on an existing hyp.rttm without
re-running the model.

Usage (inside the pyannote.Dockerfile container):
  python filter-short-segments.py --hyp /data/x.hyp.rttm --ref /data/x.rttm \
    --min-duration 0.5 --out /data/x.filtered.hyp.rttm
"""
import argparse
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


def filter_short_segments(annotation, min_duration):
    """Сегменты короче min_duration получают метку ближайшего соседа по времени."""
    from pyannote.core import Annotation, Segment

    segments = sorted(
        ((seg, label) for seg, _, label in annotation.itertracks(yield_label=True)),
        key=lambda x: x[0].start,
    )

    relabeled = []
    for i, (seg, label) in enumerate(segments):
        if seg.duration >= min_duration:
            relabeled.append((seg, label))
            continue

        prev_gap = seg.start - segments[i - 1][0].end if i > 0 else None
        next_gap = segments[i + 1][0].start - seg.end if i + 1 < len(segments) else None

        if prev_gap is None and next_gap is None:
            new_label = label  # единственный сегмент — оставляем как есть
        elif prev_gap is None:
            new_label = segments[i + 1][1]
        elif next_gap is None:
            new_label = segments[i - 1][1]
        else:
            new_label = segments[i - 1][1] if prev_gap <= next_gap else segments[i + 1][1]

        relabeled.append((seg, new_label))

    out = Annotation(uri=annotation.uri)
    for seg, label in relabeled:
        out[seg] = label
    return out


def main():
    parser = argparse.ArgumentParser(description="Постобработка hyp.rttm: слияние коротких обрывков с соседями")
    parser.add_argument("--hyp", required=True, help="путь к гипотезе диаризации (hyp.rttm)")
    parser.add_argument("--ref", required=True, help="путь к эталонной RTTM для пересчёта DER")
    parser.add_argument("--min-duration", type=float, default=0.5, help="порог в секундах (по умолчанию 0.5)")
    parser.add_argument("--out", required=True, help="куда писать отфильтрованную RTTM")
    args = parser.parse_args()

    from pyannote.metrics.diarization import DiarizationErrorRate

    reference = parse_rttm(args.ref)
    hyp_before = parse_rttm(args.hyp)

    metric = DiarizationErrorRate()
    der_before = metric(reference, hyp_before)
    speakers_before = len(hyp_before.labels())

    hyp_after = filter_short_segments(hyp_before, args.min_duration)
    der_after = DiarizationErrorRate()(reference, hyp_after)
    speakers_after = len(hyp_after.labels())

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    annotation_to_rttm(hyp_after, Path(args.hyp).stem.replace(".hyp", ""), args.out)

    ref_speakers = len(reference.labels())
    print(f"До фильтрации:    DER={der_before*100:.1f}%  спикеров={speakers_before} (реф={ref_speakers})")
    print(f"После фильтрации: DER={der_after*100:.1f}%  спикеров={speakers_after} (реф={ref_speakers})  (порог {args.min_duration}с)")
    print(f"Отфильтрованная RTTM: {args.out}")


if __name__ == "__main__":
    raise SystemExit(main())
