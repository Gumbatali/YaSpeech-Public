# YaSpeech Cookbook — автопротоколирование деловых встреч на Yandex Cloud

Кукбук по сборке пайплайна **«запись встречи → готовый протокол»** на трёх сервисах
Yandex Cloud: SpeechKit (ASR с диаризацией), YandexGPT (многоходовый LLM-анализ)
и Object Storage (хранение артефактов).

Основан на архитектуре реального продакшн-сервиса **YaSpeech**, который компания
«Стройтехэксперт» использует для фиксации решений и задач по строительным
проектам. Здесь — упрощённая, но рабочая Python-версия того же пайплайна,
которую можно прогнать в Colab или Jupyter.

> Код продакшн-сервиса (Node.js, Cloud Functions + API Gateway + YMQ) лежит
> в ветке [`main`](https://github.com/Gumbatali/YaSpeech-Public/tree/main).

---

## Что в этой ветке

| Файл | Назначение |
|---|---|
| [`cookbook_yaspeech.ipynb`](./cookbook_yaspeech.ipynb) | Основной ноутбук: весь пайплайн от загрузки аудио до протокола |
| [`system_prompts.md`](./system_prompts.md) | Полные тексты промптов с пояснениями + отличия прод-версии |
| [`navigation.md`](./navigation.md) | Оглавление кукбука и best practices |
| [`requirements.txt`](./requirements.txt) | Зависимости Python |
| [`.env.example`](./.env.example) | Шаблон переменных окружения для локального запуска |
| [`architecture.png`](./architecture.png) | Схема пайплайна |

---

## Что демонстрирует кукбук

- **Многоходовый LLM-анализ** вместо одного большого промпта: контекст → диаризация
  → коррекция → идентификация спикеров → протокол. Каждый проход решает одну узкую
  задачу, ошибка одного не портит остальные.
- **Line-ID протокол** для коррекции ASR-ошибок — приём против того, что модель
  тихо теряет реплики: каждая реплика нумеруется `[N]`, пропажа номера
  детектируется программно и вызывает retry.
- **Детерминированный валидатор чисел** — правка, изменившая число или дату,
  отклоняется кодом, а не «честностью» модели.
- **Диаризация по составу участников проекта** — вместо абстрактных «Спикер 1/2»
  модель получает реальный список команды (имена и роли) и сопоставляет реплики
  с конкретными людьми.

---

## Быстрый старт

### Google Colab

Откройте `cookbook_yaspeech.ipynb` в Colab и заполните Colab Secrets —
`FOLDER_ID`, `YC_API_KEY`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
(первая ячейка ноутбука читает именно их).

### Локально

```bash
pip install -r requirements.txt
cp .env.example .env    # заполните реальными значениями
jupyter notebook cookbook_yaspeech.ipynb
```

Что понадобится в Yandex Cloud:

| Переменная | Где взять |
|---|---|
| `FOLDER_ID` | [идентификатор каталога](https://yandex.cloud/ru/docs/resource-manager/operations/folder/get-id) |
| `YC_API_KEY` | [API-ключ сервисного аккаунта](https://yandex.cloud/ru/docs/iam/operations/api-key/create) (SpeechKit + YandexGPT) |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | [статические ключи для Object Storage](https://yandex.cloud/ru/docs/storage/operations/access-keys/create) |

Ноутбук делает реальные платные вызовы (SpeechKit + YandexGPT) и создаёт бакет
Object Storage. В разделе 8 есть ячейка очистки ресурсов — вызов закомментирован,
раскомментируйте, когда закончите.

---

## Полезные ссылки

- [SpeechKit STT v3](https://yandex.cloud/ru/docs/speechkit/stt-v3/) — асинхронное распознавание
- [Диаризация (speaker labeling)](https://yandex.cloud/ru/docs/speechkit/stt/speaker-labeling)
- [YandexGPT в Model Gallery (раздел AI Studio)](https://yandex.cloud/ru/docs/ai-studio/quickstart/yandexgpt)
- [OpenAI-совместимое API](https://yandex.cloud/ru/docs/foundation-models/concepts/openai-compatibility)
- [Object Storage (S3-совместимое API)](https://yandex.cloud/ru/docs/storage/s3/)

---

## Обратная связь

Нашли ошибку или есть предложение — [создайте Issue](https://github.com/Gumbatali/YaSpeech-Public/issues).
