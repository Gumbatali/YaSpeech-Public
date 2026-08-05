#!/usr/bin/env python3
'''
Г2: можно ли по выходу Sortformer понять, что реальных спикеров больше 4?

Идея: у Sortformer ровно 4 слота. Если людей 3, один слот должен пустовать
или быть почти пустым. Если людей 6, все 4 слота будут забиты плотно, потому
что модель вынуждена распихать шестерых по четырём.

Проверяем на VoxConverse, где есть записи с 3, 4, 5 и 6 спикерами:
считаем долю времени каждого слота и смотрим, коррелирует ли «минимальный
слот» с реальным числом участников.
'''
import json, sys, urllib.request, os

MANIFEST = '/home/yc-user/lab/corpus/wav/manifest.jsonl'
AUDIO_DIR = '/home/yc-user/lab/corpus/wav'
URL = 'http://localhost:8003/diarize'

def diarize(path):
    import subprocess
    out = subprocess.run(['curl','-s','-F',f'audio=@{path}',URL],
                         capture_output=True, text=True, timeout=1800)
    return json.loads(out.stdout)

rows=[]
for line in open(MANIFEST):
    rec=json.loads(line)
    real=len(set(s['speaker'] for s in rec['reference']))
    res=diarize(os.path.join(AUDIO_DIR, rec['audio']))
    segs=res.get('segments',[])
    if not segs:
        print(f"  {rec['id']}: пусто"); continue

    total=max(s['stop'] for s in segs)
    # доля времени каждого слота
    per={}
    for s in segs:
        per[s['speaker']]=per.get(s['speaker'],0)+(s['stop']-s['start'])
    shares=sorted((v/total*100) for v in per.values())

    rows.append({'id':rec['id'],'real':real,'slots':len(per),
                 'min_share':round(shares[0],1),'shares':[round(x,1) for x in shares]})
    print(f"  {rec['id']}: реально {real} спик. | слотов занято {len(per)} | доли {[round(x,1) for x in shares]}")

print()
print('=== СВОДКА: коррелирует ли минимальная доля слота с числом людей? ===')
le4=[r for r in rows if r['real']<=4]
gt4=[r for r in rows if r['real']>4]
if le4: print(f"  <=4 спикеров (n={len(le4)}): мин. доля слота в среднем {sum(r['min_share'] for r in le4)/len(le4):.1f}%")
if gt4: print(f"   >4 спикеров (n={len(gt4)}): мин. доля слота в среднем {sum(r['min_share'] for r in gt4)/len(gt4):.1f}%")
json.dump(rows, open('/home/yc-user/lab/results/g2-slots.json','w'), ensure_ascii=False, indent=1)
