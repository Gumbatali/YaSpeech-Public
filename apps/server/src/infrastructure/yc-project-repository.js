export class YcProjectRepository {
  constructor(storage) {
    this.storage = storage;
  }

  async list() {
    const index = await this.storage.readJson("projects/index.json");
    return index ?? [];
  }

  async getById(projectId) {
    // Читаем project.json и _team.json параллельно
    const [project, teamFile] = await Promise.all([
      this.storage.readJson(`projects/${projectId}/project.json`),
      this.storage.readJson(`projects/${projectId}/_team.json`)
    ]);
    if (!project) return null;
    // Приоритет: _team.json → project.team (старый формат)
    const team = teamFile?.members ?? project.team ?? [];
    return { ...project, team };
  }

  async getTeam(projectId) {
    const teamFile = await this.storage.readJson(`projects/${projectId}/_team.json`);
    if (teamFile) return teamFile.members ?? [];
    // Fallback для старых проектов без _team.json
    const project = await this.storage.readJson(`projects/${projectId}/project.json`);
    return project?.team ?? [];
  }

  async save(project) {
    const { team, ...meta } = project;

    // Запись метаданных и команды параллельно
    const [, , all] = await Promise.all([
      this.storage.writeJson(`projects/${project.id}/project.json`, meta),
      this.storage.writeJson(`projects/${project.id}/_team.json`, {
        projectId: project.id,
        members: team ?? []
      }),
      this.list()
    ]);

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
