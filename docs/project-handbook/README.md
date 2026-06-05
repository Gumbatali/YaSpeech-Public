# Project Handbook

Единый комплект проектной документации по `YaSpeech MVP`.

Папка собрана так, чтобы ею могли пользоваться одновременно:

- менеджер продукта;
- бизнес- и системный аналитик;
- solution-архитектор;
- разработчик;
- инженер, который будет разворачивать решение в Yandex Cloud.

## Что это за проект

`YaSpeech` — это веб-сервис для загрузки аудиозаписей встреч, подготовки транскрипта, черновика названия и спикеров, а затем итогового протокола встречи.

> Нужно объяснение без технического жаргона? См.
> [«Как это работает — простыми словами»](../КАК-ЭТО-РАБОТАЕТ.md).

Текущее состояние проекта:

- сервис развёрнут в Яндекс Облаке (Object Storage, Message Queue, Cloud Functions, API Gateway);
- реальные интеграции `Yandex SpeechKit` и `YandexGPT` подключены в production;
- mock-адаптеры сохранены для локальной разработки и тестов;
- реализованы личные кабинеты (вход по логину/паролю), роли и квоты;
- реализованы редактирование расшифровки и итогов, возврат к оригиналу, пересборка протокола;
- работает память проекта: перенос задач и словарь терминов.

## Как читать эту папку

Если вы:

- `менеджер / заказчик` — начните с `01-product` и `02-business-analysis`;
- `solution-архитектор` — начните с `03-solution-architecture`;
- `системный аналитик` — начните с `04-system-analysis`;
- `DevOps / cloud engineer` — начните с `05-delivery-and-operations`;
- `разработчик` — начните с `06-development`.

## Структура

### `01-product`

- [Обзор продукта](./01-product/product-overview.md)
- [Пользовательские сценарии](./01-product/user-journeys.md)

### `02-business-analysis`

- [Стейкхолдеры, границы и риски](./02-business-analysis/stakeholders-scope-and-risks.md)
- [Требования и NFR](./02-business-analysis/requirements-and-nfr.md)

### `03-solution-architecture`

- [Обзор архитектуры](./03-solution-architecture/architecture-overview.md)
- [C4 Context](./03-solution-architecture/c4-context.md)
- [C4 Container](./03-solution-architecture/c4-container.md)
- [C4 Component](./03-solution-architecture/c4-component.md)
- [Deployment и интеграции](./03-solution-architecture/deployment-and-integrations.md)
- [HTML-обзор архитектуры](./03-solution-architecture/architecture-overview.html)

### `04-system-analysis`

- [Доменная модель](./04-system-analysis/domain-model.md)
- [Состояния и последовательности](./04-system-analysis/state-and-sequence.md)
- [API и контракты данных](./04-system-analysis/api-and-data-contracts.md)

### `05-delivery-and-operations`

- [Облачное развёртывание](./05-delivery-and-operations/cloud-deployment.md)
- [IAM и доступы](./05-delivery-and-operations/iam-and-access.md)
- [Runbook](./05-delivery-and-operations/runbook.md)

### `06-development`

- [Карта кодовой базы](./06-development/codebase-map.md)
- [Handoff и roadmap](./06-development/handoff-and-roadmap.md)

## Ключевые договорённости

- UI строится как `mobile-first` решение.
- Главный пользовательский сценарий: `сначала проект -> потом загрузка файла`.
- Облачный контур (реализован): `Object Storage + API Gateway + Cloud Functions + Message Queue + SpeechKit + YandexGPT`.
- Облачные функции работают без npm-зависимостей — только стандартная библиотека Node.
- Критично сохранять `минимальное потребление облачных ресурсов` (serverless, прямой upload в хранилище).
