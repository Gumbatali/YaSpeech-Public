#!/usr/bin/env python3
"""
Merges pyannote diarization labels whose voice embeddings are near-identical,
even if the segments are far apart in time. Post-processing over an existing
RTTM hypothesis — does not touch the time axis or re-run diarization.

Usage (inside the pyannote.Dockerfile container):
  python merge-clusters.py --audio /data/corpus/session-ami-ES2002b.wav \
    --hyp-rttm /data/hyp/session-ami-ES2002b.hyp.rttm \
    --ref-rttm /data/corpus/session-ami-ES2002b.rttm \
    --out /data/out --min-similarity 0.4
"""
import argparse
import itertools
import json
import os
import sys
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
    parser = argparse.ArgumentParser(description="Слияние кластеров диаризации по эмбеддингу голоса")
    parser.add_argument("--audio", required=True)
    parser.add_argument("--hyp-rttm", required=True)
    parser.add_argument("--ref-rttm", required=True)
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--embedding-model", default="pyannote/wespeaker-voxceleb-resnet34-LM")
    parser.add_argument("--min-similarity", type=float, default=0.4,
                         help="взаимно-ближайшая пара сливается только если сходство не ниже этого пола")
    parser.add_argument("--max-segments-per-label", type=int, default=10,
                         help="сколько самых длинных сегментов метки использовать для эмбеддинга")
    parser.add_argument("--min-segment-sec", type=float, default=1.0,
                         help="сегменты короче этого не берём — шумный эмбеддинг на обрывках")
    parser.add_argument("--max-rounds", type=int, default=1,
                         help="сколько раз повторять слияние, каждый раз заново считая разрыв на том, "
                              "что осталось после предыдущего раунда, с проверкой DER — останавливается, "
                              "если раунд ничего не слил или DER стал хуже, чем на предыдущем раунде")
    args = parser.parse_args()

    hf_token = os.environ.get("HF_TOKEN")
    if not hf_token:
        print("ОШИБКА: HF_TOKEN не задан в окружении контейнера.", file=sys.stderr)
        return 1

    import numpy as np
    from pyannote.audio import Model, Inference
    from pyannote.core import Annotation
    from pyannote.metrics.diarization import DiarizationErrorRate

    print(f"Загружаю модель эмбеддингов {args.embedding_model}…")
    embedding_model = Model.from_pretrained(args.embedding_model, use_auth_token=hf_token)
    inference = Inference(embedding_model, window="whole")

    hypothesis = parse_rttm(args.hyp_rttm)
    reference = parse_rttm(args.ref_rttm)

    by_label = {}
    for segment, _, label in hypothesis.itertracks(yield_label=True):
        if segment.duration >= args.min_segment_sec:
            by_label.setdefault(label, []).append(segment)

    labels = sorted(by_label.keys())
    print(f"Меток в гипотезе: {len(labels)} -> {labels}")

    centroids = {}
    weights = {}
    for label in labels:
        segments = sorted(by_label[label], key=lambda s: -s.duration)[: args.max_segments_per_label]
        embeddings = []
        for seg in segments:
            emb = inference.crop(args.audio, seg)
            if emb is not None:
                embeddings.append(np.asarray(emb).reshape(-1))
        if not embeddings:
            print(f"  ! {label}: нет сегментов длиннее {args.min_segment_sec}с, пропуск (не участвует в слиянии)")
            continue
        centroid = np.mean(embeddings, axis=0)
        centroid = centroid / (np.linalg.norm(centroid) + 1e-8)
        centroids[label] = centroid
        weights[label] = sum(s.duration for s in segments)
        print(f"  {label}: {len(segments)} сегментов, суммарно {weights[label]:.1f}с -> эмбеддинг готов")

    def similarity(a, b):
        return float(np.dot(centroids[a], centroids[b]))

    print("\nМатрица косинусного сходства (до слияния):")
    for a in centroids:
        row = [f"{a:>8}"]
        for b in centroids:
            row.append(f"{(1.0 if a == b else similarity(a, b)):>10.3f}")
        print(" ".join(row))

    def find_factory(parent):
        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x
        return find

    def build_hypothesis(parent, find):
        merged = Annotation(uri=args.session_id)
        for segment, track, label in hypothesis.itertracks(yield_label=True):
            new_label = find(label) if label in parent else label
            merged[segment, track] = new_label
        return merged

    def compute_der(hyp):
        # DiarizationErrorRate() accumulates state across calls, so a fresh
        # instance is required per call or later rounds get skewed by earlier ones.
        return DiarizationErrorRate()(reference, hyp)

    active = set(centroids.keys())
    parent = {label: label for label in labels}
    find = find_factory(parent)

    best_parent = dict(parent)
    best_der = compute_der(build_hypothesis(parent, find))
    print(f"\nDER до слияния (раунд 0): {best_der * 100:.2f}%")

    all_merged_pairs = []
    round_num = 0

    # Each round finds the largest gap in the sorted similarity distribution
    # among still-active labels and merges only mutual-nearest-neighbor pairs
    # above that gap. A DER regression after merging rolls back to the last
    # good state and stops.
    while round_num < args.max_rounds and len(active) >= 2:
        round_num += 1
        all_sims = sorted(
            (similarity(a, b) for a, b in itertools.combinations(active, 2)),
            reverse=True,
        )
        gaps = [(all_sims[i] - all_sims[i + 1], i) for i in range(len(all_sims) - 1)]
        if gaps:
            best_gap, gap_idx = max(gaps)
            adaptive_threshold = (all_sims[gap_idx] + all_sims[gap_idx + 1]) / 2
        else:
            best_gap, adaptive_threshold = 0.0, 1.0
        effective_threshold = max(adaptive_threshold, args.min_similarity)
        print(
            f"\nРаунд {round_num}: сходства (убыв.) {[round(s, 3) for s in all_sims]}\n"
            f"  наибольший разрыв {best_gap:.3f} -> порог {adaptive_threshold:.3f} "
            f"(эффективный, с полом {args.min_similarity}: {effective_threshold:.3f})"
        )

        nearest = {}
        for a in active:
            best_b, best_sim = None, -1.0
            for b in active:
                if a == b:
                    continue
                sim = similarity(a, b)
                if sim > best_sim:
                    best_sim, best_b = sim, b
            nearest[a] = (best_b, best_sim)

        round_pairs = []
        seen = set()
        for a in active:
            b, sim = nearest[a]
            if b is None or sim < effective_threshold:
                continue
            if nearest[b][0] == a and frozenset((a, b)) not in seen:
                round_pairs.append((a, b, sim))
                seen.add(frozenset((a, b)))

        if not round_pairs:
            print(f"  раунд {round_num}: разрыва нет, слияние закончено")
            break

        for a, b, sim in round_pairs:
            wa, wb = weights[a], weights[b]
            new_centroid = (centroids[a] * wa + centroids[b] * wb) / (wa + wb)
            centroids[a] = new_centroid / (np.linalg.norm(new_centroid) + 1e-8)
            weights[a] = wa + wb
            parent[find(b)] = find(a)
            active.discard(b)

        round_hypothesis = build_hypothesis(parent, find)
        round_der = compute_der(round_hypothesis)
        round_speakers = len(round_hypothesis.labels())
        print(f"  раунд {round_num}: слито {round_pairs} -> DER={round_der * 100:.2f}% спикеров={round_speakers}")

        if round_der > best_der:
            print(f"  раунд {round_num}: DER стал хуже ({round_der * 100:.2f}% > {best_der * 100:.2f}%) — откат, стоп")
            parent = dict(best_parent)
            find = find_factory(parent)
            break

        all_merged_pairs.extend(round_pairs)
        best_der = round_der
        best_parent = dict(parent)

    find = find_factory(best_parent)
    merged_hypothesis = build_hypothesis(best_parent, find)

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    merged_rttm_path = out_dir / f"{args.session_id}.hyp.rttm"
    annotation_to_rttm(merged_hypothesis, args.session_id, merged_rttm_path)

    der = compute_der(merged_hypothesis)
    hyp_speakers = len(merged_hypothesis.labels())

    print(f"\nИтог после {round_num} раунд(ов): DER={der * 100:.2f}%  спикеров: реф={len(reference.labels())} гип={hyp_speakers}")

    report = {
        "embeddingModel": args.embedding_model,
        "minSimilarityFloor": args.min_similarity,
        "maxRounds": args.max_rounds,
        "roundsUsed": round_num,
        "der": der,
        "refSpeakers": len(reference.labels()),
        "hypSpeakersBefore": len(labels),
        "hypSpeakersAfter": hyp_speakers,
        "mergedPairs": [{"a": a, "b": b, "similarity": s} for a, b, s in all_merged_pairs],
    }
    report_path = out_dir / "der-report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Отчёт: {report_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
