import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import {
  HttpDiarization,
  normalizeSegments,
} from "../src/infrastructure/diarization/http-diarization.js";
import { makeDiarizer } from "../src/infrastructure/diarization/make-diarizer.js";

/** Хранилище-заглушка: отдаёт фиксированный буфер как поток. */
const fakeStorage = {
  async readStream() {
    return (async function* () {
      yield Buffer.from("fake audio bytes");
    })();
  },
};

/** Поднимает сервис-заглушку на случайном порту. */
async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(url);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

test("normalizeSegments enforces contract invariants", () => {
  const result = normalizeSegments([
    { speaker: "B", start: 5, stop: 8 },
    { speaker: "A", start: 0, stop: 3 },
    { speaker: "C", start: 2, stop: 2 }, // нулевая длина
    { speaker: "D", start: 9, stop: 4 }, // stop < start
    { speaker: "E", start: "bad", stop: 5 },
  ]);

  assert.equal(result.length, 2);
  assert.equal(result[0].speaker, "A", "должно быть отсортировано по времени");
  assert.equal(result[1].speaker, "B");
});

test("normalizeSegments keeps overlapping segments", () => {
  // Перекрытия — валидные данные (одновременная речь), а не ошибка.
  const result = normalizeSegments([
    { speaker: "A", start: 0, stop: 10 },
    { speaker: "B", start: 5, stop: 15 },
  ]);

  assert.equal(result.length, 2);
});

test("normalizeSegments accepts `end` as an alias for `stop`", () => {
  const result = normalizeSegments([{ speaker: "A", start: 0, end: 4 }]);
  assert.equal(result[0].stop, 4);
});

test("diarize returns segments from a healthy service", async () => {
  await withServer(
    (req, res) =>
      json(res, 200, {
        backend: "test",
        segments: [
          { speaker: "SPEAKER_01", start: 3, stop: 6 },
          { speaker: "SPEAKER_00", start: 0, stop: 2 },
        ],
        num_speakers_detected: 2,
      }),
    async (url) => {
      const diarizer = new HttpDiarization({
        baseUrl: url,
        backend: "test",
        artifactStorage: fakeStorage,
      });

      const segments = await diarizer.diarize("audio/meeting.wav");
      assert.equal(segments.length, 2);
      assert.equal(segments[0].start, 0, "нормализация должна отсортировать");
    }
  );
});

test("diarize returns null on service error instead of throwing", async () => {
  // Ключевое свойство: сломанная диаризация не должна ронять весь пайплайн.
  await withServer(
    (req, res) => json(res, 500, { error: "CUDA out of memory" }),
    async (url) => {
      const diarizer = new HttpDiarization({
        baseUrl: url,
        backend: "test",
        artifactStorage: fakeStorage,
        retries: 0,
      });

      const result = await diarizer.diarize("audio/meeting.wav");
      assert.equal(result, null);
    }
  );
});

test("diarize retries transient 503 and then succeeds", async () => {
  let calls = 0;

  await withServer(
    (req, res) => {
      calls++;
      if (calls === 1) return json(res, 503, { error: "model is still loading" });
      return json(res, 200, { segments: [{ speaker: "SPEAKER_00", start: 0, stop: 5 }] });
    },
    async (url) => {
      const diarizer = new HttpDiarization({
        baseUrl: url,
        backend: "test",
        artifactStorage: fakeStorage,
        retries: 2,
        retryDelayMs: 5, // в тесте ждать реальные секунды незачем
      });

      const segments = await diarizer.diarize("audio/meeting.wav");
      assert.equal(calls, 2, "должен был повторить запрос");
      assert.equal(segments.length, 1);
    }
  );
});

test("diarize is disabled without a base URL", async () => {
  const diarizer = new HttpDiarization({ baseUrl: null, artifactStorage: fakeStorage });

  assert.equal(diarizer.available, false);
  assert.equal(await diarizer.diarize("audio/x.wav"), null);
});

test("diarize returns null when storage read fails", async () => {
  const brokenStorage = {
    async readStream() {
      throw new Error("S3 unavailable");
    },
  };

  await withServer(
    (req, res) => json(res, 200, { segments: [] }),
    async (url) => {
      const diarizer = new HttpDiarization({
        baseUrl: url,
        artifactStorage: brokenStorage,
      });
      assert.equal(await diarizer.diarize("audio/x.wav"), null);
    }
  );
});

test("health reports service state", async () => {
  await withServer(
    (req, res) => json(res, 200, { status: "ok", backend: "test", model_loaded: true }),
    async (url) => {
      const diarizer = new HttpDiarization({ baseUrl: url, artifactStorage: fakeStorage });
      const health = await diarizer.health();
      assert.equal(health.status, "ok");
    }
  );
});

test("health reports unreachable services without throwing", async () => {
  const diarizer = new HttpDiarization({
    // Порт, на котором заведомо никто не слушает.
    baseUrl: "http://127.0.0.1:1",
    artifactStorage: fakeStorage,
  });

  const health = await diarizer.health();
  assert.equal(health.status, "unreachable");
});

test("speaker hints are forwarded for flexible backends", async () => {
  let received = "";

  await withServer(
    (req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        received = Buffer.concat(chunks).toString();
        json(res, 200, { segments: [] });
      });
    },
    async (url) => {
      const diarizer = new HttpDiarization({
        baseUrl: url,
        artifactStorage: fakeStorage,
        minSpeakers: 2,
        maxSpeakers: 8,
      });

      await diarizer.diarize("audio/x.wav");
      assert.match(received, /min_speakers/);
      assert.match(received, /max_speakers/);
    }
  );
});

// ── Фабрика ────────────────────────────────────────────────────────────────

test("makeDiarizer returns a disabled diarizer for DIARIZER=none", async () => {
  const diarizer = makeDiarizer({ env: { DIARIZER: "none" }, artifactStorage: fakeStorage });

  assert.equal(diarizer.available, false);
  assert.equal(await diarizer.diarize("x"), null);
});

test("makeDiarizer defaults to none when DIARIZER is unset", () => {
  const diarizer = makeDiarizer({ env: {}, artifactStorage: fakeStorage });
  assert.equal(diarizer.backend, "none");
});

test("makeDiarizer degrades safely on an unknown backend name", () => {
  const diarizer = makeDiarizer({
    env: { DIARIZER: "not-a-real-backend", DIARIZER_URL: "http://x" },
    artifactStorage: fakeStorage,
  });

  assert.equal(diarizer.backend, "none");
  assert.equal(diarizer.available, false);
});

test("makeDiarizer disables HTTP backends when URL is missing", () => {
  const diarizer = makeDiarizer({
    env: { DIARIZER: "nemo-sortformer" },
    artifactStorage: fakeStorage,
  });

  assert.equal(diarizer.available, false);
});

test("makeDiarizer disables pyannote-hf without a token", () => {
  const diarizer = makeDiarizer({
    env: { DIARIZER: "pyannote-hf" },
    artifactStorage: fakeStorage,
  });

  assert.equal(diarizer.available, false);
});

test("makeDiarizer omits speaker hints for fixed-slot backends", () => {
  // Sortformer всегда имеет 4 слота — подсказки бессмысленны и не должны
  // просачиваться в запрос, создавая иллюзию управляемости.
  const diarizer = makeDiarizer({
    env: {
      DIARIZER: "nemo-sortformer",
      DIARIZER_URL: "http://x:8000",
      DIARIZER_MAX_SPEAKERS: "8",
    },
    artifactStorage: fakeStorage,
  });

  assert.equal(diarizer.maxSpeakers, null);
});

test("makeDiarizer passes speaker hints to flexible backends", () => {
  const diarizer = makeDiarizer({
    env: {
      DIARIZER: "pyannote-selfhosted",
      DIARIZER_URL: "http://x:8000",
      DIARIZER_MAX_SPEAKERS: "8",
    },
    artifactStorage: fakeStorage,
  });

  assert.equal(diarizer.maxSpeakers, 8);
});
