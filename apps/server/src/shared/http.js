export async function readJsonRequestBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

export function sendText(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

export function sendNoContent(response, statusCode = 204) {
  response.writeHead(statusCode);
  response.end();
}

export function notFound(response) {
  sendJson(response, 404, {
    error: {
      code: "NOT_FOUND",
      message: "Requested resource was not found."
    }
  });
}

export function badRequest(response, message) {
  sendJson(response, 400, {
    error: {
      code: "BAD_REQUEST",
      message
    }
  });
}

export function serverError(response, error) {
  sendJson(response, 500, {
    error: {
      code: error.code ?? "INTERNAL_ERROR",
      message: error.message ?? "Internal server error."
    }
  });
}
