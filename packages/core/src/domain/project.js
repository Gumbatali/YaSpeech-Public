import { slugifyProjectName } from "../shared/slugify.js";

export function createProject({ name, members, createdAt, fallbackId }) {
  const id = slugifyProjectName(name) || fallbackId;

  return {
    id,
    name,
    team: members.map((member) => ({ ...member })),
    createdAt,
    updatedAt: createdAt
  };
}

export function updateProjectTeam(project, members, updatedAt) {
  return {
    ...project,
    team: members.map((member) => ({ ...member })),
    updatedAt
  };
}
