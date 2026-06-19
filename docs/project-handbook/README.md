# Project Handbook

Единый комплект проектной документации по `YaSpeech MVP`.

Папка собрана так, чтобы ею могли пользоваться одновременно:

- менеджер продукта;
- бизнес- и системный аналитик;
- solution-архитектор;
- разработчик;
- инженер, который будет разворачивать решение в Yandex Cloud.

## Что это за проект

`YaSpeech` — веб-сервис, который превращает аудиозапись встречи в готовый
протокол: дословная расшифровка, разбор по спикерам, улучшение текста ИИ и
итоговый документ с решениями и задачами.

> Нужно объяснение без жаргона? См.
> [«Как это работает — простыми словами»](../КАК-ЭТО-РАБОТАЕТ.md).
> Пошаговое использование — в [руководстве пользователя](../РУКОВОДСТВО-ПОЛЬЗОВАТЕЛЯ.md).

Из чего состоит сервис:

- работает в Яндекс Облаке на serverless-контуре (Object Storage, Message Queue,
  Cloud Functions, API Gateway);
- распознаёт речь через `Yandex SpeechKit`, улучшает текст и собирает протокол
  через `YandexGPT`; для локальной разработки те же интеграции заменены mock-адаптерами;
- личные кабинеты: вход по логину/паролю, роли и квоты;
- редактирование расшифровки и итогов, возврат к оригиналу, пересборка протокола;
- LLM-обработка — только по кнопке пользователя (ноль автоматических LLM-вызовов);
- память проекта: перенос задач и накопительный словарь терминов;
- CI/CD: автотесты на каждый PR, автодеплой при мерже в `main`.

## Как читать эту папку

Если вы:

- `пользователь продукта` — вам сюда не обязательно, начните с
  [руководства пользователя](../РУКОВОДСТВО-ПОЛЬЗОВАТЕЛЯ.md);
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
- [CI/CD — автотесты и деплой](./05-delivery-and-operations/ci-cd.md)
- [Мониторинг и логи](./05-delivery-and-operations/monitoring-and-logging.md)
- [IAM и доступы](./05-delivery-and-operations/iam-and-access.md)
- [Runbook](./05-delivery-and-operations/runbook.md)

### `06-development`

- [Локальная разработка](./06-development/local-setup.md)
- [Карта кодовой базы](./06-development/codebase-map.md)
- [Handoff и roadmap](./06-development/handoff-and-roadmap.md)
- [Как участвовать (CONTRIBUTING)](../../CONTRIBUTING.md)

## Ключевые договорённости

- UI строится как `mobile-first` решение.
- Главный пользовательский сценарий: `сначала проект -> потом загрузка файла`.
- Облачный контур: `Object Storage + API Gateway + Cloud Functions + Message Queue + SpeechKit + YandexGPT`.
- Облачные функции работают без npm-зависимостей — только стандартная библиотека Node.
- Критично сохранять `минимальное потребление облачных ресурсов` (serverless, прямой upload в хранилище).
