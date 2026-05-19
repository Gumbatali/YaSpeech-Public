/**
 * AWS Signature Version 4 — чистый Node.js, без зависимостей.
 * Используется для Yandex Object Storage (S3-совместимый) и YMQ (SQS-совместимый).
 */
import { createHmac, createHash } from "node:crypto";

function sha256hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key, data) {
  return createHmac("sha256", key).update(data).digest();
}

function deriveSigningKey(secret, dateStamp, region, service) {
  const kDate    = hmacSha256(Buffer.from("AWS4" + secret, "utf-8"), dateStamp);
  const kRegion  = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}

/**
 * Строит Authorization-заголовок для одного HTTP-запроса.
 *
 * @param {{
 *   method: string,
 *   host: string,
 *   path: string,
 *   query: Record<string,string>,
 *   headers: Record<string,string>,
 *   body: string | Buffer,
 *   service: string,
 *   region: string,
 *   keyId: string,
 *   secret: string,
 *   now?: Date,
 * }} opts
 * @returns {{ Authorization: string, "x-amz-date": string, "x-amz-content-sha256": string }}
 */
export function signRequest({ method, host, path, query = {}, headers = {}, body = "",
                              service, region, keyId, secret, now }) {
  const date = now ?? new Date();
  const amzDate  = date.toISOString().replace(/[:-]|\.\d{3}/g, "").slice(0, 15) + "Z";
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = sha256hex(body);

  const allHeaders = {
    ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
    host,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
  };

  const sortedHeaderKeys = Object.keys(allHeaders).sort();
  const canonicalHeaders = sortedHeaderKeys.map(k => `${k}:${allHeaders[k]}`).join("\n") + "\n";
  const signedHeaders    = sortedHeaderKeys.join(";");

  const canonicalQuery = Object.entries(query)
    .sort(([a], [b]) => a < b ? -1 : 1)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  const canonicalRequest = [
    method.toUpperCase(),
    path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256hex(canonicalRequest),
  ].join("\n");

  const signingKey = deriveSigningKey(secret, dateStamp, region, service);
  const signature  = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  return {
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
    Authorization:
      `AWS4-HMAC-SHA256 Credential=${keyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/**
 * Генерирует presigned URL (GET или PUT) без отправки запроса.
 */
export function presignUrl({ method, host, path, query = {}, service, region,
                             keyId, secret, expiresIn = 3600, now }) {
  const date = now ?? new Date();
  const amzDate   = date.toISOString().replace(/[:-]|\.\d{3}/g, "").slice(0, 15) + "Z";
  const dateStamp = amzDate.slice(0, 8);

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;

  const presignQuery = {
    ...query,
    "X-Amz-Algorithm":  "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${keyId}/${credentialScope}`,
    "X-Amz-Date":       amzDate,
    "X-Amz-Expires":    String(expiresIn),
    "X-Amz-SignedHeaders": "host",
  };

  const canonicalQuery = Object.entries(presignQuery)
    .sort(([a], [b]) => a < b ? -1 : 1)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  const canonicalRequest = [
    method.toUpperCase(),
    path,
    canonicalQuery,
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256hex(canonicalRequest),
  ].join("\n");

  const signingKey = deriveSigningKey(secret, dateStamp, region, service);
  const signature  = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  return `https://${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
