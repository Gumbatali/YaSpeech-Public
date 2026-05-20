export class YcProjectRepository {
  constructor(storage) {
    this.storage = storage;
  }

  async list() {
    const index = await this.storage.readJson("projects/index.json");
    return index ?? [];
  }

  async getById(projectId) {
    const project = await this.storage.readJson(`projects/${projectId}/project.json`);
    if (!project) return null;
    // Читаем команду из отдельного файла, совместимость: fallback на project.team
    const teamFile = await this.storage.readJson(`projects/${projectId}/_team.json`);
    const team = teamFile?.members ?? project.team ?? [];
    return { ...project, team };
  }

  async getTeam(projectId) {
    const teamFile = await this.storage.readJson(`projects/${projectId}/_team.json`);
    // Fallback: если _team.json ещё нет — читаем из project.json
    if (teamFile) return teamFile.members ?? [];
    const project = await this.storage.readJson(`projects/${projectId}/project.json`);
    return project?.team ?? [];
  }

  async save(project) {
    const { team, ...meta } = project;

    // Метаданные проекта без команды
    await this.storage.writeJson(`projects/${project.id}/project.json`, meta);

    // Команда в отдельном файле
    await this.storage.writeJson(`projects/${project.id}/_team.json`, {
      projectId: project.id,
      members: team ?? []
    });

    // Глобальный индекс
    const all = await this.list();
    const next = all.filter((p) => p.id !== project.id);
    next.unshift({
      id: project.id,
      name: project.name,
      createdAt: project.createdAt,
      teamCount: (team ?? []).length
    });
    await this.storage.writeJson("projects/index.json", next);
  }

  async delete(projectId) {
    const all = await this.list();
    const next = all.filter((p) => p.id !== projectId);
    await this.storage.writeJson("projects/index.json", next);
  }
}
