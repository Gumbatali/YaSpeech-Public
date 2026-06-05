import { createUser } from "../domain/user.js";

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

    const passwordHash = await this.passwordHasher.hash(password);
    const role = this.adminLogin &&
      normalizedLogin === this.adminLogin.toLowerCase().trim()
      ? "admin"
      : "member";

    const user = createUser({
      id: this.idGenerator.next(),
      login: normalizedLogin,
      passwordHash,
      role,
      createdAt: this.clock.now().toISOString()
    });

    await this.userRepository.save(user);
    return publicUser(user);
  }
}

export class LoginUserUseCase {
  constructor(userRepository, passwordVerifier) {
    this.userRepository   = userRepository;
    this.passwordVerifier = passwordVerifier;
  }

  async execute({ login, password }) {
    const normalizedLogin = login.toLowerCase().trim();
    const user = await this.userRepository.findByLogin(normalizedLogin);

    // Одинаковое сообщение — не раскрываем, есть ли такой логин
    if (!user) {
      throw new Error("Неверный логин или пароль.");
    }

    const valid = await this.passwordVerifier.verify(password, user.passwordHash);
    if (!valid) {
      throw new Error("Неверный логин или пароль.");
    }

    if (user.status === "banned") {
      throw new Error("Ваш аккаунт заблокирован. Обратитесь к администратору.");
    }

    return publicUser(user);
  }
}

export function publicUser(user) {
  const { passwordHash: _, ...safe } = user;
  return safe;
}
