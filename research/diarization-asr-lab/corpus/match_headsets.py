#!/usr/bin/env python3
"""
Matches AMI's anonymous Headset-N.wav tracks to participant letters (A/B/C/D)
by RMS energy: each participant's own headset should be far louder than
others during their known speaking time (from words.xml), so the assignment
maximizing total matched energy across all 4 participants identifies the map.

Usage: match_headsets.py WORDS_DIR AUDIO_DIR
"""
import itertools
import re
import sys

import numpy as np
import soundfile as sf

WORDS_DIR = sys.argv[1]
AUDIO_DIR = sys.argv[2]
MEETING = "ES2002b"
PARTICIPANTS = ["A", "B", "C", "D"]
HEADSETS = [0, 1, 2, 3]


def parse_words(path):
    xml = open(path, encoding="utf-8").read()
    spans = []
    for m in re.finditer(r'<w\b([^>]*)>', xml):
        attrs = m.group(1)
        start = re.search(r'starttime="([\d.]+)"', attrs)
        end = re.search(r'endtime="([\d.]+)"', attrs)
        if start and end:
            spans.append((float(start.group(1)), float(end.group(1))))
    return spans


results = {}
for p in PARTICIPANTS:
    spans = parse_words(f"{WORDS_DIR}/{MEETING}.{p}.words.xml")
    results[p] = spans
    print(f"{p}: {len(spans)} word spans")

energies = {p: {} for p in PARTICIPANTS}
for h in HEADSETS:
    audio, sr = sf.read(f"{AUDIO_DIR}/{MEETING}.Headset-{h}.wav", dtype="float32", always_2d=False)
    for p in PARTICIPANTS:
        total_energy = 0.0
        total_samples = 0
        for start, end in results[p]:
            s = int(start * sr)
            e = int(end * sr)
            if e <= s or e > len(audio):
                continue
            seg = audio[s:e]
            total_energy += float(np.sum(seg.astype(np.float64) ** 2))
            total_samples += len(seg)
        rms = (total_energy / total_samples) ** 0.5 if total_samples else 0.0
        energies[p][h] = rms
    print(f"headset {h} done")

print("\nRMS matrix (participant x headset):")
print("     " + "  ".join(f"H{h}" for h in HEADSETS))
for p in PARTICIPANTS:
    row = "  ".join(f"{energies[p][h]:.4f}" for h in HEADSETS)
    print(f"{p}:  {row}")

best_perm, best_total = None, -1
for perm in itertools.permutations(HEADSETS):
    total = sum(energies[PARTICIPANTS[i]][perm[i]] for i in range(4))
    if total > best_total:
        best_total, best_perm = total, perm

print("\nOptimal assignment (maximizes total matched energy):")
for p, h in zip(PARTICIPANTS, best_perm):
    print(f"  {p} -> Headset-{h}")
