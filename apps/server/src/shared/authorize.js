/**
 * Проверка владения проектом/встречей.
 *
 * Модель простая: у проекта один owner (currentUser.id при создании).
 * Легаси-проекты с ownerId === null считаются общими (видны/доступны всем
 * залогиненным) — так же, как их уже фильтрует GET /api/projects.
 * Админ имеет доступ ко всему.
 */
export function canAccessProject(project, currentUser) {
  if (!project) return false;
  if (currentUser?.role === "admin") return true;
  if (!project.ownerId) return true;
  return project.ownerId === currentUser?.id;
}

export function assertProjectAccess(project, currentUser, response, notFound) {
  if (!project) {
    notFound(response);
    return false;
  }
  if (!canAccessProject(project, currentUser)) {
    notFound(response);
    return false;
  }
  return true;
}
