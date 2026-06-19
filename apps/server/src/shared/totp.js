/**
 * TOTP (RFC 6238) на встроенном Node crypto — без npm-зависимостей.
 * Совместимо с Google Authenticator, 1Password, Authy и т.п.
 *
 * Секрет хранится в base32 (RFC 4648). Код — 6 цифр, шаг 30 секунд,
 * алгоритм HMAC-SHA1 (дефолт всех аутентификаторов).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const DIGITS = 6;
const PERIOD_SECONDS = 30;

/** Случайный секрет (20 байт = 160 бит) в base32. */
export function generateTotpSecret() {
  return base32Encode(randomBytes(20));
}

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(input) {
  const clean = input.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const output = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error("Некорректный символ в base32-секрете.");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

/** HOTP для заданного счётчика (RFC 4226). */
function hotp(secretBuffer, counter) {
  const counterBuffer = Buffer.alloc(8);
  // 64-битный счётчик big-endian; верхние 32 бита практически всегда 0
  counterBuffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  counterBuffer.writeUInt32BE(counter >>> 0, 4);

  const hmac = createHmac("sha1", secretBuffer).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

/** Текущий код для секрета (для тестов и отладки). */
export function totpNow(base32Secret, now = Date.now()) {
  const counter = Math.floor(now / 1000 / PERIOD_SECONDS);
  return hotp(base32Decode(base32Secret), counter);
}

/**
 * Проверяет код с допуском ±window шагов (по умолчанию ±1 = ±30с)
 * на рассинхрон часов. Сравнение — постоянного времени.
 */
export function verifyTotp(base32Secret, code, { window = 1, now = Date.now() } = {}) {
  const normalized = String(code ?? "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(normalized)) return false;

  const secretBuffer = base32Decode(base32Secret);
  const counter = Math.floor(now / 1000 / PERIOD_SECONDS);
  const candidate = Buffer.from(normalized);

  for (let i = -window; i <= window; i++) {
    const expected = Buffer.from(hotp(secretBuffer, counter + i));
    if (expected.length === candidate.length && timingSafeEqual(expected, candidate)) {
      return true;
    }
  }
  return false;
}

/** otpauth://-ссылка для QR в приложении-аутентификаторе. */
export function otpauthUri(base32Secret, { account, issuer = "YaSpeech" }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: base32Secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS)
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Набор одноразовых кодов восстановления вида "abcde-fghij". */
export function generateBackupCodes(count = 10) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const raw = base32Encode(randomBytes(7)).toLowerCase().slice(0, 10);
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}
