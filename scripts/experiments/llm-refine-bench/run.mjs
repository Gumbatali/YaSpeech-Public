/**
 * Бенчмарк: какая модель YandexGPT лучше подходит для коррекции ASR-расшифровки.
 *
 * Сравнивает модели на line-ID-протоколе (прототип будущего refine-пайплайна):
 *   вход:  [N] Спикер X: текст с ошибками ASR
 *   выход: [N] исправленный текст
 *
 * Метрики на модель:
 *   - WER до/после коррекции (восстановление качества)
 *   - WER на чистом кейсе (гиперкоррекция — модель не должна портить верный текст)
 *   - format compliance (доля строк с валидным [N])
 *   - токены вход/выход, латентность, стоимость
 *
 * Запуск:
 *   IAM_TOKEN=$(~/yandex-cloud/bin/yc iam create-token) \
 *   FOLDER_ID=<folder> \
 *   node scripts/experiments/llm-refine-bench/run.mjs
 */

import { CASES } from "./corpus.mjs";
import { scoreTranscript } from "../../benchmark/lib/wer.mjs";

const GPT_URL = "https://llm.api.cloud.yandex.net/foundationModels/v1/completion";
const IAM_TOKEN = process.env.IAM_TOKEN;
const FOLDER_ID = process.env.FOLDER_ID;
const RUNS_PER_CASE = Number(process.env.RUNS ?? 2);

// Цены Yandex Foundation Models, ₽ за 1000 токенов (синхронный режим).
// Источник: yandex.cloud/ru/docs/foundation-models/pricing — проверить при чтении отчёта.
const PRICING = {
  "yandexgpt-lite": 0.20,
  "yandexgpt": 1.20
};

const MODELS = [
  { name: "yandexgpt-lite", uri: `gpt://${FOLDER_ID}/yandexgpt-lite/latest` },
  { name: "yandexgpt", uri: `gpt://${FOLDER_ID}/yandexgpt/latest` }
];

if (!IAM_TOKEN || !FOLDER_ID) {
  console.error("Нужны env: IAM_TOKEN, FOLDER_ID");
  process.exit(1);
}

// ── Промпт (прототип promptTranscriptRefine из плана, этап 1.2) ──────────

function buildPrompt(caseItem) {
  const lines = caseItem.phrases
    .map((p, i) => `[${i + 1}] ${p.speaker}: ${p.asr}`)
    .join("\n");

  const system = `Ты — опытный редактор записей деловых переговоров в сфере "строительство".
Получаешь пронумерованные реплики транскрипта, полученного автоматическим распознаванием речи (ASR).
ASR часто искажает слова: разрывает их ("гидра изоляция" = "гидроизоляция"), пишет числа и аббревиатуры словами ("ка эс два" = "КС-2", "а пятьсот эс" = "А500С"), грубо путает термины ("зубное смещенное вырезание" = искажённый строительный термин).

ЗАДАЧА: исправить ошибки ASR в каждой реплике, восстановив смысл.

ПРАВИЛА:
1. Читай контекст всего разговора, а не отдельные слова.
2. Склеивай разорванные слова, восстанавливай искажённые термины. Профессиональный сленг раскрывай в полную форму ("исполниловка" → "исполнительная документация").
3. Марки, аббревиатуры и обозначения записывай в технической форме: "м триста пятьдесят" → "М350", "ка эс два" → "КС-2", "а пятьсот эс" → "А500С". Обычные числительные оставляй словами, как произнесены ("двести" остаётся "двести").
4. Расставь пунктуацию и заглавные буквы.
5. НЕ добавляй ничего, чего не было сказано. НЕ удаляй и НЕ сокращай сказанное — каждое слово исходной реплики должно сохраниться или быть исправлено, выбрасывать слова запрещено. НЕ перефразируй верный текст.
6. Если фрагмент — бессмыслица, не связанная с контекстом, попробуй восстановить термин из контекста; если невозможно — пометь [?...?].
7. Формат ответа — СТРОГО построчно, без пояснений, без JSON:
[номер] исправленный текст реплики
8. Сохрани все номера. Каждая входная реплика = ровно одна строка ответа с тем же номером. Префикс "Спикер N:" в ответ НЕ включай.`;

  const user = `Реплики:\n${lines}\n\nВерни исправленные реплики построчно в формате [номер] текст.`;

  return { system, user };
}

// ── Вызов API ────────────────────────────────────────────────────────────

async function complete(modelUri, system, user) {
  const startMs = Date.now();
  const res = await fetch(GPT_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${IAM_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      modelUri,
      completionOptions: { stream: false, temperature: 0.25, maxTokens: 4000 },
      messages: [
        { role: "system", text: system },
        { role: "user", text: user }
      ]
    })
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  return {
    text: data.result?.alternatives?.[0]?.message?.text ?? "",
    inputTokens: Number(data.result?.usage?.inputTextTokens ?? 0),
    outputTokens: Number(data.result?.usage?.completionTokens ?? 0),
    latencyMs: Date.now() - startMs
  };
}

// ── Парс ответа line-ID ─────────────────────────────────────────────────

function parseRefined(raw, expectedCount) {
  const map = new Map();
  for (const line of raw.split("\n")) {
    const m = line.trim().match(/^\[(\d+)\]\s*(.*)$/);
    if (m) {
      // Убираем "Спикер N:" если модель всё же его включила
      const text = m[2].replace(/^Спикер\s*\d+\s*:\s*/i, "").trim();
      map.set(Number(m[1]), text);
    }
  }
  const missing = [];
  for (let i = 1; i <= expectedCount; i++) {
    if (!map.has(i) || !map.get(i)) missing.push(i);
  }
  return { map, missing };
}

// ── Метрики ──────────────────────────────────────────────────────────────

function caseWer(phrases, getHypothesis) {
  const ref = phrases.map((p) => p.ref).join("\n");
  const hyp = phrases.map((p, i) => getHypothesis(p, i)).join("\n");
  return scoreTranscript(ref, hyp).wer;
}

// ── Основной цикл ────────────────────────────────────────────────────────

async function main() {
  const results = [];

  for (const model of MODELS) {
    for (const caseItem of CASES) {
      const { system, user } = buildPrompt(caseItem);
      const expectedCount = caseItem.phrases.length;
      const werBefore = caseWer(caseItem.phrases, (p) => p.asr);

      for (let run = 1; run <= RUNS_PER_CASE; run++) {
        process.stderr.write(`→ ${model.name} / ${caseItem.id} / run ${run}... `);
        try {
          const r = await complete(model.uri, system, user);
          const { map, missing } = parseRefined(r.text, expectedCount);

          // Для строк без ответа — fallback на ASR-текст (как в проде)
          const werAfter = caseWer(caseItem.phrases, (p, i) => map.get(i + 1) ?? p.asr);
          const compliance = (expectedCount - missing.length) / expectedCount;

          results.push({
            model: model.name, caseId: caseItem.id, run,
            werBefore, werAfter, compliance,
            missing: missing.length,
            inputTokens: r.inputTokens, outputTokens: r.outputTokens,
            latencyMs: r.latencyMs,
            costRub: ((r.inputTokens + r.outputTokens) / 1000) * PRICING[model.name],
            rawResponse: r.text
          });
          process.stderr.write(
            `WER ${(werBefore * 100).toFixed(1)}% → ${(werAfter * 100).toFixed(1)}%` +
            ` | compliance ${(compliance * 100).toFixed(0)}% | ${r.latencyMs}ms\n`
          );
        } catch (e) {
          process.stderr.write(`ОШИБКА: ${e.message}\n`);
          results.push({ model: model.name, caseId: caseItem.id, run, error: e.message });
        }
      }
    }
  }

  // ── Сводка ──────────────────────────────────────────────────────────────
  console.log("\n══════════ СВОДКА ══════════\n");
  for (const model of MODELS) {
    const ok = results.filter((r) => r.model === model.name && !r.error);
    const failed = results.filter((r) => r.model === model.name && r.error);
    if (ok.length === 0) { console.log(`${model.name}: все вызовы упали`); continue; }

    const avg = (sel) => ok.reduce((s, r) => s + sel(r), 0) / ok.length;
    const totalCost = ok.reduce((s, r) => s + r.costRub, 0);
    const totalTokens = ok.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0);

    console.log(`── ${model.name} ──`);
    console.log(`  прогонов ok/failed:   ${ok.length}/${failed.length}`);
    console.log(`  WER до коррекции:     ${(avg((r) => r.werBefore) * 100).toFixed(1)}%`);
    console.log(`  WER после коррекции:  ${(avg((r) => r.werAfter) * 100).toFixed(1)}%`);
    console.log(`  format compliance:    ${(avg((r) => r.compliance) * 100).toFixed(1)}%`);
    console.log(`  латентность (сред.):  ${Math.round(avg((r) => r.latencyMs))}ms`);
    console.log(`  токены всего:         ${totalTokens}`);
    console.log(`  стоимость прогона:    ${totalCost.toFixed(2)} ₽`);

    // По кейсам
    for (const c of CASES) {
      const caseRuns = ok.filter((r) => r.caseId === c.id);
      if (!caseRuns.length) continue;
      const wb = caseRuns[0].werBefore * 100;
      const wa = (caseRuns.reduce((s, r) => s + r.werAfter, 0) / caseRuns.length) * 100;
      console.log(`    ${c.id}: ${wb.toFixed(1)}% → ${wa.toFixed(1)}%`);
    }
    console.log("");
  }

  // Полные результаты в JSON для разбора
  const outPath = new URL("./results.json", import.meta.url).pathname;
  const { writeFileSync } = await import("node:fs");
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`Полные результаты: ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
