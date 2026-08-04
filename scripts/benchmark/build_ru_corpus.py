#!/usr/bin/env python3
"""
Строит русский корпус для диаризации из отдельных фраз Golos.

Зачем: готового русского корпуса с разметкой спикеров в открытом доступе
нет — проверено поиском по HuggingFace, OpenSLR и TalkBank. Balalaika
требует ключ Yandex Music и запрещает производные (CC BY-NC-ND),
talkbank/callhome закрыт, podlodka не размечен по спикерам.

Решение: Golos содержит независимые записи разных дикторов с точными
транскриптами. Склеивая их в диалог, получаем разметку, точную ПО
ПОСТРОЕНИЮ — и спикеры, и текст известны без ручной работы.

Чего этот корпус НЕ моделирует (и потому абсолютные числа будут
оптимистичнее реальной планёрки):
  - акустику одного помещения: у каждой фразы свой микрофон и фон,
    поэтому спикеры различимы легче, чем в реальности
  - естественные перебивания: перекрытия добавляются искусственно
  - просодию диалога: фразы не связаны по смыслу

Годится, чтобы: сравнить бэкенды между собой на РУССКОЙ речи и
посчитать честный cpWER, где эталонный текст известен точно.
"""
import io, json, random, sys, wave
import pandas as pd

SR = 16000
OUT = sys.argv[1] if len(sys.argv) > 1 else 'ru_corpus'
N_SESSIONS = int(sys.argv[2]) if len(sys.argv) > 2 else 8
N_SPEAKERS = int(sys.argv[3]) if len(sys.argv) > 3 else 4
TARGET_SEC = float(sys.argv[4]) if len(sys.argv) > 4 else 180
OVERLAP_P = float(sys.argv[5]) if len(sys.argv) > 5 else 0.15

import os
os.makedirs(OUT, exist_ok=True)

def decode(b):
    with wave.open(io.BytesIO(b)) as w:
        assert w.getframerate() == SR and w.getnchannels() == 1
        return w.readframes(w.getnframes())

def mix(base, ov, off):
    import struct
    n = len(ov) // 2
    need = (off + n) * 2
    if len(base) < need:
        base.extend(bytes(need - len(base)))
    for i in range(n):
        bi = (off + i) * 2
        a = struct.unpack_from('<h', base, bi)[0]
        b = struct.unpack_from('<h', ov, i * 2)[0]
        struct.pack_into('<h', base, bi, max(-32768, min(32767, a + b)))

d = pd.read_parquet('corpora/golos.parquet')
rng = random.Random(42)
pool = list(range(len(d)))
rng.shuffle(pool)

# Каждому спикеру — свой непересекающийся набор фраз. Пересечение
# означало бы, что один и тот же голос числится двумя людьми.
per = len(pool) // N_SPEAKERS
banks = [pool[i*per:(i+1)*per] for i in range(N_SPEAKERS)]

manifest = []
cursor = [0] * N_SPEAKERS

for s in range(N_SESSIONS):
    audio = bytearray()
    ref, ref_text = [], []
    t = 0.0
    last = None
    while t < TARGET_SEC:
        cand = [i for i in range(N_SPEAKERS) if i != last] or list(range(N_SPEAKERS))
        spk = rng.choice(cand)
        if cursor[spk] >= len(banks[spk]):
            break
        row = d.iloc[banks[spk][cursor[spk]]]
        cursor[spk] += 1
        pcm = decode(row['audio']['bytes'])
        dur = len(pcm) / 2 / SR
        if dur < 0.4:
            continue
        overlap = last is not None and rng.random() < OVERLAP_P
        start = max(0.0, t - rng.uniform(0.3, min(1.2, dur * 0.4))) if overlap else t + rng.uniform(0.15, 0.7)
        mix(audio, pcm, int(start * SR))
        ref.append({'speaker': f'SPEAKER_{spk}', 'start': round(start,3), 'stop': round(start+dur,3)})
        ref_text.append({'speaker': f'SPEAKER_{spk}', 'start': round(start,3), 'stop': round(start+dur,3), 'text': str(row['transcription'])})
        t = start + dur
        last = spk
    name = f'ru-{s:03d}.wav'
    with wave.open(os.path.join(OUT, name), 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(bytes(audio))
    ref.sort(key=lambda x: x['start']); ref_text.sort(key=lambda x: x['start'])
    manifest.append({'id': f'ru-{s:03d}', 'audio': name, 'reference': ref,
                     'reference_text': ref_text, 'num_speakers': N_SPEAKERS,
                     'duration_sec': round(len(audio)/2/SR,2), 'language': 'ru',
                     'tags': ['golos-synthetic','ru']})
    ovc = sum(1 for i,a in enumerate(ref) for b in ref[i+1:] if b['start'] < a['stop'])
    print(f"  ru-{s:03d}: {len(audio)/2/SR:.0f}с, {len(ref)} реплик, {ovc} перекрытий, {sum(len(x['text'].split()) for x in ref_text)} слов")

with open(os.path.join(OUT,'manifest.jsonl'),'w',encoding='utf-8') as f:
    for m in manifest: f.write(json.dumps(m, ensure_ascii=False)+'\n')
print(f'\n✓ {len(manifest)} сессий → {OUT}/manifest.jsonl')
