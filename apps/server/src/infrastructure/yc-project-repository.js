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

  // ── Глоссарий проекта ──────────────────────────────────────────
  // Накапливаем термины из всех встреч — чем больше встреч, тем точнее

  async getGlossary(projectId) {
    return this.storage.readJson(`projects/${projectId}/_glossary.json`);
  }

  async mergeGlossary(projectId, newGlossary) {
    if (!newGlossary?.terms?.length && !Object.keys(newGlossary?.abbreviations ?? {}).length) return;

    const existing = await this.getGlossary(projectId) ?? { terms: [], abbreviations: {} };

    // Объединяем термины: дедупликация по term
    const termMap = new Map(existing.terms.map((t) => [t.term, t]));
    for (const t of (newGlossary.terms ?? [])) {
      if (termMap.has(t.term)) {
        // Дополняем варианты написания
        const merged = termMap.get(t.term);
        const allVariants = new Set([...merged.variants, ...t.variants]);
        termMap.set(t.term, { ...merged, variants: [...allVariants] });
      } else {
        termMap.set(t.term, t);
      }
    }

    // Объединяем аббревиатуры
    const mergedAbbreviations = {
      ...existing.abbreviations,
      ...(newGlossary.abbreviations ?? {})
    };

    const merged = {
      terms: [...termMap.values()],
      abbreviations: mergedAbbreviations,
      updatedAt: new Date().toISOString()
    };

    await this.storage.writeJson(`projects/${projectId}/_glossary.json`, merged);
    return merged;
  }
}
