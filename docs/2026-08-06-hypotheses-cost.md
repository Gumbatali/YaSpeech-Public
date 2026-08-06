# Журнал: проверка гипотез про num_speakers

Инстанс diar-hyp, 16 vCPU / 64 ГБ, ru-central1-a, ~37 руб/час.
Корпус: те же 8 записей VoxConverse, что и в замере 2026-08-04.

| # | Шаг | Артефакт | Стоимость |
|---|-----|----------|-----------|
| 1 | Создан инстанс diar-hyp | - | 37 руб/час |
| 2 | Собраны образы pyannote + streaming-sortformer (CPU) | - | входит в час |
| 3 | Скачан VoxConverse dev (1.9 ГБ), распакованы 8 записей | corpus/ | трафик бесплатно |
| 4 | Г1: pyannote БЕЗ num_speakers | results/hyp-g1-pyannote-blind.json | входит в час |
| 5 | Г2: анализ заполненности слотов Sortformer | results/hyp-g2-sortformer-slots.json | входит в час |
| 6 | Г3: pyannote с ЗАВЫШЕННОЙ на 2 подсказкой | results/hyp-g3-pyannote-wrong-hint.json | входит в час |

| Статья | Расчёт | Сумма |
|--------|--------|-------|
| Инстанс diar-hyp | 47 мин x 37 руб/час | ~$(( MIN*37/60 )) руб |
| SpeechKit | не использовался | 0 руб |
| **ВСЕГО** | | **~$(( MIN*37/60 )) руб** |

Инстанс удалён после проверки.
