import { updateProjectTeam } from "../domain/project.js";

export class UpdateProjectTeamUseCase {
  constructor(projectRepository, clock) {
    this.projectRepository = projectRepository;
    this.clock = clock;
  }

  async execute({ projectId, members }) {
    const project = await this.projectRepository.getById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const updated = updateProjectTeam(
      project,
      members,
      this.clock.now().toISOString()
    );
    await this.projectRepository.save(updated);
    return updated;
  }
}
