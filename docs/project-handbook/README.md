# Project Handbook

Единый комплект проектной документации по `YaSpeech MVP`.

Папка содержит только техническую документацию, необходимую разработчику и инженеру эксплуатации (DevOps).

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
- LLM-улучшение расшифровки — по кнопке пользователя (ноль автоматических LLM-вызовов);
- работает память проекта: перенос задач и словарь терминов;
- настроен CI/CD: автотесты на каждый PR, автодеплой при мерже в `main`.

## Как читать эту папку

- **Архитектура** — обзор того, как компоненты взаимодействуют друг с другом (`03-solution-architecture`).
- **Справочники** — описание API и доменной модели (`04-system-analysis`).
- **Эксплуатация** — развёртывание, CI/CD, логи и Runbook (`05-delivery-and-operations`).
- **Разработка** — как поднять локально и карта кодовой базы (`06-development`).

## Структура

### `solution-architecture`

- [Обзор архитектуры](./03-solution-architecture/architecture-overview.md)
- [C4 Context](./03-solution-architecture/c4-context.md)
- [C4 Container](./03-solution-architecture/c4-container.md)
- [C4 Component](./03-solution-architecture/c4-component.md)
- [Deployment и интеграции](./03-solution-architecture/deployment-and-integrations.md)
- [HTML-обзор архитектуры](./03-solution-architecture/architecture-overview.html)

### `system-analysis`

- [Доменная модель](./04-system-analysis/domain-model.md)
- [Состояния и последовательности](./04-system-analysis/state-and-sequence.md)
- [API и контракты данных](./04-system-analysis/api-and-data-contracts.md)

### `delivery-and-operations`

- [Облачное развёртывание](./05-delivery-and-operations/cloud-deployment.md)
- [CI/CD — автотесты и деплой](./05-delivery-and-operations/ci-cd.md)
- [Мониторинг и логи](./05-delivery-and-operations/monitoring-and-logging.md)
- [IAM и доступы](./05-delivery-and-operations/iam-and-access.md)
- [Runbook](./05-delivery-and-operations/runbook.md)

### `development`

- [Локальная разработка](./06-development/local-setup.md)
- [Карта кодовой базы](./06-development/codebase-map.md)
- [Handoff и roadmap](./06-development/handoff-and-roadmap.md)
- [Как участвовать (CONTRIBUTING)](../../CONTRIBUTING.md)

## Ключевые договорённости

- UI строится как `mobile-first` решение.
- Главный пользовательский сценарий: `сначала проект -> потом загрузка файла`.
- Облачный контур (реализован): `Object Storage + API Gateway + Cloud Functions + Message Queue + SpeechKit + YandexGPT`.
- Облачные функции работают без npm-зависимостей — только стандартная библиотека Node.
- Критично сохранять `минимальное потребление облачных ресурсов` (serverless, прямой upload в хранилище).
