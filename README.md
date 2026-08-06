# YaSpeech Cookbook — автопротоколирование деловых встреч на Yandex Cloud

Учебный пример пайплайна **«запись встречи → готовый протокол»** на трёх сервисах
Yandex Cloud: SpeechKit (распознавание речи), YandexGPT (разметка спикеров и
протокол) и Object Storage (промежуточное хранение аудио).

Идея — из внутреннего сервиса **YaSpeech** (компания «Стройтехэксперт», фиксация
решений по строительным планёркам), но код здесь самостоятельный и учебный, не
портированный прод.

> Прод-сервис (Node.js, Cloud Functions + API Gateway + YMQ) — в ветке
> [`main`](https://github.com/Gumbatali/YaSpeech-Public/tree/main).

---

## Что в этой ветке

| Файл | Назначение |
|---|---|
| [`cookbook_yaspeech.ipynb`](./cookbook_yaspeech.ipynb) | Ноутбук: аудио → распознавание → протокол |
| [`system_prompts.md`](./system_prompts.md) | Текст промпта с пояснениями |
| [`navigation.md`](./navigation.md) | Оглавление и best practices |
| [`requirements.txt`](./requirements.txt) | Зависимости Python |
| [`.env.example`](./.env.example) | Шаблон переменных окружения для локального запуска |

---

## Что показывает кукбук

- **Диаризация по составу участников** вместо абстрактных «Спикер 1/2» — модель получает список команды проекта (имена и роли) внутри одного запроса вместе с транскриптом и сама сопоставляет реплики с людьми.
- **Один структурированный вызов** вместо цепочки промптов — для учебного примера этого достаточно; как разбить на этапы для длинных встреч — см. раздел 9 ноутбука.
- **Pydantic-валидация ответа** — модель просят вернуть JSON по схеме, а не диктуют формат через непроверенные API-параметры; результат сразу проверяется на соответствие типам.

---

## Быстрый старт

### Google Colab

Откройте `cookbook_yaspeech.ipynb` в Colab и задайте переменные окружения
(`FOLDER_ID`, `YC_API_KEY`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`) через
Colab Secrets или прямо в ячейке — `dotenv` в Colab, если `.env` нет, просто не
найдёт файл и не помешает.

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
| `YC_API_KEY` | [API-ключ сервисного аккаунта](https://yandex.cloud/ru/docs/iam/operations/api-key/create) (роли `ai.speechkit-stt.user`, `ai.languageModels.user`, `storage.uploader`) |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | [статические ключи для Object Storage](https://yandex.cloud/ru/docs/storage/operations/access-keys/create) |

Ноутбук делает реальные платные вызовы (SpeechKit + YandexGPT) и создаёт бакет
Object Storage.

---

## Полезные ссылки

- [SpeechKit STT v3](https://aistudio.yandex.ru/docs/ru/speechkit/stt/api/transcribation-api-v3) — асинхронное распознавание
- [Определение дикторов (speaker labeling)](https://aistudio.yandex.ru/docs/ru/speechkit/stt/speaker-labeling)
- [Доступные модели YandexGPT](https://aistudio.yandex.ru/docs/ru/ai-studio/concepts/generation/models)
- [OpenAI-совместимое API](https://yandex.cloud/en/docs/ai-studio/concepts/openai-compatibility)
- [Object Storage (S3-совместимое API)](https://yandex.cloud/ru/docs/storage/s3/)

---

## Обратная связь

Нашли ошибку или есть предложение — [создайте Issue](https://github.com/Gumbatali/YaSpeech-Public/issues).
