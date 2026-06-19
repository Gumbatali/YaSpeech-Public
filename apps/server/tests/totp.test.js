/**
 * Юнит-тесты TOTP. Контрольные значения — из RFC 6238 (Appendix B),
 * секрет ASCII "12345678901234567890", SHA1. RFC даёт 8 цифр, мы берём
 * младшие 6 — поэтому сравниваем с последними 6 цифрами эталона.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  base32Encode,
  base32Decode,
  totpNow,
  verifyTotp,
  generateTotpSecret,
  generateBackupCodes,
  otpauthUri
} from "../src/shared/totp.js";

// "12345678901234567890" в base32
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890", "ascii"));

test("base32 RFC-секрет совпадает с эталоном", () => {
  assert.equal(RFC_SECRET, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
});

test("base32 кодирование/декодирование — обратимо", () => {
  const original = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  assert.deepEqual(base32Decode(base32Encode(original)), original);
});

test("TOTP совпадает с контрольными значениями RFC 6238 (младшие 6 цифр)", () => {
  const vectors = [
    { time: 59, expected8: "94287082" },
    { time: 1111111109, expected8: "07081804" },
    { time: 1111111111, expected8: "14050471" },
    { time: 1234567890, expected8: "89005924" },
    { time: 2000000000, expected8: "69279037" }
  ];
  for (const { time, expected8 } of vectors) {
    const code = totpNow(RFC_SECRET, time * 1000);
    assert.equal(code, expected8.slice(-6), `время T=${time}`);
  }
});

test("verifyTotp принимает свежесгенерированный код", () => {
  const secret = generateTotpSecret();
  const now = Date.now();
  assert.equal(verifyTotp(secret, totpNow(secret, now), { now }), true);
});

test("verifyTotp учитывает рассинхрон часов в пределах окна", () => {
  const secret = generateTotpSecret();
  const now = Date.now();
  const codeFromPast = totpNow(secret, now - 30_000); // на шаг назад
  assert.equal(verifyTotp(secret, codeFromPast, { now, window: 1 }), true);
});

test("verifyTotp отклоняет код за пределами окна", () => {
  const secret = generateTotpSecret();
  const now = Date.now();
  const oldCode = totpNow(secret, now - 5 * 60_000); // 5 минут назад
  assert.equal(verifyTotp(secret, oldCode, { now, window: 1 }), false);
});

test("verifyTotp отклоняет мусор и неполные коды", () => {
  const secret = generateTotpSecret();
  for (const bad of ["", "123", "abcdef", "1234567", null, undefined]) {
    assert.equal(verifyTotp(secret, bad), false, `код: ${bad}`);
  }
});

test("backup-коды уникальны и в нужном формате", () => {
  const codes = generateBackupCodes(10);
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const c of codes) assert.match(c, /^[a-z2-7]{5}-[a-z2-7]{5}$/);
});

test("otpauthUri содержит секрет и issuer", () => {
  const uri = otpauthUri("ABCDEF", { account: "admin_stroytech", issuer: "YaSpeech" });
  assert.match(uri, /^otpauth:\/\/totp\//);
  assert.match(uri, /secret=ABCDEF/);
  assert.match(uri, /issuer=YaSpeech/);
});
