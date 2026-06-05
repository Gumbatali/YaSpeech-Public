import { slugifyProjectName } from "../shared/slugify.js";

export function createProject({ name, members, createdAt, fallbackId, ownerId = null }) {
  const id = slugifyProjectName(name) || fallbackId;

  return {
    id,
    name,
    ownerId,
    team: members.map((member) => typeof member === "string" ? { name: member } : { ...member }),
    createdAt,
    updatedAt: createdAt
  };
}

export function updateProjectTeam(project, members, updatedAt) {
  return {
    ...project,
    team: members.map((member) => typeof member === "string" ? { name: member } : { ...member }),
    updatedAt
  };
}
