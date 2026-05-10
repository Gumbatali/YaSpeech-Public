# Project Handbook

Единый комплект проектной документации по `YaSpeech MVP`.

Папка собрана так, чтобы ею могли пользоваться одновременно:

- менеджер продукта;
- бизнес- и системный аналитик;
- solution-архитектор;
- разработчик;
- инженер, который будет разворачивать решение в Yandex Cloud.

## Что это за проект

`YaSpeech` — это веб-интерфейс для загрузки аудиозаписей встреч, подготовки транскрипта, черновика названия и спикеров, а затем итогового протокола встречи.

Текущее состояние проекта:

- локальный MVP уже реализован;
- фронтенд и backend работают локально;
- `SpeechSense` и `AI Studio` пока подключены через mock-адаптеры;
- архитектура уже подготовлена к замене mock-слоя на реальные интеграции в облаке.

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
- Облачный target-контур: `Object Storage + API Gateway + Cloud Functions + Message Queue + SpeechSense + AI Studio`.
- На текущем этапе критично сохранять `минимальное потребление облачных ресурсов`.
