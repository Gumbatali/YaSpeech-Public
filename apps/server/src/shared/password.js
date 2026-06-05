/**
 * Хэширование паролей через Node.js crypto.scrypt.
 * Никаких npm-зависимостей.
 *
 * Формат хранения: "<saltHex>:<hashHex>"
 */
import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const KEY_LEN = 64;

export async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = await scryptAsync(password, salt, KEY_LEN);
  return `${salt}:${hash.toString("hex")}`;
}

export async function verifyPassword(password, stored) {
  const [salt, hashHex] = stored.split(":");
  if (!salt || !hashHex) return false;

  const hash = await scryptAsync(password, salt, KEY_LEN);
  const storedBuf = Buffer.from(hashHex, "hex");

  if (hash.length !== storedBuf.length) return false;
  return timingSafeEqual(hash, storedBuf);
}
