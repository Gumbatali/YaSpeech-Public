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

  async list() {
    return readJsonFile(this.projectsIndexPath, []);
  }

  async getById(projectId) {
    return readJsonFile(this.teamManifestPath(projectId), null);
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
}
