export class YcMeetingRepository {
  constructor(storage) {
    this.storage = storage;
  }

  async getById(meetingId) {
    // Fast path: глобальный индекс (есть у всех встреч сохранённых новым кодом)
    const global = await this.storage.readJson("meetings/index.json");
    if (global) {
      const entry = global.find((m) => m.id === meetingId);
      if (entry) {
        if (entry.baseKey) {
          return this.storage.readJson(`${entry.baseKey}/meeting.json`);
        }
        // Запись есть, но без baseKey — старый формат глобального индекса
        return this.storage.readJson(
          `projects/${entry.projectId}/meetings/${meetingId}/meeting.json`
        );
      }
    }

    // Fallback: сканируем проектные индексы.
    // Нужен для встреч, созданных до введения глобального индекса:
    // у них есть projects/{projectId}/meetings/index.json, но нет meetings/index.json.
    const projects = await this.storage.readJson("projects/index.json");
    if (!projects) return null;

    for (const project of projects) {
      const projectMeetings = await this.storage.readJson(
        `projects/${project.id}/meetings/index.json`
      );
      if (!projectMeetings) continue;

      const found = projectMeetings.find((m) => m.id === meetingId);
      if (found) {
        return this.storage.readJson(
          `projects/${project.id}/meetings/${meetingId}/meeting.json`
        );
      }
    }

    return null;
  }

  async listByProject(projectId) {
    const index = await this.storage.readJson(
      `projects/${projectId}/meetings/index.json`
    );
    return index ?? [];
  }

  async save(meeting) {
    const baseKey = meeting.artifacts?.baseKey
      ?? `projects/${meeting.projectId}/meetings/${meeting.id}`;
    const key = `${baseKey}/meeting.json`;

    await this.storage.writeJson(key, meeting);

    // Обновляем индекс проекта
    const index = await this.listByProject(meeting.projectId);
    const next = index.filter((m) => m.id !== meeting.id);
    next.unshift({
      id: meeting.id,
      projectId: meeting.projectId,
      date: meeting.date,
      status: meeting.status,
      currentStage: meeting.currentStage,
      updatedAt: meeting.updatedAt,
      speechKitJobId: meeting.speechKitJobId,
      summaryTitle: meeting.protocol?.summary?.title ?? meeting.titleDraft,
    });
    await this.storage.writeJson(
      `projects/${meeting.projectId}/meetings/index.json`,
      next
    );

    // Обновляем глобальный индекс (храним baseKey для backward compat)
    const global = (await this.storage.readJson("meetings/index.json")) ?? [];
    const nextGlobal = global.filter((m) => m.id !== meeting.id);
    nextGlobal.unshift({
      id: meeting.id,
      projectId: meeting.projectId,
      baseKey,
    });
    await this.storage.writeJson("meetings/index.json", nextGlobal);
  }

  async delete(meetingId) {
    // Определяем projectId: сначала из глобального индекса, затем — сканирование
    let projectId = null;

    const global = (await this.storage.readJson("meetings/index.json")) ?? [];
    const globalEntry = global.find((m) => m.id === meetingId);

    if (globalEntry) {
      projectId = globalEntry.projectId;
      // Удаляем из глобального индекса
      const nextGlobal = global.filter((m) => m.id !== meetingId);
      await this.storage.writeJson("meetings/index.json", nextGlobal);
    } else {
      // Fallback: ищем в проектных индексах (встречи до глобального индекса)
      const projects = (await this.storage.readJson("projects/index.json")) ?? [];
      for (const project of projects) {
        const projectMeetings = await this.storage.readJson(
          `projects/${project.id}/meetings/index.json`
        );
        if (projectMeetings?.some((m) => m.id === meetingId)) {
          projectId = project.id;
          break;
        }
      }
    }

    if (!projectId) return;

    // Удаляем из проектного индекса
    const projectIndex = await this.listByProject(projectId);
    const nextProjectIndex = projectIndex.filter((m) => m.id !== meetingId);
    await this.storage.writeJson(
      `projects/${projectId}/meetings/index.json`,
      nextProjectIndex
    );
  }
}
