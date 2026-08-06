#!/usr/bin/env python3
"""
Конвертер аннотаций AMI → манифест бенчмарка с текстом и спикерами.

Зачем AMI: это единственный доступный корпус, где есть И ручные транскрипты,
И разметка спикеров. VoxConverse даёт только «кто когда говорил» — на нём
можно посчитать DER, но не WER и не cpWER. Русского корпуса с обоими видами
разметки в открытом доступе нет, поэтому cpWER меряем на английском.

Что важно понимать про такой замер: SpeechKit на английском заведомо в
невыгодном положении, это не его язык. Цифры покажут ПОТЕРИ НА СВЯЗКЕ
текст+спикеры (ради чего cpWER и нужен), но не «SpeechKit хуже Whisper».

Формат AMI: по XML-файлу на каждого спикера встречи, внутри <w> с
пословными таймкодами. Реплики собираем сами, склеивая соседние слова
одного спикера — паузы длиннее GAP_SEC считаем границей реплики.

Пример:
  python3 ami-to-manifest.py --annotations ./ann --audio-dir ./wav \\
      --meetings ES2004a IS1009a --out ./manifest.jsonl
"""

from __future__ import annotations

import argparse
import json
import os
import re
import wave
import xml.etree.ElementTree as ET

NITE_NS = "{http://nite.sourceforge.net/}"

# Пауза, по которой режем поток слов одного спикера на отдельные реплики.
# 0.5с — компромисс: короче дробит фразы на полуслове, длиннее склеивает
# ответы собеседников в один блок.
GAP_SEC = 0.5


def parse_words(path: str) -> list[dict]:
    """Читает words.xml и возвращает слова с таймкодами."""
    try:
        tree = ET.parse(path)
    except ET.ParseError as exc:
        print(f"  ! не разобрался {os.path.basename(path)}: {exc}")
        return []

    words = []
    for w in tree.getroot():
        # Пунктуация размечена отдельными элементами с punc="true" —
        # для WER она не нужна, нормализация её всё равно выбросит.
        if w.get("punc") == "true":
            continue
        # Элементы разметки шума (<vocalsound>, <gap>) текста не несут.
        if not w.text or not w.text.strip():
            continue

        start, end = w.get("starttime"), w.get("endtime")
        if start is None or end is None:
            continue

        try:
            words.append({"start": float(start), "stop": float(end), "text": w.text.strip()})
        except ValueError:
            continue

    words.sort(key=lambda x: x["start"])
    return words


def group_into_utterances(words: list[dict], speaker: str) -> list[dict]:
    """Склеивает подряд идущие слова одного спикера в реплики."""
    utterances = []
    current = None

    for w in words:
        if current and w["start"] - current["stop"] <= GAP_SEC:
            current["stop"] = max(current["stop"], w["stop"])
            current["words"].append(w["text"])
        else:
            if current:
                utterances.append(current)
            current = {
                "speaker": speaker,
                "start": w["start"],
                "stop": w["stop"],
                "words": [w["text"]],
            }

    if current:
        utterances.append(current)

    return [
        {
            "speaker": u["speaker"],
            "start": round(u["start"], 3),
            "stop": round(u["stop"], 3),
            "text": " ".join(u["words"]),
        }
        for u in utterances
    ]


def audio_duration(path: str) -> float | None:
    try:
        with wave.open(path, "rb") as w:
            return round(w.getnframes() / w.getframerate(), 2)
    except Exception:
        return None


def overlap_ratio(segments: list[dict]) -> float:
    speech = sum(s["stop"] - s["start"] for s in segments)
    if speech <= 0:
        return 0.0
    ordered = sorted(segments, key=lambda s: s["start"])
    overlap = 0.0
    for i, a in enumerate(ordered):
        for b in ordered[i + 1 :]:
            if b["start"] >= a["stop"]:
                break
            overlap += min(a["stop"], b["stop"]) - b["start"]
    return overlap / speech * 100


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--annotations", required=True, help="распакованный ami_public_manual")
    ap.add_argument("--audio-dir", required=True, help="папка с <meeting>.wav")
    ap.add_argument("--meetings", nargs="+", required=True, help="ID встреч, напр. ES2004a")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    words_dir = os.path.join(args.annotations, "words")
    if not os.path.isdir(words_dir):
        raise SystemExit(f"нет папки {words_dir}")

    written = 0
    with open(args.out, "w", encoding="utf-8") as out:
        for meeting in args.meetings:
            audio_name = f"{meeting}.wav"
            audio_path = os.path.join(args.audio_dir, audio_name)
            if not os.path.exists(audio_path):
                print(f"  ! нет аудио {audio_name}, пропускаю")
                continue

            utterances: list[dict] = []
            pattern = re.compile(rf"^{re.escape(meeting)}\.([A-Z])\.words\.xml$")

            for filename in sorted(os.listdir(words_dir)):
                m = pattern.match(filename)
                if not m:
                    continue
                speaker = m.group(1)
                words = parse_words(os.path.join(words_dir, filename))
                utterances.extend(group_into_utterances(words, speaker))

            if not utterances:
                print(f"  ! нет разметки для {meeting}")
                continue

            utterances.sort(key=lambda u: u["start"])
            speakers = sorted({u["speaker"] for u in utterances})

            # reference — для DER (только тайминги и спикеры)
            reference = [
                {"speaker": u["speaker"], "start": u["start"], "stop": u["stop"]}
                for u in utterances
            ]
            # reference_text — для WER/cpWER (то же плюс слова)
            duration = audio_duration(audio_path)
            total_words = sum(len(u["text"].split()) for u in utterances)

            out.write(
                json.dumps(
                    {
                        "id": meeting,
                        "audio": audio_name,
                        "reference": reference,
                        "reference_text": utterances,
                        "num_speakers": len(speakers),
                        "duration_sec": duration,
                        "language": "en",
                        "tags": ["ami", f"spk{len(speakers)}"],
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )

            print(
                f"  {meeting}: {duration:.0f}с, {len(speakers)} спикеров, "
                f"{len(utterances)} реплик, {total_words} слов, "
                f"перекрытий {overlap_ratio(reference):.1f}%"
            )
            written += 1

    print(f"\n✓ {written} встреч → {args.out}")


if __name__ == "__main__":
    main()
