# YaSpeech ASR Benchmark

Воспроизводимый замер качества распознавания: берём аудио с **известными
эталонными расшифровками**, прогоняем через живой YaSpeech API и считаем
**WER** (Word Error Rate) и **CER** (Character Error Rate).

```
scripts/benchmark/
├── run-benchmark.mjs       # раннер (Node 18+, без зависимостей)
├── lib/wer.mjs             # WER/CER движок (чистый JS)
├── download_golos.py       # загрузчик тестового набора Golos → manifest.jsonl
├── requirements.txt        # зависимости только для загрузчика
└── data/
    ├── manifest.example.jsonl
    └── manifest.jsonl      # генерируется загрузчиком (gitignored)
```

## Откуда брать аудио

| Источник | Что закрывает | Как получить |
|----------|---------------|--------------|
| **Golos / crowd** | близкий микрофон, телефоны | `download_golos.py --domain crowd` |
| **Golos / farfield** | дальний микрофон (B3/B4) | `download_golos.py --domain farfield` |
| **SOVA** | зашумлённые телефонные записи (A/F) | вручную → свой manifest |
| **Своя запись / TTS** | кросс-толк, доменная стройка (C2/E2) | свой manifest |

Раннер не привязан к Golos — он читает любой `manifest.jsonl`.

## Формат manifest.jsonl

По одной JSON-записи на строку. `audio` — путь относительно папки манифеста:

```json
{"id": "golos-001", "audio": "golos-001.wav", "ref": "эталонный текст", "tags": ["farfield"]}
```

## Запуск

```bash
# 1. (опционально) скачать образцы Golos
pip install -r scripts/benchmark/requirements.txt
python3 scripts/benchmark/download_golos.py --count 15 --domain farfield --out scripts/benchmark/data

# 2. прогнать бенчмарк против живого гейтвея
BENCH_BASE_URL="https://<gateway-id>.apigw.yandexcloud.net" \
BENCH_LOGIN="admin" \
BENCH_PASSWORD="***" \
node scripts/benchmark/run-benchmark.mjs scripts/benchmark/data/manifest.jsonl
```

### Переменные окружения

| Переменная | По умолчанию | Назначение |
|------------|--------------|------------|
| `BENCH_BASE_URL` | — | URL API Gateway (обязательно) |
| `BENCH_LOGIN` / `BENCH_PASSWORD` | — | учётка для логина (обязательно) |
| `BENCH_POLL_MS` | `3000` | интервал опроса статуса |
| `BENCH_TIMEOUT_MS` | `180000` | таймаут одной расшифровки |

## Что на выходе

- `scripts/benchmark/report.json` — полные результаты + распознанные тексты
- `scripts/benchmark/report.md` — таблица WER/CER по образцам

Раннер создаёт отдельный проект `benchmark-<timestamp>`, чтобы не засорять
рабочие данные. Каждое аудио считается как одна расшифровка — учитывай
квоту пользователя (для прогонов удобно завести юзера с безлимитом).

## Как читать метрики

- **WER 0%** — идеально; **< 15%** — хорошо для русского ASR в реальных условиях.
- **CER** обычно ниже WER (ошибается в окончаниях, а не в целых словах).
- Колонки **S / D / I** — замены / удаления / вставки слов: помогают понять
  характер ошибок (вставки → галлюцинации ASR, удаления → проглоченная речь).

> Нормализация (нижний регистр, `ё→е`, снятие пунктуации и меток спикеров)
> применяется одинаково к эталону и гипотезе — см. `lib/wer.mjs`.
> Цифры сравниваются как есть: если эталон содержит «двенадцать», а ASR
> выдал «12», это засчитается как ошибка. Для доменных числовых кейсов
> держи эталон в той же форме, что ожидаешь от модели.
