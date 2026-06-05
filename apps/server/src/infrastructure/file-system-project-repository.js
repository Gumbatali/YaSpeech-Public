import path from "node:path";
import { readJsonFile, writeJsonFile } from "../shared/fs.js";

export class FileSystemProjectRepository {
  constructor(dataDirectory) {
    this.dataDirectory = dataDirectory;
  }

  get projectsIndexPath() {
    return path.join(this.dataDirectory, "projects", "index.json");
  }

  teamManifestPath(projectId) {
    return path.join(this.dataDirectory, "projects", projectId, "team.json");
  }

  glossaryPath(projectId) {
    return path.join(this.dataDirectory, "projects", projectId, "_glossary.json");
  }

  async list() {
    return readJsonFile(this.projectsIndexPath, []);
  }

  async getById(projectId) {
    return readJsonFile(this.teamManifestPath(projectId), null);
  }

  async getTeam(projectId) {
    const project = await this.getById(projectId);
    return project?.team ?? [];
  }

  async delete(projectId) {
    const index = await this.list();
    const next = index.filter((entry) => entry.id !== projectId);
    await writeJsonFile(this.projectsIndexPath, next);
  }

  async save(project) {
    await writeJsonFile(this.teamManifestPath(project.id), project);

    const index = await this.list();
    const nextIndex = index.filter((entry) => entry.id !== project.id);
    nextIndex.push({
      id: project.id,
      name: project.name,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      teamCount: project.team.length
    });
    nextIndex.sort((left, right) => left.name.localeCompare(right.name, "ru"));

    await writeJsonFile(this.projectsIndexPath, nextIndex);
  }

  // ── Глоссарий проекта ──────────────────────────────────────────
  // Зеркалит YcProjectRepository, чтобы pipeline работал и локально.

  async getGlossary(projectId) {
    return readJsonFile(this.glossaryPath(projectId), null);
  }

  async mergeGlossary(projectId, newGlossary) {
    if (!newGlossary?.terms?.length && !Object.keys(newGlossary?.abbreviations ?? {}).length) return;

    const existing = (await this.getGlossary(projectId)) ?? { terms: [], abbreviations: {} };

    const termMap = new Map(existing.terms.map((t) => [t.term, t]));
    for (const t of (newGlossary.terms ?? [])) {
      if (termMap.has(t.term)) {
        const merged = termMap.get(t.term);
        const allVariants = new Set([...(merged.variants ?? []), ...(t.variants ?? [])]);
        termMap.set(t.term, { ...merged, variants: [...allVariants] });
      } else {
        termMap.set(t.term, t);
      }
    }

    const merged = {
      terms: [...termMap.values()],
      abbreviations: { ...existing.abbreviations, ...(newGlossary.abbreviations ?? {}) },
      updatedAt: new Date().toISOString()
    };

    await writeJsonFile(this.glossaryPath(projectId), merged);
  }
}
