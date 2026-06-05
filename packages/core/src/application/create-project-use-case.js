import { createProject } from "../domain/project.js";

export class CreateProjectUseCase {
  constructor(projectRepository, clock, idGenerator) {
    this.projectRepository = projectRepository;
    this.clock = clock;
    this.idGenerator = idGenerator;
  }

  async execute({ name, members, ownerId = null }) {
    const timestamp = this.clock.now().toISOString();
    const project = createProject({
      name,
      members,
      ownerId,
      createdAt: timestamp,
      fallbackId: this.idGenerator.next()
    });

    await this.projectRepository.save(project);
    return project;
  }
}
