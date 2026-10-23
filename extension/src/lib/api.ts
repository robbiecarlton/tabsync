import type { SnapshotReason } from '@tabsync/shared';

export interface SnapshotMeta {
  id: string;
  createdAt: string;
  receivedAt: string;
  kind: SnapshotReason;
  sizeBytes: number;
}

export interface SnapshotRecord extends SnapshotMeta {
  /** base64url: version byte + IV + ciphertext. */
  blob: string;
}

export interface UploadRequest {
  id: string;
  createdAt: string;
  kind: SnapshotReason;
  blob: string;
}

export type LatestResult =
  { status: 'ok'; snapshot: SnapshotRecord } | { status: 'not-modified' } | { status: 'empty' };

/** The sync server, as the extension sees it. */
export interface SyncApi {
  register(): Promise<void>;
  latest(ifNoneMatch?: string): Promise<LatestResult>;
  list(): Promise<SnapshotMeta[]>;
  get(id: string): Promise<SnapshotRecord>;
  upload(request: UploadRequest): Promise<SnapshotMeta>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Worth retrying later: server trouble or rate limiting. */
  get transient(): boolean {
    return this.status >= 500 || this.status === 429;
  }
}

export class NetworkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NetworkError';
  }
}

export interface Credentials {
  profileId: string;
  authToken: string;
}

export class HttpSyncApi implements SyncApi {
  private readonly base: string;

  constructor(
    serverUrl: string,
    private readonly creds: Credentials,
    private readonly fetchFn: typeof fetch = (...args) => fetch(...args),
  ) {
    this.base = serverUrl.replace(/\/+$/, '');
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.creds.profileId}.${this.creds.authToken}`,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
      });
    } catch (cause) {
      throw new NetworkError(`Can't reach the sync server at ${this.base}`, { cause });
    }
    if (res.ok || res.status === 304) return res;
    let code = 'http_error';
    let message = `Server responded ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      code = body.error ?? code;
      message = body.message ?? message;
    } catch {
      // Not JSON; keep the generic message.
    }
    throw new ApiError(res.status, code, message);
  }

  async register(): Promise<void> {
    await this.request('/v1/profiles', {
      method: 'POST',
      body: JSON.stringify(this.creds),
    });
  }

  async latest(ifNoneMatch?: string): Promise<LatestResult> {
    try {
      const res = await this.request('/v1/snapshots/latest', {
        headers: ifNoneMatch ? { 'If-None-Match': `"${ifNoneMatch}"` } : {},
      });
      if (res.status === 304) return { status: 'not-modified' };
      return { status: 'ok', snapshot: (await res.json()) as SnapshotRecord };
    } catch (err) {
      if (err instanceof ApiError && err.code === 'no_snapshots') return { status: 'empty' };
      throw err;
    }
  }

  async list(): Promise<SnapshotMeta[]> {
    const res = await this.request('/v1/snapshots');
    return ((await res.json()) as { snapshots: SnapshotMeta[] }).snapshots;
  }

  async get(id: string): Promise<SnapshotRecord> {
    const res = await this.request(`/v1/snapshots/${encodeURIComponent(id)}`);
    return (await res.json()) as SnapshotRecord;
  }

  async upload(request: UploadRequest): Promise<SnapshotMeta> {
    const res = await this.request('/v1/snapshots', {
      method: 'POST',
      body: JSON.stringify(request),
    });
    return (await res.json()) as SnapshotMeta;
  }
}
