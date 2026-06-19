/**
 * Доменная сущность User — чистые иммутабельные функции.
 *
 * Роли: "admin" | "member"
 * Статусы: "active" | "banned"
 *
 * Правила:
 * - login — любая строка (почта, никнейм и т.п.), регистронезависимый
 * - Роль admin: сколько угодно, но нельзя остаться без единого админа
 * - Нельзя забанить самого себя и другого админа
 * - Первый пользователь с ADMIN_LOGIN получает role: "admin" автоматически
 */

export function createUser({ id, login, passwordHash, role = "member", createdAt }) {
  return {
    id,
    login: login.toLowerCase().trim(),
    passwordHash,
    role,
    status: "active",
    // Квота расшифровок: null = безлимит, число = максимум за всё время
    transcriptionQuota: null,
    transcriptionUsed: 0,
    // Двухфакторная аутентификация (TOTP). По умолчанию выключена.
    // { enabled, secret (base32), backupCodes: [hash] } — секрет и хэши
    // НИКОГДА не уходят клиенту (см. publicUser).
    totp: { enabled: false },
    createdAt,
    updatedAt: createdAt
  };
}

/** Признак включённой 2FA — безопасен к отсутствию поля у старых записей. */
export function hasTotp(user) {
  return Boolean(user.totp?.enabled);
}

/** Включает 2FA: сохраняет секрет и хэши одноразовых кодов восстановления. */
export function enableTotp(user, { secret, backupCodeHashes }, updatedAt) {
  if (!secret) throw new Error("Не задан TOTP-секрет.");
  return {
    ...user,
    totp: { enabled: true, secret, backupCodes: backupCodeHashes ?? [] },
    updatedAt
  };
}

/** Полностью отключает 2FA и забывает секрет/коды. */
export function disableTotp(user, updatedAt) {
  return { ...user, totp: { enabled: false }, updatedAt };
}

/** Убирает использованный код восстановления (по его хэшу) — одноразовость. */
export function consumeBackupCodeHash(user, usedHash, updatedAt) {
  const remaining = (user.totp?.backupCodes ?? []).filter((h) => h !== usedHash);
  return { ...user, totp: { ...user.totp, backupCodes: remaining }, updatedAt };
}

/**
 * Проверяет, может ли пользователь запустить ещё одну расшифровку.
 * Возвращает { allowed: true } или { allowed: false, reason: string }.
 */
export function checkTranscriptionQuota(user) {
  if (user.transcriptionQuota === null || user.transcriptionQuota === undefined) {
    return { allowed: true };
  }
  if (user.transcriptionUsed >= user.transcriptionQuota) {
    return {
      allowed: false,
      reason: `Исчерпан лимит расшифровок (${user.transcriptionUsed}/${user.transcriptionQuota}). Обратитесь к администратору.`
    };
  }
  return { allowed: true };
}

/** Увеличивает счётчик использованных расшифровок на 1. */
export function incrementTranscriptionUsed(user, updatedAt) {
  return { ...user, transcriptionUsed: (user.transcriptionUsed ?? 0) + 1, updatedAt };
}

/** Устанавливает квоту. quota = null — безлимит, quota = N — лимит. */
export function setTranscriptionQuota(user, quota, updatedAt) {
  if (quota !== null && (!Number.isInteger(quota) || quota < 0)) {
    throw new Error("Квота должна быть целым неотрицательным числом или null.");
  }
  return { ...user, transcriptionQuota: quota, updatedAt };
}

/** Сбрасывает счётчик использованных расшифровок в 0. */
export function resetTranscriptionUsed(user, updatedAt) {
  return { ...user, transcriptionUsed: 0, updatedAt };
}

export function banUser(user, updatedAt) {
  if (user.role === "admin") {
    throw new Error("Нельзя заблокировать администратора.");
  }
  return { ...user, status: "banned", updatedAt };
}

export function unbanUser(user, updatedAt) {
  return { ...user, status: "active", updatedAt };
}

export function setRole(user, role, updatedAt) {
  if (!["admin", "member"].includes(role)) {
    throw new Error(`Недопустимая роль: ${role}`);
  }
  return { ...user, role, updatedAt };
}
