import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deriveProfileKeys,
  encryptSnapshot,
  generateSecret,
  toBase64Url,
  type ProfileKeys,
  type SnapshotReason,
} from '@tabsync/shared';
import { snapshot, tab, win } from '@tabsync/shared/testing';
import { createApp, type AppDeps } from '../src/app';
import { defaultConfig, type ServerConfig } from '../src/config';
import { createDb, type DbHandle } from '../src/db/client';
import { loadMigrations, migrateUp } from '../src/db/migrator';

export const migrationsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../migrations',
);

export async function createTestDb(): Promise<DbHandle> {
  const handle = createDb({ pgliteDir: 'memory://' });
  await migrateUp(handle.db, await loadMigrations(migrationsDir));
  return handle;
}

export const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);

export interface TestClient {
  app: ReturnType<typeof createApp>;
  clock: { now: number };
}

export function createTestApp(
  handle: DbHandle,
  config: Partial<ServerConfig> = {},
  deps: Partial<AppDeps> = {},
): TestClient {
  const clock = { now: T0 };
  const app = createApp({
    db: handle.db,
    config: { ...defaultConfig, ...config },
    now: () => clock.now,
    clientIp: (c) => c.req.header('x-test-ip') ?? '203.0.113.1',
    ...deps,
  });
  return { app, clock };
}

export interface TestProfile {
  keys: ProfileKeys;
  auth: string;
}

export async function makeProfile(): Promise<TestProfile> {
  const keys = await deriveProfileKeys(generateSecret());
  return { keys, auth: `Bearer ${keys.profileId}.${keys.authToken}` };
}

export async function registerProfile(app: TestClient['app'], profile?: TestProfile) {
  const p = profile ?? (await makeProfile());
  const res = await app.request('/v1/profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId: p.keys.profileId, authToken: p.keys.authToken }),
  });
  if (res.status !== 201 && res.status !== 200) throw new Error(`register failed: ${res.status}`);
  return p;
}

export interface UploadOptions {
  id?: string;
  createdAt?: string;
  kind?: SnapshotReason;
  url?: string;
}

export async function uploadBody(profile: TestProfile, opts: UploadOptions = {}) {
  const id = opts.id ?? crypto.randomUUID();
  const createdAt = opts.createdAt ?? new Date(T0).toISOString();
  const kind = opts.kind ?? 'auto';
  const s = snapshot([win([tab(opts.url ?? 'https://example.com/')])], {
    snapshotId: id,
    createdAt,
    reason: kind,
  });
  const blob = await encryptSnapshot(s, profile.keys);
  return { id, createdAt, kind, blob: toBase64Url(blob) };
}

export function post(app: TestClient['app'], profile: TestProfile, body: unknown) {
  return app.request('/v1/snapshots', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: profile.auth },
    body: JSON.stringify(body),
  });
}

export async function upload(
  app: TestClient['app'],
  profile: TestProfile,
  opts: UploadOptions = {},
) {
  const body = await uploadBody(profile, opts);
  const res = await post(app, profile, body);
  return { res, body };
}

export function get(
  app: TestClient['app'],
  profile: TestProfile,
  path: string,
  headers: Record<string, string> = {},
) {
  return app.request(path, { headers: { Authorization: profile.auth, ...headers } });
}
