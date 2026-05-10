# Project-First Upload Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Перестроить текущий интерфейс под сценарий `сначала проект, затем загрузка записи`, добавить экран черновика встречи и сохранить совместимость с дешёвым serverless-развёртыванием.

**Architecture:** Меняем только UI-слой и минимально расширяем локальный mock pipeline, чтобы он умел отдавать черновое название встречи и черновых спикеров. Backend API остаётся лёгкой HTTP-обёрткой с файловым хранением и асинхронной обработкой. История встреч и итоговый протокол сохраняются в существующей модели встречи.

**Tech Stack:** Vanilla React via CDN, CSS variables, local Node HTTP server, файловые JSON-репозитории, встроенный тест-раннер Node.

---

### Task 1: Update UI state model for the new screen flow

**Files:**
- Modify: `apps/web/app/ui-model.js`
- Test: `apps/web/tests/ui-model.test.js`

**Step 1: Write the failing test**

Добавить тесты на:
- новый главный экран выбранного проекта;
- стадию черновика после транскрипта;
- новые человекочитаемые статусы.

**Step 2: Run test to verify it fails**

Run: `npm test -- apps/web/tests/ui-model.test.js`
Expected: FAIL because the new screen mapping and labels do not exist yet.

**Step 3: Write minimal implementation**

Добавить новые screen ids и обновить функции:
- `resolveScreen`
- `getStageViewModel`
- `getMeetingStatusLabel`
- helpers для стадий черновика

**Step 4: Run test to verify it passes**

Run: `npm test -- apps/web/tests/ui-model.test.js`
Expected: PASS

### Task 2: Extend mock meeting results with draft title and draft speakers

**Files:**
- Modify: `apps/server/src/infrastructure/mock-speech-sense-gateway.js`
- Modify: `apps/server/src/infrastructure/mock-ai-studio-gateway.js`
- Test: `apps/server/tests/api.test.js`

**Step 1: Write the failing test**

Добавить API-ожидание, что готовая встреча содержит:
- `titleDraft`
- `speakerDrafts`
- speaker-oriented transcript preview

**Step 2: Run test to verify it fails**

Run: `npm test -- apps/server/tests/api.test.js`
Expected: FAIL because draft fields are missing.

**Step 3: Write minimal implementation**

Обновить mock gateways так, чтобы локальный pipeline возвращал реалистичный черновик встречи после обработки.

**Step 4: Run test to verify it passes**

Run: `npm test -- apps/server/tests/api.test.js`
Expected: PASS

### Task 3: Rebuild the right-hand workspace around upload-first flow

**Files:**
- Modify: `apps/web/app/app.js`
- Test: `apps/server/tests/static-ui.test.js`

**Step 1: Write the failing test**

Добавить тесты на наличие нового текста и структуры:
- `Выберите проект слева`
- `Загрузить запись`
- `Черновик встречи`
- `Собрать протокол`

**Step 2: Run test to verify it fails**

Run: `npm test -- apps/server/tests/static-ui.test.js`
Expected: FAIL because the current UI still reflects the older wizard wording.

**Step 3: Write minimal implementation**

Перестроить `App`:
- сохранить projects rail слева;
- убрать сложный многоэкранный мастер;
- добавить рабочий экран проекта с upload CTA;
- добавить экран черновика и обновлённый экран результата.

**Step 4: Run test to verify it passes**

Run: `npm test -- apps/server/tests/static-ui.test.js`
Expected: PASS

### Task 4: Redesign styles for a calmer project-first workspace

**Files:**
- Modify: `apps/web/app/styles.css`

**Step 1: Write the failing test**

В этом репозитории нет визуального CSS snapshot harness, поэтому вместо отдельного теста опираемся на уже падающий UI smoke test и на ручную проверку в браузере.

**Step 2: Run test to verify it fails**

Not applicable beyond Task 3 UI smoke failures.

**Step 3: Write minimal implementation**

Пересобрать визуальную систему:
- спокойная левая rail;
- крупная правая рабочая панель;
- один главный CTA;
- мягкая иерархия вторичных действий;
- новые блоки для черновика встречи и результатов.

**Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS

### Task 5: Verify build and local browser behavior

**Files:**
- No code changes expected unless a bug is found during verification

**Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS

**Step 2: Build production assets**

Run: `npm run build`
Expected: PASS

**Step 3: Verify in browser**

Run local server and confirm:
- project-first screen is understandable;
- upload CTA is dominant;
- processing states read naturally;
- draft screen shows title and speakers;
- result screen remains readable on desktop.

**Step 4: Fix any discovered regressions**

Only if verification uncovers an issue.
