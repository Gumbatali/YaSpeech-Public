# pyannote.audio — валидация локального пайплайна диаризации

Цель и контекст: см. `docs/plans/2026-07-30-pyannote-diarization.md` (Фаза A).
Это разовый эксперимент, не часть прод-кода.

## Настройка

```bash
cd scripts/experiments/pyannote-validation
python3 -m venv venv
source venv/bin/activate
pip install "pyannote.audio>=4,<5" torch torchaudio
```

Нужен HuggingFace-токен с принятыми условиями использования модели:
1. https://huggingface.co/settings/tokens — создать токен (read access достаточно).
2. Принять условия на https://huggingface.co/pyannote/speaker-diarization-3.1
   (и обычно также на https://huggingface.co/pyannote/segmentation-3.0).
3. `export HF_TOKEN=hf_...`

## Запуск

```bash
python run_diarization.py ~/Downloads/<файл>.m4a
```

Скрипт печатает список сегментов `SPEAKER_xx  start–stop`, итоговое число
спикеров и время обработки (абсолютное и относительно длины аудио).

## Заметки по pyannote.audio 4.x

- `Pipeline.from_pretrained(..., token=HF_TOKEN)` — параметр называется
  `token`, не `use_auth_token` (переименован в 4.x, старое имя выпилено,
  не просто deprecated).
- Результат вызова pipeline — не сразу `Annotation`, а обёртка
  `SpeakerDiarizationOutput`; сама диаризация лежит в
  `result.speaker_diarization` (тип `pyannote.core.Annotation`), по которой
  уже можно вызывать `.itertracks(yield_label=True)`.

## Результаты прогона

**Не выполнено.** Облачная сессия, в которой готовился этот эксперимент,
не имеет исходящего доступа к PyPI (сетевая политика окружения блокирует
`pip install`, `pypi.org` отвечает 403) и не имеет тестовых аудиофайлов в
`~/Downloads`. Установить `pyannote.audio` и прогнать скрипт в этой сессии
не удалось.

Скрипт `run_diarization.py` в этой директории готов к использованию — его
нужно прогнать в среде с доступом к PyPI и HuggingFace (например, локально
у разработчика) на реальном файле из `~/Downloads`, после чего дополнить
этот раздел:

- [ ] число найденных спикеров
- [ ] время обработки / длина аудио (relative real-time)
- [ ] качественная оценка на слух vs текущее LLM-угадывание в приложении
