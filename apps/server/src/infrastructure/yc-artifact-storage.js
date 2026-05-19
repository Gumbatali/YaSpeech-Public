import { signRequest, presignUrl } from "../shared/sign-v4.js";

const REGION  = "ru-central1";
const SERVICE = "s3";
const HOST    = "storage.yandexcloud.net";

export class YcArtifactStorage {
  constructor({ bucket, keyId, secret }) {
    this.bucket = bucket;
    this.keyId  = keyId;
    this.secret = secret;
  }

  /** Presigned PUT URL for direct browser upload */
  async getUploadUrl(key, _contentType) {
    return presignUrl({
      method:    "PUT",
      host:      HOST,
      path:      `/${this.bucket}/${key}`,
      service:   SERVICE,
      region:    REGION,
      keyId:     this.keyId,
      secret:    this.secret,
      expiresIn: 3600,
    });
  }

  async readJson(key) {
    try {
      const res = await this._get(key);
      if (!res.ok) return null;
      return res.json();
    } catch {
      return null;
    }
  }

  async writeJson(key, data) {
    const body = JSON.stringify(data, null, 2);
    await this._put(key, body, "application/json");
  }

  async writeText(key, text) {
    await this._put(key, text, "text/plain; charset=utf-8");
  }

  async readText(key) {
    try {
      const res = await this._get(key);
      if (!res.ok) return null;
      return res.text();
    } catch {
      return null;
    }
  }

  /** Returns a ReadableStream (Web Streams API) */
  async readStream(key) {
    const res = await this._get(key);
    if (!res.ok) throw new Error(`S3 GET failed: ${res.status}`);
    return res.body;
  }

  // ── private ────────────────────────────────────────────────────────────────

  _path(key) {
    return `/${this.bucket}/${key}`;
  }

  async _get(key) {
    const path = this._path(key);
    const sig  = signRequest({
      method:  "GET",
      host:    HOST,
      path,
      service: SERVICE,
      region:  REGION,
      keyId:   this.keyId,
      secret:  this.secret,
    });

    return fetch(`https://${HOST}${path}`, {
      method:  "GET",
      headers: { host: HOST, ...sig },
    });
  }

  async _put(key, body, contentType) {
    const path = this._path(key);
    const sig  = signRequest({
      method:  "PUT",
      host:    HOST,
      path,
      headers: { "content-type": contentType },
      body,
      service: SERVICE,
      region:  REGION,
      keyId:   this.keyId,
      secret:  this.secret,
    });

    const res = await fetch(`https://${HOST}${path}`, {
      method:  "PUT",
      headers: { host: HOST, "content-type": contentType, ...sig },
      body,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`S3 PUT failed: ${res.status} ${text}`);
    }
  }
}
