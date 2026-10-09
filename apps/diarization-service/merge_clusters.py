#!/usr/bin/env python3
"""
Слияние кластеров диаризации по эмбеддингу голоса

Два независимых этапа:

  1. Слияние по сходству голоса (тот же алгоритм, что в
     research/diarization-asr-lab/run/merge-clusters.py: наибольший разрыв
     в матрице косинусного сходства между метками, сливаем только
     взаимно-ближайшие пары выше `min_similarity`) — БЕЗ отката по DER,
     эталонной разметки для реальных встреч не существует. См. обсуждение
     выбора алгоритма в research/diarization-asr-lab/FINDINGS.md, разделы 1-2.
  2. Поглощение меток с суммарным временем речи меньше `min_total_duration_sec`
     ближайшим по голосу "большим" спикером — ловит спикеров-обрывков
     (шум, вдохи, короткие перекрытия), которых этап 1 не видит: их
     эмбеддинг по паре крох слишком ненадёжен, чтобы набрать
     `min_similarity` с кем бы то ни было.
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
    # 0.4 сливало реальных разных людей (найдено на встрече с 10 участниками:
    # pyannote с min_speakers=10 верно нашёл все 10 сырых кластеров, но этот
    # пол слил 3 пары с похожестью 0.58–0.78 — довёл до 7). На 0.75 из трёх
    # пар осталось слито две (0.758, 0.783) — довёл до 8. Поднят до 0.8,
    # калибровать через MERGE_MIN_SIMILARITY, не меняя код.
    min_similarity: float = float(os.environ.get("MERGE_MIN_SIMILARITY", "0.8")),
    max_segments_per_label: int = 10,
    min_segment_sec: float = 1.0,
    max_rounds: int = 1,
    # Инцидент 2026-09-26: на записи с 3 реальными участниками pyannote
    # выдал ещё 3 "спикера" по 4-8с суммарно за всю встречу (шум, обрывки,
    # короткие перекрытия) — этап 1 их не трогает, похожесть по крохе
    # аудио ни с кем не набирает min_similarity. Отдельный порог именно
    # на СУММАРНОЕ время речи метки за всю встречу — не про то, насколько
    # похож голос, а про то, что меньше этого самого "спикера" как
    # персоны, считай, не существует. См. этап 2 ниже.
    min_total_duration_sec: float = float(os.environ.get("MERGE_MIN_TOTAL_DURATION_SEC", "10.0")),
    embeddings_out: dict | None = None,
) -> int:
    """Возвращает число спикеров после слияния. Если передан `embeddings_out`,
    кладёт в него усреднённый L2-нормированный эмбеддинг голоса каждого
    итогового спикера: {метка в итоговом RTTM: [float, ...]}."""
    import numpy as np
    from pyannote.core import Annotation

    hf_token = os.environ.get("HF_TOKEN")
    if not hf_token:
        raise RuntimeError("HF_TOKEN не задан в окружении контейнера")

    inference = get_embedding_inference(embedding_model, hf_token)
    hypothesis = parse_rttm(hyp_rttm_path)

    # Суммарное время речи по КАЖДОЙ сырой метке, без фильтра по длине
    # сегмента — нужно для этапа 2 (поглощение спикеров-обрывков), у
    # обычного `by_label` ниже короткие сегменты уже отфильтрованы.
    total_duration_all = {}
    all_segments_by_label = {}
    for segment, _, label in hypothesis.itertracks(yield_label=True):
        total_duration_all[label] = total_duration_all.get(label, 0.0) + segment.duration
        all_segments_by_label.setdefault(label, []).append(segment)

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

    # ============================================================
    # Этап 2: поглощение спикеров с малым суммарным временем речи.
    # ============================================================
    # Работает независимо от того, слилось ли что-то на этапе 1 —
    # порог здесь другой (суммарная длительность, не сходство голоса).
    def fallback_centroid(label):
        """Эмбеддинг по ВСЕМ сегментам метки, включая короче min_segment_sec —
        для меток-обрывков, у которых в `centroids` вообще ничего нет."""
        segments = sorted(all_segments_by_label.get(label, []), key=lambda s: -s.duration)
        segments = segments[:max_segments_per_label]
        embeddings = []
        for seg in segments:
            emb = inference.crop(audio_path, seg)
            if emb is not None:
                embeddings.append(np.asarray(emb).reshape(-1))
        if not embeddings:
            return None
        c = np.mean(embeddings, axis=0)
        return c / (np.linalg.norm(c) + 1e-8)

    all_raw_labels = sorted(total_duration_all.keys())
    for label in all_raw_labels:
        parent.setdefault(label, label)

    def cluster_total_duration(root):
        return sum(total_duration_all[label] for label in all_raw_labels if find(label) == root)

    active_roots = {find(label) for label in all_raw_labels}
    big_roots = {r for r in active_roots if cluster_total_duration(r) >= min_total_duration_sec}
    small_roots = active_roots - big_roots

    if small_roots and big_roots:
        root_centroid = {r: (centroids[r] if r in centroids else fallback_centroid(r)) for r in big_roots}
        root_centroid = {r: c for r, c in root_centroid.items() if c is not None}

        for small_root in sorted(small_roots):
            dur = cluster_total_duration(small_root)
            emb = centroids.get(small_root)
            if emb is None:
                emb = fallback_centroid(small_root)
            if emb is None or not root_centroid:
                # Даже по всем сегментам эмбеддинг не строится (совсем
                # тихий/короткий обрывок) — некуда осмысленно деть,
                # оставляем отдельным спикером, а не гадаем наугад.
                print(f"  ! {small_root}: {dur:.1f}с речи, эмбеддинг не построен, оставлен отдельным спикером")
                continue
            best_root = max(root_centroid, key=lambda r: float(np.dot(emb, root_centroid[r])))
            best_sim = float(np.dot(emb, root_centroid[best_root]))
            print(f"  поглощение: {small_root} ({dur:.1f}с речи) -> {best_root} (сходство {best_sim:.3f})")
            parent[small_root] = best_root
    elif small_roots:
        # Все метки короче порога — нет ни одного "настоящего" спикера,
        # в кого поглощать. Оставляем как есть: лучше подозрительно много
        # спикеров, чем молча слить всех в одного наугад.
        print(f"  этап 2: все метки короче {min_total_duration_sec}с, поглощать некуда, пропуск")

    if embeddings_out is not None:
        for root in sorted({find(label) for label in all_raw_labels}):
            centroid = centroids.get(root)
            if centroid is None:
                centroid = fallback_centroid(root)
            if centroid is not None:
                embeddings_out[root] = [round(float(x), 5) for x in centroid]

    merged_hypothesis = build_hypothesis(parent, find)
    annotation_to_rttm(merged_hypothesis, session_id, out_rttm_path)
    speakers = len(merged_hypothesis.labels())
    print(f"\nИтог: спикеров={speakers} -> {out_rttm_path}")
    return speakers


def main():
    parser = argparse.ArgumentParser(description="Слияние кластеров диаризации по эмбеддингу голоса")
    parser.add_argument("--audio", required=True)
    parser.add_argument("--hyp-rttm", required=True)
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--out-rttm", required=True)
    parser.add_argument("--embedding-model", default="pyannote/wespeaker-voxceleb-resnet34-LM")
    parser.add_argument("--min-similarity", type=float, default=0.8)
    parser.add_argument("--max-segments-per-label", type=int, default=10)
    parser.add_argument("--min-segment-sec", type=float, default=1.0)
    parser.add_argument("--max-rounds", type=int, default=1)
    parser.add_argument("--min-total-duration-sec", type=float, default=10.0)
    args = parser.parse_args()

    try:
        run_merge(
            args.audio, args.hyp_rttm, args.session_id, args.out_rttm,
            embedding_model=args.embedding_model, min_similarity=args.min_similarity,
            max_segments_per_label=args.max_segments_per_label,
            min_segment_sec=args.min_segment_sec, max_rounds=args.max_rounds,
            min_total_duration_sec=args.min_total_duration_sec,
        )
    except RuntimeError as e:
        print(f"ОШИБКА: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
