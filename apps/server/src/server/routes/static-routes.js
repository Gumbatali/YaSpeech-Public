/**
 * Раздача SPA: GET / (index.html) и GET /app/* (ассеты).
 * Используется локальным dev-сервером и Cloud Function как фолбэк;
 * в проде статику отдаёт API Gateway напрямую из Object Storage.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { notFound } from "../../shared/http.js";

function getContentType(filePath) {
  const extension = path.extname(filePath);

  if (extension === ".js") {
    return "application/javascript; charset=utf-8";
  }
  if (extension === ".css") {
    return "text/css; charset=utf-8";
  }
  if (extension === ".html") {
    return "text/html; charset=utf-8";
  }
  if (extension === ".svg") {
    return "image/svg+xml; charset=utf-8";
  }
  return "application/octet-stream";
}

/**
 * Возвращает true, если запрос обработан (статика), false — если
 * нужно продолжать диспатч по API-роутам.
 */
export async function serveStatic({ request, response, url, webRootDirectory }) {
  if (request.method !== "GET") return false;

  if (url.pathname === "/") {
    if (!webRootDirectory) { notFound(response); return true; }
    const html = await readFile(path.join(webRootDirectory, "index.html"), "utf8");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
    return true;
  }

  // /app/* — код приложения, /lib/* — self-hosted React/htm
  for (const prefix of ["app", "lib"]) {
    if (!url.pathname.startsWith(`/${prefix}/`)) continue;
    if (!webRootDirectory) { notFound(response); return true; }

    const assetPath = path.resolve(webRootDirectory, `.${url.pathname}`);
    const assetDirectory = path.resolve(webRootDirectory, prefix);

    // Защита от path traversal: файл обязан остаться внутри своей директории
    if (!assetPath.startsWith(assetDirectory)) {
      notFound(response);
      return true;
    }

    const content = await readFile(assetPath, "utf8");
    response.writeHead(200, { "content-type": getContentType(assetPath) });
    response.end(content);
    return true;
  }

  return false;
}
