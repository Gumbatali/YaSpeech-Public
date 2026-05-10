# Project Handbook Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Добавить в репозиторий отдельную папку с полной русскоязычной проектной документацией по продукту, архитектуре, аналитике, облачному развёртыванию и передаче проекта.

**Architecture:** Документация строится вокруг уже реализованного локального MVP и его целевого serverless-развёртывания в Yandex Cloud. Материалы делятся по ролям и уровням абстракции: продукт, бизнес-анализ, solution-архитектура, системный анализ, эксплуатация и разработка.

**Tech Stack:** Markdown, Mermaid, HTML

---

### Task 1: Спроектировать структуру handbook

**Files:**
- Create: `docs/plans/2026-05-11-project-handbook-design.md`
- Create: `docs/project-handbook/README.md`

**Step 1: Зафиксировать роли и аудитории**

- Выделить читателей: менеджер, аналитик, solution-архитектор, разработчик, DevOps.

**Step 2: Разбить материалы по разделам**

- `01-product`
- `02-business-analysis`
- `03-solution-architecture`
- `04-system-analysis`
- `05-delivery-and-operations`
- `06-development`

**Step 3: Описать способ чтения папки**

- Добавить индекс handbook и навигацию по ролям.

### Task 2: Добавить продуктовую и аналитическую часть

**Files:**
- Create: `docs/project-handbook/01-product/product-overview.md`
- Create: `docs/project-handbook/01-product/user-journeys.md`
- Create: `docs/project-handbook/02-business-analysis/stakeholders-scope-and-risks.md`
- Create: `docs/project-handbook/02-business-analysis/requirements-and-nfr.md`

**Step 1: Описать цель продукта и границы MVP**

- Зафиксировать in scope / out of scope и целевой сценарий.

**Step 2: Описать пользовательские потоки**

- Разложить действия пользователя от выбора проекта до протокола.

**Step 3: Описать ограничения и риски**

- Включить ограничения по стоимости, доступам и точности определения спикеров.

### Task 3: Добавить solution-архитектуру и диаграммы

**Files:**
- Create: `docs/project-handbook/03-solution-architecture/architecture-overview.md`
- Create: `docs/project-handbook/03-solution-architecture/c4-context.md`
- Create: `docs/project-handbook/03-solution-architecture/c4-container.md`
- Create: `docs/project-handbook/03-solution-architecture/c4-component.md`
- Create: `docs/project-handbook/03-solution-architecture/deployment-and-integrations.md`
- Create: `docs/project-handbook/03-solution-architecture/architecture-overview.html`

**Step 1: Описать целевую serverless-схему**

- Указать Web UI, API Gateway, Cloud Functions, Queue, Storage, SpeechSense и AI Studio.

**Step 2: Добавить C4-представления**

- Context
- Container
- Component

**Step 3: Добавить deployment и интеграции**

- Зафиксировать, где живёт код, где лежат артефакты и кто вызывает внешние сервисы.

### Task 4: Добавить системный анализ

**Files:**
- Create: `docs/project-handbook/04-system-analysis/domain-model.md`
- Create: `docs/project-handbook/04-system-analysis/state-and-sequence.md`
- Create: `docs/project-handbook/04-system-analysis/api-and-data-contracts.md`

**Step 1: Описать доменную модель**

- Проекты, встречи, участники, транскрипт, протокол.

**Step 2: Зафиксировать жизненный цикл встречи**

- От `uploading` до `done` и `failed`, включая `draft_ready`.

**Step 3: Описать API и хранение**

- Эндпоинты, JSON-контракты и ключи артефактов.

### Task 5: Добавить эксплуатацию и handoff

**Files:**
- Create: `docs/project-handbook/05-delivery-and-operations/cloud-deployment.md`
- Create: `docs/project-handbook/05-delivery-and-operations/iam-and-access.md`
- Create: `docs/project-handbook/05-delivery-and-operations/runbook.md`
- Create: `docs/project-handbook/06-development/codebase-map.md`
- Create: `docs/project-handbook/06-development/handoff-and-roadmap.md`
- Modify: `README.md`

**Step 1: Описать развёртывание в Yandex Cloud**

- Минимальные ресурсы, конфигурация и шаги.

**Step 2: Описать доступы и операционную модель**

- Сервисные аккаунты, роли, конфиг, логи и smoke checks.

**Step 3: Добавить карту кода и handoff**

- Что уже реализовано, что мокировано и что делать следующей итерацией.
