/**
 * Точка входа Cloud Function для API.
 * Конвертирует YC HTTP-событие → Node.js-like request → YC HTTP-ответ.
 */
import { createHttpHandler } from "../server/create-http-handler.js";
import { makeDeps } from "./make-deps.js";

let handler;

function getHandler() {
  if (!handler) {
    const deps = makeDeps();
    // webRootDirectory не нужен — фронт живёт в Object Storage
    handler = createHttpHandler({ ...deps, webRootDirectory: null });
  }
  return handler;
}

export async function index(event) {
  // Таймер-прогрев: YC Timer trigger присылает событие без httpMethod
  if (!event.httpMethod) {
    getHandler(); // просто инициализируем зависимости, чтобы инстанс прогрелся
    return { statusCode: 200, body: "warmed" };
  }

  const h = getHandler();

  // Эмулируем Node.js IncomingMessage из YC-события
  const bodyStr = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf-8")
    : (event.body ?? "");

  const fakeReq = {
    method: event.httpMethod,
    url: event.url + (event.queryStringParameters
      ? "?" + new URLSearchParams(event.queryStringParameters).toString()
      : ""),
    headers: Object.fromEntries(
      Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])
    ),
    body: bodyStr,
    // Имитируем поток: readable для readJsonRequestBody
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(bodyStr); },
  };

  const chunks = [];
  const resHeaders = {};
  let statusCode = 200;

  const fakeRes = {
    setHeader: (name, value) => { resHeaders[name.toLowerCase()] = value; },
    writeHead: (code) => { statusCode = code; },
    end: (data) => { if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data)); },
    write: (data) => { chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data)); },
  };

  await h(fakeReq, fakeRes);

  const responseBody = Buffer.concat(chunks).toString("utf-8");

  return {
    statusCode,
    headers: resHeaders,
    body: responseBody,
    isBase64Encoded: false,
  };
}
