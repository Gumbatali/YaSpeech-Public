/**
 * Cookie-сессии на HMAC-SHA256. Никаких npm-зависимостей.
 *
 * Формат токена: "<userId>|<expiresMs>|<hmacHex>"
 * Разделитель | выбран чтобы userId (UUID) не конфликтовал с точками.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 дней

function sign(userId, expiresAt, secret) {
  return createHmac("sha256", secret)
    .update(`${userId}|${expiresAt}`)
    .digest("hex");
}

export function createSessionToken(userId, secret) {
  const expiresAt = Date.now() + SESSION_DURATION_MS;
  const mac = sign(userId, expiresAt, secret);
  return `${userId}|${expiresAt}|${mac}`;
}

export function verifySessionToken(token, secret) {
  if (!token || !secret) return null;

  const parts = token.split("|");
  if (parts.length !== 3) return null;

  const [userId, expiresAtStr, mac] = parts;
  const expiresAt = Number(expiresAtStr);

  if (!userId || !expiresAt || !mac) return null;
  if (Date.now() > expiresAt) return null;

  const expected = sign(userId, expiresAt, secret);
  const expectedBuf = Buffer.from(expected, "hex");
  const macBuf = Buffer.from(mac.padEnd(expected.length, "0"), "hex");

  try {
    if (expectedBuf.length !== macBuf.length) return null;
    if (!timingSafeEqual(expectedBuf, macBuf)) return null;
  } catch {
    return null;
  }

  return userId;
}

export function parseCookies(cookieHeader) {
  if (!cookieHeader) return {};
  return Object.fromEntries(
    cookieHeader.split(";").map((c) => {
      const [k, ...v] = c.trim().split("=");
      return [k.trim(), decodeURIComponent(v.join("=").trim())];
    })
  );
}

export function setSessionCookie(response, token) {
  const maxAge = Math.floor(SESSION_DURATION_MS / 1000);
  response.setHeader(
    "set-cookie",
    `session=${token}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}; Path=/`
  );
}

export function clearSessionCookie(response) {
  response.setHeader(
    "set-cookie",
    "session=; HttpOnly; SameSite=Strict; Max-Age=0; Path=/"
  );
}
