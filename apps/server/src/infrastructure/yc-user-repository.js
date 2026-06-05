/**
 * Хранит пользователей в S3 как users/index.json.
 * Тот же паттерн, что и yc-project-repository.js.
 */
export class YcUserRepository {
  constructor(storage) {
    this.storage = storage;
  }

  async list() {
    const data = await this.storage.readJson("users/index.json");
    return data ?? [];
  }

  async findByLogin(login) {
    const users = await this.list();
    return users.find((u) => u.login === login.toLowerCase().trim()) ?? null;
  }

  async findById(id) {
    const users = await this.list();
    return users.find((u) => u.id === id) ?? null;
  }

  async save(user) {
    const users = await this.list();
    const idx = users.findIndex((u) => u.id === user.id);
    const updated = idx >= 0
      ? users.map((u) => (u.id === user.id ? user : u))
      : [...users, user];
    await this.storage.writeJson("users/index.json", updated);
  }

  async countByRole(role) {
    const users = await this.list();
    return users.filter((u) => u.role === role).length;
  }
}
