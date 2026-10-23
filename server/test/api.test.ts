import { decryptSnapshot, DecryptError, fromBase64Url, type ProfileKeys } from '@tabsync/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbHandle } from '../src/db/client';
import { pruneAll } from '../src/repo';
import {
  createTestApp,
  createTestDb,
  get,
  makeProfile,
  post,
  registerProfile,
  T0,
  upload,
  uploadBody,
  type TestClient,
  type TestProfile,
} from './helpers';

const MINUTE = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

let handle: DbHandle;
let t: TestClient;

beforeAll(async () => {
  handle = await createTestDb();
});
afterAll(async () => {
  await handle.close();
});
beforeEach(() => {
  t = createTestApp(handle);
});

interface SnapshotJson {
  id: string;
  createdAt: string;
  receivedAt: string;
  kind: string;
  sizeBytes: number;
  blob?: string;
}

const json = async <T = SnapshotJson>(res: Response) => (await res.json()) as T;

async function decrypt(keys: ProfileKeys, body: SnapshotJson) {
  return decryptSnapshot(fromBase64Url(body.blob!), keys, {
    id: body.id,
    createdAt: body.createdAt,
  });
}

describe('POST /v1/profiles', () => {
  const register = (body: unknown, ip?: string) =>
    t.app.request('/v1/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(ip ? { 'x-test-ip': ip } : {}) },
      body: JSON.stringify(body),
    });

  it('registers a new profile, then is idempotent for the same token', async () => {
    const { keys } = await makeProfile();
    const body = { profileId: keys.profileId, authToken: keys.authToken };
    expect((await register(body)).status).toBe(201);
    const again = await register(body);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ profileId: keys.profileId });
  });

  it('returns 409 when the ID exists with a different token', async () => {
    const a = await makeProfile();
    const b = await makeProfile();
    await registerProfile(t.app, a);
    const res = await register({ profileId: a.keys.profileId, authToken: b.keys.authToken });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'profile_exists' });
  });

  it.each([
    ['empty body', {}],
    ['bad profileId', { profileId: 'short', authToken: 'b'.repeat(43) }],
    ['bad token', { profileId: 'A'.repeat(22), authToken: 'b'.repeat(42) }],
    ['array', []],
  ])('rejects %s', async (_name, body) => {
    expect((await register(body)).status).toBe(400);
  });

  it('rejects invalid JSON', async () => {
    const res = await t.app.request('/v1/profiles', { method: 'POST', body: '{nope' });
    expect(res.status).toBe(400);
  });

  it('rate-limits registrations per IP', async () => {
    t = createTestApp(handle, {
      rateLimits: {
        perIp: { limit: 1000, windowMs: MINUTE },
        perProfile: { limit: 1000, windowMs: MINUTE },
        register: { limit: 2, windowMs: 60 * MINUTE },
      },
    });
    const statuses = [];
    for (let i = 0; i < 3; i++) {
      const { keys } = await makeProfile();
      statuses.push(
        (await register({ profileId: keys.profileId, authToken: keys.authToken }, '198.51.100.7'))
          .status,
      );
    }
    expect(statuses).toEqual([201, 201, 429]);
    const { keys } = await makeProfile();
    expect(
      (await register({ profileId: keys.profileId, authToken: keys.authToken }, '198.51.100.8'))
        .status,
    ).toBe(201);
  });
});

describe('authentication', () => {
  it.each([
    ['no header', undefined],
    ['malformed header', 'Bearer nonsense'],
    ['token without profile ID', 'Bearer ' + 'b'.repeat(43)],
  ])('rejects %s with 401', async (_name, authorization) => {
    const res = await t.app.request('/v1/snapshots', {
      headers: authorization ? { Authorization: authorization } : {},
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer');
  });

  it('rejects an unregistered profile (wrong secret on join)', async () => {
    const stranger = await makeProfile();
    const res = await get(t.app, stranger, '/v1/snapshots/latest');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'unauthorized' });
  });

  it('rejects a registered profile with the wrong token', async () => {
    const a = await registerProfile(t.app);
    const b = await makeProfile();
    const res = await t.app.request('/v1/snapshots', {
      headers: { Authorization: `Bearer ${a.keys.profileId}.${b.keys.authToken}` },
    });
    expect(res.status).toBe(401);
  });
});

describe('POST /v1/snapshots', () => {
  let p: TestProfile;
  beforeEach(async () => {
    p = await registerProfile(t.app);
  });

  it('stores a snapshot and returns its metadata', async () => {
    const { res, body } = await upload(t.app, p);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      id: body.id,
      createdAt: body.createdAt,
      receivedAt: iso(T0),
      kind: 'auto',
      sizeBytes: fromBase64Url(body.blob).length,
    });
  });

  it('treats a retried upload of the same ID as success', async () => {
    const body = await uploadBody(p);
    expect((await post(t.app, p, body)).status).toBe(201);
    const retry = await post(t.app, p, body);
    expect(retry.status).toBe(200);
    expect((await json(retry)).id).toBe(body.id);
  });

  it('refuses an ID already used by another profile', async () => {
    const other = await registerProfile(t.app);
    const body = await uploadBody(p);
    await post(t.app, p, body);
    const res = await post(t.app, other, { ...(await uploadBody(other)), id: body.id });
    expect(res.status).toBe(409);
  });

  it('accepts createdAt up to 10 minutes ahead and rejects beyond', async () => {
    expect((await upload(t.app, p, { createdAt: iso(T0 + 9 * MINUTE) })).res.status).toBe(201);
    const { res } = await upload(t.app, p, { createdAt: iso(T0 + 11 * MINUTE) });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'clock_skew' });
  });

  it.each([
    ['bad id', { id: 'not-a-uuid' }],
    ['bad createdAt', { createdAt: 'yesterday' }],
    ['createdAt without timezone', { createdAt: '2026-10-22T12:00:00' }],
    ['bad kind', { kind: 'other' }],
    ['non-base64url blob', { blob: 'abc+/=' }],
    ['tiny blob', { blob: 'AAAA' }],
  ])('rejects %s', async (_name, override) => {
    const res = await post(t.app, p, { ...(await uploadBody(p)), ...override });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('rejects bodies over the size cap', async () => {
    t = createTestApp(handle, { bodyLimitBytes: 1024 });
    const res = await post(t.app, p, { ...(await uploadBody(p)), blob: 'A'.repeat(2000) });
    expect(res.status).toBe(413);
  });
});

describe('GET /v1/snapshots/latest', () => {
  let p: TestProfile;
  beforeEach(async () => {
    p = await registerProfile(t.app);
  });

  it('returns 404 before any upload', async () => {
    const res = await get(t.app, p, '/v1/snapshots/latest');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'no_snapshots' });
  });

  it('returns the newest by receipt time with a blob that decrypts', async () => {
    await upload(t.app, p, { url: 'https://first/' });
    t.clock.now += MINUTE;
    const { body } = await upload(t.app, p, {
      createdAt: iso(T0 + MINUTE),
      url: 'https://second/',
    });
    const res = await get(t.app, p, '/v1/snapshots/latest');
    expect(res.status).toBe(200);
    expect(res.headers.get('ETag')).toBe(`"${body.id}"`);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const latest = await json(res);
    expect(latest.id).toBe(body.id);
    expect((await decrypt(p.keys, latest)).windows[0]!.tabs[0]!.url).toBe('https://second/');
  });

  it('orders by server receipt, not client clock (skewed device)', async () => {
    await upload(t.app, p, { createdAt: iso(T0 + 5 * MINUTE) }); // device clock ahead
    t.clock.now += MINUTE;
    const { body } = await upload(t.app, p, { createdAt: iso(T0 + MINUTE) });
    expect((await json(await get(t.app, p, '/v1/snapshots/latest'))).id).toBe(body.id);
  });

  it('ignores pre-restore snapshots', async () => {
    const { body } = await upload(t.app, p);
    t.clock.now += MINUTE;
    await upload(t.app, p, { createdAt: iso(T0 + MINUTE), kind: 'pre-restore' });
    expect((await json(await get(t.app, p, '/v1/snapshots/latest'))).id).toBe(body.id);
  });

  it('returns 304 for If-None-Match with the current ID, 200 once it changes', async () => {
    const { body } = await upload(t.app, p);
    for (const header of [body.id, `"${body.id}"`, `W/"${body.id}"`, `"other", "${body.id}"`]) {
      const res = await get(t.app, p, '/v1/snapshots/latest', { 'If-None-Match': header });
      expect(res.status, header).toBe(304);
    }
    t.clock.now += MINUTE;
    await upload(t.app, p, { createdAt: iso(T0 + MINUTE) });
    const res = await get(t.app, p, '/v1/snapshots/latest', { 'If-None-Match': `"${body.id}"` });
    expect(res.status).toBe(200);
  });
});

describe('GET /v1/snapshots and /v1/snapshots/:id', () => {
  it('lists metadata newest first, all kinds, without blobs', async () => {
    const p = await registerProfile(t.app);
    const a = await upload(t.app, p, { createdAt: iso(T0 - 2 * MINUTE) });
    const b = await upload(t.app, p, { createdAt: iso(T0 - MINUTE), kind: 'pre-restore' });
    const c = await upload(t.app, p, { createdAt: iso(T0), kind: 'manual' });
    const { snapshots } = await json<{ snapshots: SnapshotJson[] }>(
      await get(t.app, p, '/v1/snapshots'),
    );
    expect(snapshots.map((s) => [s.id, s.kind])).toEqual([
      [c.body.id, 'manual'],
      [b.body.id, 'pre-restore'],
      [a.body.id, 'auto'],
    ]);
    expect(snapshots[0]).not.toHaveProperty('blob');
  });

  it('fetches one snapshot by ID', async () => {
    const p = await registerProfile(t.app);
    const { body } = await upload(t.app, p, { url: 'https://one/' });
    const res = await get(t.app, p, `/v1/snapshots/${body.id.toUpperCase()}`);
    expect(res.status).toBe(200);
    expect((await decrypt(p.keys, await json(res))).windows[0]!.tabs[0]!.url).toBe('https://one/');
  });

  it('returns 404 for unknown or malformed IDs', async () => {
    const p = await registerProfile(t.app);
    expect((await get(t.app, p, `/v1/snapshots/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await get(t.app, p, '/v1/snapshots/nope')).status).toBe(404);
  });
});

describe('profile isolation', () => {
  it('never shows one profile another profile’s snapshots', async () => {
    const a = await registerProfile(t.app);
    const b = await registerProfile(t.app);
    const { body } = await upload(t.app, a);
    expect((await get(t.app, b, '/v1/snapshots/latest')).status).toBe(404);
    expect(
      (await json<{ snapshots: unknown[] }>(await get(t.app, b, '/v1/snapshots'))).snapshots,
    ).toEqual([]);
    expect((await get(t.app, b, `/v1/snapshots/${body.id}`)).status).toBe(404);
  });

  it('a blob swapped in from another profile fails to decrypt', async () => {
    const a = await registerProfile(t.app);
    const b = await registerProfile(t.app);
    // b uploads a's ciphertext under b's account: the server can't tell, but the client can.
    const aBody = await uploadBody(a);
    await post(t.app, b, aBody);
    const latest = await json(await get(t.app, b, '/v1/snapshots/latest'));
    await expect(decrypt(b.keys, latest)).rejects.toThrow(DecryptError);
  });
});

describe('pruning', () => {
  it('prunes after each insert, protecting the latest and recent pre-restore snapshots', async () => {
    const p = await registerProfile(t.app);
    // Everything lands in the same minute slot, so only the newest auto snapshot survives
    // alongside the protected pre-restore.
    const preRestore = await upload(t.app, p, {
      createdAt: iso(T0 + 30 * 1000),
      kind: 'pre-restore',
    });
    for (let i = 1; i <= 5; i++) {
      t.clock.now = T0 + i * 10 * 1000; // all within the same minute slot as each other
      await upload(t.app, p, { createdAt: iso(T0 + i * 10 * 1000) });
    }
    const { snapshots } = await json<{ snapshots: SnapshotJson[] }>(
      await get(t.app, p, '/v1/snapshots'),
    );
    const latest = await json(await get(t.app, p, '/v1/snapshots/latest'));
    const ids = snapshots.map((s) => s.id);
    expect(ids).toContain(preRestore.body.id);
    expect(ids).toContain(latest.id);
    expect(snapshots.filter((s) => s.kind === 'auto')).toHaveLength(1);
  });

  it('keeps the latest-by-receipt even when another snapshot is newer by createdAt', async () => {
    const p = await registerProfile(t.app);
    await upload(t.app, p, { createdAt: iso(T0 + 50 * 1000) }); // skewed-ahead device
    t.clock.now = T0 + 20 * 1000;
    const { body } = await upload(t.app, p, { createdAt: iso(T0 + 10 * 1000) });
    const { snapshots } = await json<{ snapshots: SnapshotJson[] }>(
      await get(t.app, p, '/v1/snapshots'),
    );
    expect(snapshots.map((s) => s.id)).toContain(body.id);
    expect((await json(await get(t.app, p, '/v1/snapshots/latest'))).id).toBe(body.id);
  });

  it('the daily sweep prunes snapshots that aged into coarser tiers', async () => {
    const p = await registerProfile(t.app);
    for (let i = 0; i < 10; i++) {
      t.clock.now = T0 + i * MINUTE;
      await upload(t.app, p, { createdAt: iso(T0 + i * MINUTE) });
    }
    const count = async () =>
      (await json<{ snapshots: unknown[] }>(await get(t.app, p, '/v1/snapshots'))).snapshots.length;
    expect(await count()).toBe(10);
    // Two days later the ten minute-slots collapse into one day slot (latest is protected too).
    await pruneAll(handle.db, T0 + 2 * 24 * 60 * MINUTE);
    expect(await count()).toBe(1);
  });
});

describe('rate limiting', () => {
  it('limits requests per IP', async () => {
    t = createTestApp(handle, {
      rateLimits: {
        perIp: { limit: 2, windowMs: MINUTE },
        perProfile: { limit: 100, windowMs: MINUTE },
        register: { limit: 100, windowMs: MINUTE },
      },
    });
    const p = await registerProfile(t.app); // request 1
    expect((await get(t.app, p, '/v1/snapshots')).status).toBe(200);
    const res = await get(t.app, p, '/v1/snapshots');
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    t.clock.now += MINUTE;
    expect((await get(t.app, p, '/v1/snapshots')).status).toBe(200);
  });

  it('limits requests per profile across IPs', async () => {
    t = createTestApp(handle, {
      rateLimits: {
        perIp: { limit: 100, windowMs: MINUTE },
        perProfile: { limit: 2, windowMs: MINUTE },
        register: { limit: 100, windowMs: MINUTE },
      },
    });
    const p = await registerProfile(t.app);
    const statuses = [];
    for (const ip of ['10.0.0.1', '10.0.0.2', '10.0.0.3']) {
      statuses.push((await get(t.app, p, '/v1/snapshots', { 'x-test-ip': ip })).status);
    }
    expect(statuses).toEqual([200, 200, 429]);
  });

  it('uses X-Forwarded-For only when trusting the proxy', async () => {
    const limits = {
      perIp: { limit: 1, windowMs: MINUTE },
      perProfile: { limit: 100, windowMs: MINUTE },
      register: { limit: 100, windowMs: MINUTE },
    };
    const hit = (app: TestClient['app'], ip: string) =>
      app.request('/v1/snapshots', { headers: { 'x-forwarded-for': `${ip}, 10.1.1.1` } });

    const trusted = createTestApp(
      handle,
      { rateLimits: limits, trustProxy: true },
      { clientIp: undefined },
    );
    expect((await hit(trusted.app, '192.0.2.1')).status).toBe(401);
    expect((await hit(trusted.app, '192.0.2.2')).status).toBe(401);

    const untrusted = createTestApp(handle, { rateLimits: limits }, { clientIp: undefined });
    expect((await hit(untrusted.app, '192.0.2.1')).status).toBe(401);
    expect((await hit(untrusted.app, '192.0.2.2')).status).toBe(429);
  });
});

describe('transport hygiene', () => {
  it('sends CORS headers only to allowed origins', async () => {
    t = createTestApp(handle, { allowedOrigins: ['chrome-extension://abcdef'] });
    const preflight = (origin: string) =>
      t.app.request('/v1/snapshots', {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' },
      });
    expect(
      (await preflight('chrome-extension://abcdef')).headers.get('Access-Control-Allow-Origin'),
    ).toBe('chrome-extension://abcdef');
    expect(
      (await preflight('https://evil.example')).headers.get('Access-Control-Allow-Origin'),
    ).toBeNull();
  });

  it('rejects plain HTTP behind the proxy when HTTPS is required', async () => {
    t = createTestApp(handle, { requireHttps: true, trustProxy: true });
    expect(
      (await t.app.request('/health', { headers: { 'x-forwarded-proto': 'http' } })).status,
    ).toBe(403);
    expect(
      (await t.app.request('/health', { headers: { 'x-forwarded-proto': 'https' } })).status,
    ).toBe(200);
  });
});
