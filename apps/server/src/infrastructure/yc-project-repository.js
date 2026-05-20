export class YcProjectRepository {
  constructor(storage) {
    this.storage = storage;
  }

  async list() {
    const index = await this.storage.readJson("projects/index.json");
    return index ?? [];
  }

  async getById(projectId) {
    return this.storage.readJson(`projects/${projectId}/project.json`);
  }

  async save(project) {
    await this.storage.writeJson(`projects/${project.id}/project.json`, project);

    const all = await this.list();
    const next = all.filter((p) => p.id !== project.id);
    next.unshift({ id: project.id, name: project.name, createdAt: project.createdAt });
    await this.storage.writeJson("projects/index.json", next);
  }
}
