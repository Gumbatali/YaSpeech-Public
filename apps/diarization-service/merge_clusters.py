#!/usr/bin/env python3
"""
Слияние кластеров диаризации по эмбеддингу голоса — прод-версия.

Тот же алгоритм, что в research/diarization-asr-lab/run/merge-clusters.py
(находим наибольший разрыв в матрице косинусного сходства между метками,
сливаем только взаимно-ближайшие пары выше порога), но БЕЗ отката по DER —
эталонной разметки для реальных встреч не существует, поэтому
`min_similarity` остаётся единственной сеткой безопасности. См. обсуждение
выбора алгоритма в research/diarization-asr-lab/FINDINGS.md, разделы 1-2.
"""
import argparse
import itertools
import os
import sys

_embedding_cache = {}


def get_embedding_inference(model: str, hf_token: str):
    key = model
    if key not in _embedding_cache:
        from pyannote.audio import Model, Inference

        print(f"Загружаю модель эмбеддингов {model}…")
        embedding_model = Model.from_pretrained(model, use_auth_token=hf_token)
        _embedding_cache[key] = Inference(embedding_model, window="whole")
    return _embedding_cache[key]


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


def run_merge(
    audio_path: str,
    hyp_rttm_path: str,
    session_id: str,
    out_rttm_path: str,
    embedding_model: str = "pyannote/wespeaker-voxceleb-resnet34-LM",
    min_similarity: float = 0.4,
    max_segments_per_label: int = 10,
    min_segment_sec: float = 1.0,
    max_rounds: int = 1,
) -> int:
    """Возвращает число спикеров после слияния."""
    import numpy as np
    from pyannote.core import Annotation

    hf_token = os.environ.get("HF_TOKEN")
    if not hf_token:
        raise RuntimeError("HF_TOKEN не задан в окружении контейнера")

    inference = get_embedding_inference(embedding_model, hf_token)
    hypothesis = parse_rttm(hyp_rttm_path)

    by_label = {}
    for segment, _, label in hypothesis.itertracks(yield_label=True):
        if segment.duration >= min_segment_sec:
            by_label.setdefault(label, []).append(segment)

    labels = sorted(by_label.keys())
    print(f"Меток в гипотезе: {len(labels)} -> {labels}")

    centroids = {}
    weights = {}
    for label in labels:
        segments = sorted(by_label[label], key=lambda s: -s.duration)[:max_segments_per_label]
        embeddings = []
        for seg in segments:
            emb = inference.crop(audio_path, seg)
            if emb is not None:
                embeddings.append(np.asarray(emb).reshape(-1))
        if not embeddings:
            print(f"  ! {label}: нет сегментов длиннее {min_segment_sec}с, пропуск")
            continue
        centroid = np.mean(embeddings, axis=0)
        centroid = centroid / (np.linalg.norm(centroid) + 1e-8)
        centroids[label] = centroid
        weights[label] = sum(s.duration for s in segments)
        print(f"  {label}: {len(segments)} сегментов, суммарно {weights[label]:.1f}с")

    def similarity(a, b):
        return float(np.dot(centroids[a], centroids[b]))

    def find_factory(parent):
        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x
        return find

    def build_hypothesis(parent, find):
        merged = Annotation(uri=session_id)
        for segment, track, label in hypothesis.itertracks(yield_label=True):
            new_label = find(label) if label in parent else label
            merged[segment, track] = new_label
        return merged

    active = set(centroids.keys())
    parent = {label: label for label in labels}
    find = find_factory(parent)
    round_num = 0

    # Без эталонной разметки нечего сравнивать "стало хуже/лучше" —
    # останавливаемся только когда раунд ничего не сливает или раунды кончились.
    while round_num < max_rounds and len(active) >= 2:
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
        effective_threshold = max(adaptive_threshold, min_similarity)
        print(
            f"Раунд {round_num}: сходства (убыв.) {[round(s, 3) for s in all_sims]}\n"
            f"  наибольший разрыв {best_gap:.3f} -> порог {adaptive_threshold:.3f} "
            f"(эффективный, с полом {min_similarity}: {effective_threshold:.3f})"
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

        merged_now = build_hypothesis(parent, find)
        print(f"  раунд {round_num}: слито {round_pairs} -> спикеров={len(merged_now.labels())}")

    merged_hypothesis = build_hypothesis(parent, find)
    annotation_to_rttm(merged_hypothesis, session_id, out_rttm_path)
    speakers = len(merged_hypothesis.labels())
    print(f"\nИтог после {round_num} раунд(ов): спикеров={speakers} -> {out_rttm_path}")
    return speakers


def main():
    parser = argparse.ArgumentParser(description="Слияние кластеров диаризации по эмбеддингу голоса")
    parser.add_argument("--audio", required=True)
    parser.add_argument("--hyp-rttm", required=True)
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--out-rttm", required=True)
    parser.add_argument("--embedding-model", default="pyannote/wespeaker-voxceleb-resnet34-LM")
    parser.add_argument("--min-similarity", type=float, default=0.4)
    parser.add_argument("--max-segments-per-label", type=int, default=10)
    parser.add_argument("--min-segment-sec", type=float, default=1.0)
    parser.add_argument("--max-rounds", type=int, default=1)
    args = parser.parse_args()

    try:
        run_merge(
            args.audio, args.hyp_rttm, args.session_id, args.out_rttm,
            embedding_model=args.embedding_model, min_similarity=args.min_similarity,
            max_segments_per_label=args.max_segments_per_label,
            min_segment_sec=args.min_segment_sec, max_rounds=args.max_rounds,
        )
    except RuntimeError as e:
        print(f"ОШИБКА: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
