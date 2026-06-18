# Как участвовать в разработке YaSpeech

Этот файл — точка входа для любого, кто будет писать код. Если ты только
разворачиваешь сервис или эксплуатируешь его — тебе в
[Project Handbook](./docs/project-handbook/README.md).

---

## Быстрый старт (5 минут)

```bash
git clone git@github.com:Gumbatali/YaSpeech.git
cd YaSpeech
npm test          # 54 теста — должны пройти без установки зависимостей
npm run dev       # http://127.0.0.1:8787
```

Зависимости устанавливать **не нужно** — у проекта ноль npm-пакетов в проде.
`npm test` и `npm run dev` работают на чистом Node.js 18+ из коробки.

Локально всё крутится на mock-адаптерах: без реальных вызовов Yandex Cloud, без
платных API. Можно загрузить файл, пройти весь сценарий и получить протокол —
данные сгенерирует mock.

> Подробный гайд по локальной разработке (включая запуск с аутентификацией и
> реальными ключами): [local-setup.md](./docs/project-handbook/06-development/local-setup.md).

---

## Что где лежит

```
packages/core/      Домен и use cases. Ноль зависимостей от облака.
apps/server/        Backend: HTTP-слой + инфраструктура (адаптеры YC).
apps/web/           Фронтенд: SPA на React + htm, без шага сборки.
docs/               Документация (Project Handbook).
scripts/            deploy.sh и операционные скрипты.
infra/              Спека API Gateway.
.github/workflows/  CI (тесты) и Deploy (выкатка в YC).
```

Полная карта файлов: [codebase-map.md](./docs/project-handbook/06-development/codebase-map.md).

---

## Рабочий процесс

1. **Ветка от `main`.** Называй по смыслу: `fix/clipboard-http`, `feat/export-docx`.
2. **Пиши тест.** Новая логика — новый тест. Багфикс — тест, который падал до фикса.
3. **`npm test` локально.** Все 54+ должны быть зелёными.
4. **Открой Pull Request.** Шаблон подставится сам — заполни его.
5. **CI прогонит тесты** автоматически (см. ниже). PR без зелёного CI не мержим.
6. **Мерж в `main` → автодеплой** в прод (после прохождения тестов).

> CI/CD устроен здесь: [ci-cd.md](./docs/project-handbook/05-delivery-and-operations/ci-cd.md).

---

## Конвенции кода

- **Коммиты:** [Conventional Commits](https://www.conventionalcommits.org/ru/) —
  `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`.
- **Стиль:** маленькие файлы (200–400 строк, максимум 800), функции до ~50 строк,
  ранние возвраты вместо глубокой вложенности.
- **Иммутабельность:** не мутируем объекты — возвращаем новые (`{...old, field}`).
- **Ошибки:** обрабатываем явно, не глотаем молча. Пользователю — понятный текст,
  в лог — детали с `meetingId`.
- **Никаких секретов в коде.** Ключи — только через переменные окружения.

### Главный архитектурный инвариант

> **Ноль автоматических LLM-вызовов.** Любой вызов YandexGPT происходит ТОЛЬКО
> по явному действию пользователя (кнопка «Улучшить с помощью ИИ», «Собрать
> протокол»). Расшифровка после ASR собирается мгновенно и бесплатно, без LLM.

Если трогаешь пайплайн обработки — этот инвариант нельзя нарушать.

---

## Тесты

```bash
npm test                                    # всё разом
node --test apps/server/tests/api.test.js   # один файл
node --test apps/web/tests/*.test.js        # только фронтовые
```

Структура — Arrange-Act-Assert, имена тестов описывают поведение
(`«возвращает 400 при пустом projectId»`, а не `«тест 1»`).

Для визуальных изменений во фронте — проверяй вручную в браузере (`npm run dev`),
скриншоты до/после в PR.

---

## Полезные ссылки

| Нужно | Где |
|-------|-----|
| Понять, что делает сервис | [КАК-ЭТО-РАБОТАЕТ](./docs/КАК-ЭТО-РАБОТАЕТ.md) |
| Архитектура | [architecture-overview](./docs/project-handbook/03-solution-architecture/architecture-overview.md) |
| Карта кода | [codebase-map](./docs/project-handbook/06-development/codebase-map.md) |
| API | [api-and-data-contracts](./docs/project-handbook/04-system-analysis/api-and-data-contracts.md) |
| Локальная разработка | [local-setup](./docs/project-handbook/06-development/local-setup.md) |
| Деплой и CI/CD | [ci-cd](./docs/project-handbook/05-delivery-and-operations/ci-cd.md) |
| Что сломалось в проде | [runbook](./docs/project-handbook/05-delivery-and-operations/runbook.md) |
