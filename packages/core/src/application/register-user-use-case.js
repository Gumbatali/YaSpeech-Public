import { createUser, hasTotp, consumeBackupCodeHash } from "../domain/user.js";

/** Ошибка логина с машиночитаемым кодом для маршрута. */
export class LoginError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "LoginError";
    this.code = code; // "INVALID_CREDENTIALS" | "BANNED" | "TOTP_REQUIRED" | "TOTP_INVALID"
  }
}

export class RegisterUserUseCase {
  constructor(userRepository, passwordHasher, clock, idGenerator, adminLogin) {
    this.userRepository = userRepository;
    this.passwordHasher = passwordHasher;
    this.clock          = clock;
    this.idGenerator    = idGenerator;
    this.adminLogin     = adminLogin ?? null;
  }

  async execute({ login, password }) {
    const normalizedLogin = login.toLowerCase().trim();

    if (!normalizedLogin || normalizedLogin.length < 3) {
      throw new Error("Логин должен быть не менее 3 символов.");
    }
    if (!password || password.length < 6) {
      throw new Error("Пароль должен быть не менее 6 символов.");
    }

    const existing = await this.userRepository.findByLogin(normalizedLogin);
    if (existing) {
      throw new Error("Пользователь с таким логином уже зарегистрирован.");
    }

    // Админ создаётся только через seed-admin.js. Публичная регистрация не
    // должна уметь выдать роль admin — иначе пропуск/сбой seed-скрипта
    // означает, что первый зарегистрировавшийся с этим логином станет админом.
    if (this.adminLogin && normalizedLogin === this.adminLogin.toLowerCase().trim()) {
      throw new Error("Этот логин зарезервирован.");
    }

    const passwordHash = await this.passwordHasher.hash(password);

    const user = createUser({
      id: this.idGenerator.next(),
      login: normalizedLogin,
      passwordHash,
      role: "member",
      createdAt: this.clock.now().toISOString()
    });

    await this.userRepository.save(user);
    return publicUser(user);
  }
}

export class LoginUserUseCase {
  /**
   * @param totpVerifier  { verify(secret, code): boolean } — проверка TOTP-кода
   * @param backupVerifier { verify(code, hash): Promise<boolean> } — проверка кода восстановления
   * @param clock         нужен для save при гашении одноразового кода
   */
  constructor(userRepository, passwordVerifier, totpVerifier = null, backupVerifier = null, clock = null) {
    this.userRepository   = userRepository;
    this.passwordVerifier = passwordVerifier;
    this.totpVerifier     = totpVerifier;
    this.backupVerifier   = backupVerifier;
    this.clock            = clock;
  }

  async execute({ login, password, totpCode }) {
    const normalizedLogin = login.toLowerCase().trim();
    const user = await this.userRepository.findByLogin(normalizedLogin);

    // Одинаковое сообщение — не раскрываем, есть ли такой логин
    if (!user) {
      throw new LoginError("Неверный логин или пароль.", "INVALID_CREDENTIALS");
    }

    const valid = await this.passwordVerifier.verify(password, user.passwordHash);
    if (!valid) {
      throw new LoginError("Неверный логин или пароль.", "INVALID_CREDENTIALS");
    }

    if (user.status === "banned") {
      throw new LoginError("Ваш аккаунт заблокирован. Обратитесь к администратору.", "BANNED");
    }

    // Второй фактор — только для аккаунтов с включённой 2FA (обычно админ)
    if (hasTotp(user)) {
      const verifiedUser = await this.verifySecondFactor(user, totpCode);
      return publicUser(verifiedUser);
    }

    return publicUser(user);
  }

  /** Проверяет TOTP-код или одноразовый код восстановления. */
  async verifySecondFactor(user, totpCode) {
    const code = String(totpCode ?? "").trim();
    if (!code) {
      throw new LoginError("Введите код из приложения-аутентификатора.", "TOTP_REQUIRED");
    }

    // 6 цифр → обычный TOTP-код
    if (/^\d{6}$/.test(code) && this.totpVerifier?.verify(user.totp.secret, code)) {
      return user;
    }

    // Иначе пробуем коды восстановления (одноразовые)
    const consumed = await this.tryConsumeBackupCode(user, code);
    if (consumed) return consumed;

    throw new LoginError("Неверный код двухфакторной аутентификации.", "TOTP_INVALID");
  }

  /** Сверяет код с хэшами backup-кодов; при совпадении гасит код и сохраняет. */
  async tryConsumeBackupCode(user, code) {
    if (!this.backupVerifier) return null;
    for (const hash of user.totp?.backupCodes ?? []) {
      if (await this.backupVerifier.verify(code, hash)) {
        const updated = consumeBackupCodeHash(user, hash, this.clock?.now().toISOString());
        await this.userRepository.save(updated);
        return updated;
      }
    }
    return null;
  }
}

export function publicUser(user) {
  // Никогда не отдаём клиенту хэш пароля и TOTP-секрет/коды восстановления
  const { passwordHash: _ph, totp: _totp, ...safe } = user;
  return { ...safe, totpEnabled: Boolean(user.totp?.enabled) };
}
