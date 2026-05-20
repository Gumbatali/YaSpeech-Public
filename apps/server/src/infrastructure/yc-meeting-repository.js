export class YcMeetingRepository {
  constructor(storage) {
    this.storage = storage;
  }

  async getById(meetingId) {
    const global = await this.storage.readJson("meetings/index.json");
    if (!global) return null;
    const entry = global.find((m) => m.id === meetingId);
    if (!entry) return null;

    // Новый путь: baseKey хранится в индексе
    if (entry.baseKey) {
      return this.storage.readJson(`${entry.baseKey}/meeting.json`);
    }
    // Fallback: старый путь (meetings/{uuid}/meeting.json)
    return this.storage.readJson(
      `projects/${entry.projectId}/meetings/${meetingId}/meeting.json`
    );
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
}
