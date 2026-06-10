/**
 * HTTP-клиент к YaSpeech API.
 * Единственное место в фронтенде, которое знает пути и форматы эндпойнтов.
 */
export class ApiClient {
  constructor(onUnauthorized) {
    this._onUnauthorized = onUnauthorized;
  }

  async json(pathname, init = {}, { skipAuthRedirect = false } = {}) {
    const response = await fetch(pathname, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init.headers ?? {})
      }
    });

    if (response.status === 401 && !skipAuthRedirect) {
      this._onUnauthorized?.();
      throw new Error("Сессия истекла. Войдите снова.");
    }

    if (!response.ok) {
      let message = "Не удалось выполнить запрос.";
      try {
        const body = await response.json();
        // Поддерживаем оба формата: { error: "string" } и { error: { message } }
        message = typeof body.error === "string"
          ? body.error
          : (body.error?.message ?? message);
      } catch {}
      throw new Error(message);
    }

    return response.json();
  }

  getMe() {
    return this.json("/api/auth/me");
  }

  register(login, password) {
    return this.json("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ login, password })
    }, { skipAuthRedirect: true });
  }

  login(login, password) {
    return this.json("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ login, password })
    }, { skipAuthRedirect: true });
  }

  logout() {
    return this.json("/api/auth/logout", { method: "POST" });
  }

  listProjects() {
    return this.json("/api/projects");
  }

  createProject(payload) {
    return this.json("/api/projects", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  }

  getTeam(projectId) {
    return this.json(`/api/projects/${projectId}/team`);
  }

  updateTeam(projectId, payload) {
    return this.json(`/api/projects/${projectId}/team`, {
      method: "PUT",
      body: JSON.stringify(payload)
    });
  }

  listMeetings(projectId) {
    return this.json(`/api/projects/${projectId}/meetings`);
  }

  createMeeting(payload) {
    return this.json("/api/meetings", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  }

  uploadFile(upload, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(upload.method, upload.uploadUrl);
      xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(xhr);
        } else {
          reject(new Error(`Ошибка загрузки файла на сервер (HTTP ${xhr.status}).`));
        }
      };
      xhr.onerror = () => reject(new Error("Ошибка загрузки файла."));
      xhr.send(file);
    });
  }

  completeUpload(meetingId, sizeBytes, durationSeconds) {
    return this.json(`/api/meetings/${meetingId}/upload-complete`, {
      method: "POST",
      body: JSON.stringify({ sizeBytes, durationSeconds: durationSeconds ?? null })
    });
  }

  confirmDraft(meetingId, payload) {
    return this.json(`/api/meetings/${meetingId}/confirm-draft`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
  }

  getMeeting(meetingId) {
    return this.json(`/api/meetings/${meetingId}`);
  }

  patchTranscript(meetingId, rawText) {
    return this.json(`/api/meetings/${meetingId}/transcript`, {
      method: "PATCH",
      body: JSON.stringify({ rawText })
    });
  }

  patchProtocol(meetingId, protocol) {
    return this.json(`/api/meetings/${meetingId}/protocol`, {
      method: "PATCH",
      body: JSON.stringify({ protocol })
    });
  }

  restoreTranscript(meetingId) {
    return this.json(`/api/meetings/${meetingId}/transcript/restore`, {
      method: "POST",
      body: JSON.stringify({})
    });
  }

  // ── Админ: управление пользователями ──
  listUsers() {
    return this.json("/api/admin/users");
  }

  setUserRole(userId, role) {
    return this.json(`/api/admin/users/${userId}/role`, {
      method: "PATCH",
      body: JSON.stringify({ role })
    });
  }

  banUser(userId) {
    return this.json(`/api/admin/users/${userId}/ban`, {
      method: "POST",
      body: JSON.stringify({})
    });
  }

  unbanUser(userId) {
    return this.json(`/api/admin/users/${userId}/unban`, {
      method: "POST",
      body: JSON.stringify({})
    });
  }

  setUserQuota(userId, quota) {
    return this.json(`/api/admin/users/${userId}/quota`, {
      method: "PATCH",
      body: JSON.stringify({ quota })
    });
  }

  resetUserQuota(userId) {
    return this.json(`/api/admin/users/${userId}/quota/reset`, {
      method: "POST",
      body: JSON.stringify({})
    });
  }

  regenerateProtocol(meetingId) {
    return this.json(`/api/meetings/${meetingId}/regenerate-protocol`, {
      method: "POST",
      body: JSON.stringify({})
    });
  }

  retryMeeting(meetingId) {
    return this.json(`/api/meetings/${meetingId}/retry`, {
      method: "POST",
      body: JSON.stringify({})
    });
  }

  async getProtocolText(meetingId) {
    const response = await fetch(`/api/meetings/${meetingId}/protocol.txt`);
    if (!response.ok) {
      throw new Error("Не удалось получить текст протокола.");
    }
    return response.text();
  }

  deleteProject(projectId) {
    return this.json(`/api/projects/${projectId}`, { method: "DELETE" });
  }

  deleteMeeting(meetingId) {
    return this.json(`/api/meetings/${meetingId}`, { method: "DELETE" });
  }
}
