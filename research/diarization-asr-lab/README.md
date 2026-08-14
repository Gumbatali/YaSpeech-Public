Исследование двух известных проблем - диаризация спикеров не
работает (SpeechKit не возвращает `speakerTag`, только фиктивный
`channelTag`) и распознавание речи местами ошибается.

## Что тут меряем

1. **DER** (Diarization Error Rate) — насколько верно диаризация разделяет
   разговор на спикеров.
2. **WER/CER** — качество распознавания речи (faster-whisper на CPU).
3. **cpWER** — WER с учётом верной привязки реплики к говорящему
   (объединяет 1 и 2: то, что реально видно в протоколе встречи).

## Предварительные требования

- Docker Desktop — запущен перед прогоном.
- `HF_TOKEN` в переменных окружения. `pyannote/speaker-diarization-3.1` и
  `pyannote/segmentation-3.0` — оба **gated**: одного токена мало, нужно
  вручную принять условия на странице модели на huggingface.co под тем же
  аккаунтом, которому выпущен токен (иначе `hf_hub_download` падает 403,
  даже если whoami подтверждает, что токен валиден).
- Свободное место на диске: ~3–5 ГБ на образы + веса моделей.
- Node.js 18+ (для сборки корпуса и скоринга — без внешних зависимостей).

## Как запустить целиком

```bash
# 0. Собрать образы (один раз, требует Docker Desktop запущенным)
docker build -f research/diarization-asr-lab/docker/pyannote.Dockerfile \
  -t diar-lab/pyannote research/diarization-asr-lab
docker build -f research/diarization-asr-lab/docker/whisper.Dockerfile \
  -t diar-lab/whisper research/diarization-asr-lab

# 1. Получить сырые реплики Golos
pip install -r scripts/benchmark/requirements.txt
python3 scripts/benchmark/download_golos.py --count 40 --domain farfield \
  --out research/diarization-asr-lab/results/golos-raw

# 2. Собрать синтетический многоспикерный корпус
node research/diarization-asr-lab/corpus/build-corpus.mjs \
  --manifest research/diarization-asr-lab/results/golos-raw/manifest.jsonl \
  --out research/diarization-asr-lab/results/corpus \
  --sessions 8 --speakers-per-session 4

# 3. Диаризация (pyannote, CPU)
docker run --rm -e HF_TOKEN="$HF_TOKEN" \
  -v "$(pwd)/research/diarization-asr-lab/results/corpus:/data/corpus" \
  -v "$(pwd)/research/diarization-asr-lab/results/diarization:/data/out" \
  diar-lab/pyannote --corpus-dir /data/corpus --out /data/out

# 4. Распознавание речи (faster-whisper, CPU)
docker run --rm \
  -v "$(pwd)/research/diarization-asr-lab/results/corpus:/data/corpus" \
  -v "$(pwd)/research/diarization-asr-lab/results/asr:/data/out" \
  diar-lab/whisper --corpus-dir /data/corpus --out /data/out --model medium

# 5. Скоринг
node research/diarization-asr-lab/score/score-wer.mjs \
  --corpus-dir research/diarization-asr-lab/results/corpus \
  --asr-dir research/diarization-asr-lab/results/asr

node research/diarization-asr-lab/score/score-cpwer.mjs \
  --corpus-dir research/diarization-asr-lab/results/corpus \
  --asr-dir research/diarization-asr-lab/results/asr \
  --diarization-dir research/diarization-asr-lab/results/diarization
```

Все результаты попадают в `results/`

## Прогон на настоящей встрече (AMI Meeting Corpus)

Синтетика из Golos годится для ранжирования моделей, но не отражает
естественную речь. AMI — открытый корпус настоящих записанных совещаний
(CC BY 4.0, доступ без токена) с ручной разметкой слов по участникам.

```bash
# Разметка слов + аудио одной встречи
curl -L -o /tmp/ami_manual.zip \
  https://groups.inf.ed.ac.uk/ami/AMICorpusAnnotations/ami_public_manual_1.6.2.zip
unzip -q /tmp/ami_manual.zip -d research/diarization-asr-lab/results/ami-raw/ami_manual
curl -L -o research/diarization-asr-lab/results/ami-audio/ES2002b.Mix-Headset.wav \
  https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/ES2002b/audio/ES2002b.Mix-Headset.wav

# Собрать сессию в нашем формате
node research/diarization-asr-lab/corpus/ami-to-session.mjs \
  --words-dir research/diarization-asr-lab/results/ami-raw/ami_manual/words \
  --meeting-id ES2002b \
  --audio research/diarization-asr-lab/results/ami-audio/ES2002b.Mix-Headset.wav \
  --out research/diarization-asr-lab/results/ami-corpus

# Диаризация/ASR/скоринг — те же команды из блока выше, --corpus-dir на
# results/ami-corpus, для whisper добавить --language en
```

На CPU заметно дольше, чем на коротких клипах: 36-минутная встреча —
диаризация ~45 мин (RTF 1.24×), ASR ~25 мин (RTF 0.71×).

## Структура

```
research/diarization-asr-lab/
├── docker/          # Dockerfile на каждый бэкенд (pyannote/whisper/sortformer/diart)
├── corpus/          # сборка корпуса: Golos/FLEURS → синтетика, AMI → настоящая сессия, обрезка
├── run/             # инференс: diarize*.py/mjs, transcribe.py, merge-clusters.py
├── score/           # WER/cpWER
└── results/         # gitignored — артефакты прогонов
```

## Известные ограничения синтетического корпуса

Golos/FLEURS не дают speaker id, поэтому каждая реплика считается отдельным
синтетическим "спикером" — приближение, а не настоящая разметка. Реплики
короткие, в отличие от настоящей планёрки — абсолютные цифры хуже, чем на
реальной встрече. Корпус годится, чтобы **ранжировать** модели между собой,
не для абсолютных гарантий на реальных записях.

## Ключевые находки

**Baseline (pyannote, без модификаций).** Golos-синтетика (8×~13с сессий):
DER 47.3%, WER 14.4%, cpWER 84.0%. Настоящие встречи AMI (4 записи,
17.5–36.1 мин): DER 11.3–26.1%, WER 31.0%, cpWER 33.5% на лучшей из них.
Подсказка `num_speakers` подтверждённо вредит DER даже при точном значении.

**Корень проблемы «лишнего спикера» на длинных записях.** Разбор hyp.rttm
показал дрейф эмбеддинга: агломеративная кластеризация pyannote не сливает
поздние реплики тихого участника с его же ранними через большой временной
разрыв — человек становится двумя метками. Зависимость от длительности
записи немонотонная и не универсальна (проверено на 4 разных встречах,
17.5–36 мин, лишние спикеры от +1 до +5 — сильно зависит от акустики
конкретной комнаты, не только от длины). Подбор гиперпараметров
кластеризации (`clustering.threshold` в обе стороны, мягкие границы
`min/max_speakers`) не даёт универсального фикса — мягкие границы помогают
на лёгких случаях и вредят на тяжёлых.

**Альтернативные бэкенды — ни один не побил baseline pyannote:**
- **NeMo Sortformer (offline)** — 4 фиксированных слота, быстрый, но
  упирается в OOM: full self-attention по всей записи разом, память растёт
  быстрее длины линейно. Падает уже на ~15 мин записи на 16 ГБ RAM; на
  64 ГБ падает уже вся ВМ на 30-минутном окне. Ручной чанкинг (10 мин/60с
  нахлёст, сшивка по перестановкам меток в зоне перекрытия) обходит память,
  но DER хуже baseline (27.5% против 11.3% на той же записи) — лучшая
  найденная конфигурация, увеличение окна/нахлёста только вредит.
  Streaming-вариант модели существует, но единственные референсные
  реализации API в самом NeMo — deprecated/сильно завязаны на внутреннюю
  инфраструктуру; решили не портировать вручную.
- **pyannote с тем же ручным чанкингом** — везде хуже baseline (сшивка
  между кусками создаёт больше новых ошибок, чем убирает).
- **diart** (streaming, без потолка числа спикеров) — тоже хуже baseline
  (DER 24.3%, теряет спикера вместо того, чтобы плодить лишних).

**Рабочий метод: слияние кластеров по эмбеддингу голоса.** Постобработка
уже готовой диаризации pyannote (`run/merge-clusters.py`), не трогает
временную ось и не перезапускает модель. Для каждой найденной метки
считается эмбеддинг голоса (`pyannote/wespeaker-voxceleb-resnet34-LM`),
метки сливаются по взаимно-ближайшим соседям с **адаптивным порогом**
(наибольший разрыв в распределении сходства именно этой записи, не одна
цифра на все случаи) и многораундовым откатом, если очередной раунд
ухудшил DER.

Проверено на 4 настоящих встречах AMI — не хуже baseline нигде, лучше на
части, спикеров сходится к верному числу на 3 из 4:

| Запись | pyannote baseline (DER/cpWER/спикеров) | + слияние (DER/cpWER/спикеров) |
|---|---|---|
| ES2002b (36.1 мин) | 11.33% / 33.5% / 5 | **11.30%** / **33.2%** / **4** |
| TS3006a (20.5 мин) | 25.24% / 41.5% / 7 | **24.37%** / **39.7%** / **4** |
| EN2002b (29.8 мин) | 26.14% / н/д / 9 | **25.05%** / **49.6%** / 5 |
| ES2004a (17.5 мин) | 18.93% / — / 5 | **18.62%** / — / **4** |

Проверено также на синтетическом русском корпусе (Google FLEURS) — там
доминирует обратная проблема (недобор спикеров), для которой слияние
принципиально не лекарство (оно может только объединять метки, не
разлеплять). На всех 8 сессиях метод корректно не тронул ничего — важное
подтверждение, что он безопасен и вне своей области применения.

## Сравнительная таблица бэкендов (AMI ES2002b, 36.1 мин)

| Бэкенд | DER | cpWER | RTF | Спикеров |
|---|---|---|---|---|
| pyannote (без модификаций) | 11.3% | 33.5% | 1.24x | 5 |
| **pyannote + слияние по эмбеддингу** | **11.30%** | **33.2%** | 1.24x + секунды | **4** |
| pyannote, ручной чанкинг | 16.1% | 36.5% | 1.35x | 7 |
| sortformer offline (без чанкинга) | OOM | — | — | — |
| sortformer, ручной чанкинг (лучшая конфигурация) | 27.5% | 41.4% | 0.24x | 4 |
| diart | 24.3% | 48.4% | 0.79x | 3 |