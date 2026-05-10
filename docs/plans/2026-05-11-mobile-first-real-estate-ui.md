# Mobile-First Real Estate UI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Упростить интерфейс до mobile-first двухэкранного сценария и добавить лёгкий архитектурный фон под тематику недвижимости.

**Architecture:** Логику backend и pipeline не трогаем. Меняем UI-структуру, копирайтинг, CSS и статический фоновый asset. Проектный экран становится единым контейнером для загрузки, обработки, черновика и результата.

**Tech Stack:** Vanilla React via CDN, CSS variables, static SVG background asset, local Node HTTP server, Node test runner.

---

### Task 1: Update UI smoke tests for the simplified 2-screen flow

**Files:**
- Modify: `apps/server/tests/static-ui.test.js`

**Step 1: Write the failing test**

Проверить наличие новых мобильных текстов:
- `Выбрать файл`
- `Последние встречи`
- `Люди проекта`

Проверить отсутствие старого визуального шума по ключевым строкам:
- `Быстрый старт`
- `Контекст проекта`

**Step 2: Run test to verify it fails**

Run: `node --test apps/server/tests/static-ui.test.js`
Expected: FAIL

**Step 3: Write minimal implementation**

Обновить UI-копирайтинг и структуру, чтобы строки появились в собранном скрипте.

**Step 4: Run test to verify it passes**

Run: `node --test apps/server/tests/static-ui.test.js`
Expected: PASS

### Task 2: Simplify the app structure for mobile-first 2-screen navigation

**Files:**
- Modify: `apps/web/app/app.js`
- Modify: `apps/web/app/ui-model.js`
- Test: rely on `apps/server/tests/static-ui.test.js` and `apps/web/tests/ui-model.test.js`

**Step 1: Write the failing test**

Reuse failing smoke test from Task 1 and keep existing screen-model tests green unless the screen ids change.

**Step 2: Run test to verify it fails**

Run: `node --test apps/server/tests/static-ui.test.js`
Expected: FAIL

**Step 3: Write minimal implementation**

- сделать отдельный экран проектов;
- сделать отдельный экран проекта;
- убрать sidebar-style overload;
- в проекте оставить только upload/result area и short meeting history;
- вынести команду проекта в отдельный secondary screen.

**Step 4: Run test to verify it passes**

Run: `node --test apps/server/tests/static-ui.test.js apps/web/tests/ui-model.test.js`
Expected: PASS

### Task 3: Add the real-estate architectural background

**Files:**
- Create: `apps/web/app/real-estate-grid.svg`
- Modify: `apps/web/app/styles.css`
- Modify: `apps/server/src/server/create-http-handler.js`

**Step 1: Write the failing test**

No dedicated asset snapshot harness exists. Use the existing UI smoke test and final browser verification.

**Step 2: Run test to verify it fails**

Not applicable separately.

**Step 3: Write minimal implementation**

- создать лёгкий SVG с линиями архитектурного плана;
- подключить его в фоне интерфейса;
- убедиться, что static server отдает `.svg` с корректным content type.

**Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS

### Task 4: Verify mobile rendering and build

**Files:**
- No code changes expected unless verification finds regressions

**Step 1: Run full tests**

Run: `npm test`
Expected: PASS

**Step 2: Build production assets**

Run: `npm run build`
Expected: PASS

**Step 3: Verify in browser at phone width**

Check:
- projects screen is uncluttered;
- project screen has a clear `Выбрать файл` CTA;
- history is short and readable;
- draft and result remain readable on a narrow viewport.

**Step 4: Fix issues if found**

Only if verification reveals a problem.
