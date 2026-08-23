/**
 * Получает IAM-токен для текущего сервисного аккаунта Cloud Function.
 * Кешируется в памяти инстанса, обновляется за 60 сек до истечения.
 */

let _cachedToken = null;
let _expiresAt = 0;

export async function getIamToken() {
  // Локальная разработка: метадата Cloud Function (169.254.169.254)
  // недоступна вне облака. IAM_TOKEN_OVERRIDE — не для прода (там всегда
  // не задана), позволяет прогнать реальный шлюз локально с токеном от
  // `yc iam create-token`, не трогая обычный путь через метадату.
  if (process.env.IAM_TOKEN_OVERRIDE) {
    return process.env.IAM_TOKEN_OVERRIDE;
  }

  if (_cachedToken && Date.now() < _expiresAt - 60_000) {
    return _cachedToken;
  }

  const res = await fetch(
    "http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } }
  );

  if (!res.ok) {
    throw new Error(`IAM metadata failed: ${res.status}`);
  }

  const data = await res.json();
  _cachedToken = data.access_token;
  _expiresAt = Date.now() + data.expires_in * 1000;
  return _cachedToken;
}

export function invalidateIamToken() {
  _cachedToken = null;
  _expiresAt = 0;
}
