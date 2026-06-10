import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { createTestServer } from "../src/test-server.js";

test("server exposes the SPA shell and frontend entrypoint", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "yaspeech-ui-"));
  const server = await createTestServer({ dataDir });

  try {
    await server.start();

    const homeResponse = await fetch(`${server.baseUrl}/`);
    const homeHtml = await homeResponse.text();

    assert.equal(homeResponse.status, 200);
    assert.match(homeHtml, /YaSpeech/);
    assert.match(homeHtml, /app\/app\.js/);
    assert.match(homeHtml, /Unbounded/);
    assert.match(homeHtml, /Golos\+Text/);
    assert.doesNotMatch(homeHtml, /Fraunces/);
    assert.doesNotMatch(homeHtml, /IBM\+Plex\+Sans\+Condensed/);

    // Self-hosted библиотеки обязаны раздаваться локально — иначе белый экран
    const reactResponse = await fetch(`${server.baseUrl}/lib/react.production.min.js`);
    const htmResponse = await fetch(`${server.baseUrl}/lib/htm.umd.js`);
    assert.equal(reactResponse.status, 200);
    assert.equal(htmResponse.status, 200);

    const appResponse = await fetch(`${server.baseUrl}/app/app.js`);
    const appScript = await appResponse.text();
    const stylesResponse = await fetch(`${server.baseUrl}/app/styles.css`);
    const stylesCss = await stylesResponse.text();
    const bgResponse = await fetch(`${server.baseUrl}/app/real-estate-grid.svg`);
    const bgSvg = await bgResponse.text();

    assert.equal(appResponse.status, 200);
    assert.equal(stylesResponse.status, 200);
    assert.equal(bgResponse.status, 200);
    assert.match(appScript, /function App/);
    assert.match(appScript, /Выбрать файл/);
    assert.match(appScript, /Последние встречи/);
    assert.match(appScript, /Участники проекта/);
    assert.match(appScript, /Черновик встречи/);
    assert.match(appScript, /Собрать протокол/);
    assert.doesNotMatch(appScript, /Быстрый старт/);
    assert.doesNotMatch(appScript, /Контекст проекта/);
    assert.doesNotMatch(appScript, /SpeechSense-centered MVP/);
    assert.match(stylesCss, /--bg: #F6F7F9/i);
    assert.match(stylesCss, /--panel: #FFFFFF/i);
    assert.match(stylesCss, /--brand: #FF5A36/i);
    assert.match(stylesCss, /--accent: #6E8DFF/i);
    assert.match(stylesCss, /--accent-glow: rgba\(110, 141, 255, 0\.18\)/i);
    assert.doesNotMatch(stylesCss, /--bg: #f7f2e9/i);
    assert.doesNotMatch(stylesCss, /--brand: #b75234/i);
    assert.match(bgSvg, /stroke="#8CA7E0"/i);
    assert.match(bgSvg, /stroke-width="4"/i);
  } finally {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
