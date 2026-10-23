import { getConnInfo } from '@hono/node-server/conninfo';
import { SNAPSHOT_REASONS, type SnapshotReason } from '@tabsync/shared';
import { sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { AUTH_TOKEN_RE, hashToken, parseBearer, PROFILE_ID_RE, tokenMatches } from './auth';
import { defaultConfig, type RateLimit, type ServerConfig } from './config';
import type { Db } from './db/client';
import type { SnapshotRow } from './db/schema';
import { RateLimiter } from './rate-limit';
import {
  findProfile,
  getSnapshot,
  insertSnapshot,
  latestSnapshot,
  listSnapshots,
  pruneProfile,
  registerProfile,
  type SnapshotMeta,
} from './repo';

export interface AppDeps {
  db: Db;
  config?: ServerConfig;
  /** Clock in epoch ms; injectable for tests. */
  now?: () => number;
  /** Overrides client IP detection (tests, or unusual proxies). */
  clientIp?: (c: Context) => string;
}

type Env = { Variables: { profileId: string } };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
/** Version byte + 12-byte IV + 16-byte GCM tag. */
const MIN_BLOB_BYTES = 29;

function fail(c: Context, status: ContentfulStatusCode, error: string, message: string) {
  return c.json({ error, message }, status);
}

function metaJson(row: SnapshotMeta) {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    receivedAt: row.receivedAt.toISOString(),
    kind: row.kind,
    sizeBytes: row.sizeBytes,
  };
}

function snapshotJson(row: SnapshotRow) {
  return { ...metaJson(row), blob: Buffer.from(row.blob).toString('base64url') };
}

function etagMatches(header: string | undefined, id: string): boolean {
  if (!header) return false;
  return header
    .split(',')
    .map((t) =>
      t
        .trim()
        .replace(/^W\//, '')
        .replace(/^"(.*)"$/, '$1'),
    )
    .some((t) => t === '*' || t.toLowerCase() === id.toLowerCase());
}

export function createApp({ db, config = defaultConfig, now = Date.now, clientIp }: AppDeps) {
  const app = new Hono<Env>();
  const limiter = new RateLimiter();

  const ipOf =
    clientIp ??
    ((c: Context) => {
      if (config.trustProxy) {
        const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
        if (forwarded) return forwarded;
      }
      try {
        return getConnInfo(c).remote.address ?? 'unknown';
      } catch {
        return 'unknown';
      }
    });

  const limited = (c: Context, key: string, rule: RateLimit) => {
    const result = limiter.check(key, rule, now());
    if (result.ok) return null;
    c.header('Retry-After', String(result.retryAfter));
    return fail(c, 429, 'rate_limited', 'Too many requests');
  };

  app.onError((err, c) => {
    console.error('[tabsync] unhandled error', err);
    return fail(c, 500, 'internal', 'Internal server error');
  });

  app.use('*', async (c, next) => {
    if (config.requireHttps && config.trustProxy && c.req.header('x-forwarded-proto') === 'http') {
      return fail(c, 403, 'https_required', 'Use HTTPS');
    }
    await next();
  });

  app.use(
    '*',
    cors({
      origin: (origin) => (config.allowedOrigins.includes(origin) ? origin : null),
      allowHeaders: ['Authorization', 'Content-Type', 'If-None-Match'],
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      exposeHeaders: ['ETag', 'Retry-After'],
      maxAge: 600,
    }),
  );

  app.get('/health', async (c) => {
    try {
      await db.execute(sql`select 1`);
      return c.json({ status: 'ok' });
    } catch {
      return c.json({ status: 'error', detail: 'database unavailable' }, 503);
    }
  });

  const v1 = new Hono<Env>();

  v1.use('*', async (c, next) => {
    const blocked = limited(c, `ip:${ipOf(c)}`, config.rateLimits.perIp);
    if (blocked) return blocked;
    c.header('Cache-Control', 'no-store');
    await next();
  });

  v1.use(
    '*',
    bodyLimit({
      maxSize: config.bodyLimitBytes,
      onError: (c) => fail(c, 413, 'payload_too_large', 'Request body too large'),
    }),
  );

  const readJson = async (c: Context): Promise<Record<string, unknown> | null> => {
    try {
      const body: unknown = await c.req.json();
      return typeof body === 'object' && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };

  v1.post('/profiles', async (c) => {
    const blocked = limited(c, `register:${ipOf(c)}`, config.rateLimits.register);
    if (blocked) return blocked;
    const body = await readJson(c);
    const profileId = body?.profileId;
    const authToken = body?.authToken;
    if (
      typeof profileId !== 'string' ||
      typeof authToken !== 'string' ||
      !PROFILE_ID_RE.test(profileId) ||
      !AUTH_TOKEN_RE.test(authToken)
    ) {
      return fail(c, 400, 'invalid_request', 'Expected {profileId, authToken}');
    }
    const { profile, created } = await registerProfile(db, profileId, hashToken(authToken));
    if (!tokenMatches(authToken, profile.tokenHash)) {
      return fail(c, 409, 'profile_exists', 'Profile already registered with a different token');
    }
    return c.json({ profileId }, created ? 201 : 200);
  });

  const snaps = new Hono<Env>();

  snaps.use('*', async (c, next) => {
    const bearer = parseBearer(c.req.header('Authorization'));
    const profile = bearer && (await findProfile(db, bearer.profileId));
    if (!bearer || !profile || !tokenMatches(bearer.token, profile.tokenHash)) {
      c.header('WWW-Authenticate', 'Bearer');
      return fail(c, 401, 'unauthorized', 'Unknown profile or wrong token');
    }
    const blocked = limited(c, `profile:${profile.id}`, config.rateLimits.perProfile);
    if (blocked) return blocked;
    c.set('profileId', profile.id);
    await next();
  });

  snaps.get('/latest', async (c) => {
    const row = await latestSnapshot(db, c.get('profileId'));
    if (!row) return fail(c, 404, 'no_snapshots', 'No snapshots yet');
    c.header('ETag', `"${row.id}"`);
    if (etagMatches(c.req.header('If-None-Match'), row.id)) return c.body(null, 304);
    return c.json(snapshotJson(row));
  });

  snaps.get('/', async (c) => {
    const rows = await listSnapshots(db, c.get('profileId'));
    return c.json({ snapshots: rows.map(metaJson) });
  });

  snaps.get('/:id', async (c) => {
    const id = c.req.param('id');
    const row = UUID_RE.test(id)
      ? await getSnapshot(db, c.get('profileId'), id.toLowerCase())
      : undefined;
    if (!row) return fail(c, 404, 'not_found', 'Snapshot not found');
    return c.json(snapshotJson(row));
  });

  snaps.post('/', async (c) => {
    const profileId = c.get('profileId');
    const body = await readJson(c);
    const { id, createdAt, kind, blob } = body ?? {};
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      return fail(c, 400, 'invalid_request', 'id must be a UUID');
    }
    if (
      typeof createdAt !== 'string' ||
      !ISO_RE.test(createdAt) ||
      Number.isNaN(Date.parse(createdAt))
    ) {
      return fail(c, 400, 'invalid_request', 'createdAt must be an ISO 8601 timestamp');
    }
    if (typeof kind !== 'string' || !(SNAPSHOT_REASONS as readonly string[]).includes(kind)) {
      return fail(c, 400, 'invalid_request', `kind must be one of ${SNAPSHOT_REASONS.join(', ')}`);
    }
    if (typeof blob !== 'string' || !BASE64URL_RE.test(blob)) {
      return fail(c, 400, 'invalid_request', 'blob must be base64url');
    }
    const bytes = new Uint8Array(Buffer.from(blob, 'base64url'));
    if (bytes.length < MIN_BLOB_BYTES) {
      return fail(c, 400, 'invalid_request', 'blob is too short to be a snapshot');
    }
    const receivedAt = now();
    const created = Date.parse(createdAt);
    if (created - receivedAt > config.maxClockSkewMs) {
      return fail(c, 422, 'clock_skew', 'createdAt is too far in the future');
    }

    const result = await insertSnapshot(db, {
      id: id.toLowerCase(),
      profileId,
      createdAt: new Date(created),
      receivedAt: new Date(receivedAt),
      kind: kind as SnapshotReason,
      blob: bytes,
    });
    if (result.status === 'conflict') {
      return fail(c, 409, 'id_conflict', 'Snapshot ID already in use');
    }
    if (result.status === 'created') {
      try {
        await pruneProfile(db, profileId, receivedAt);
      } catch (err) {
        // The upload succeeded; the daily sweep will catch up.
        console.error('[tabsync] pruning failed', err);
      }
    }
    return c.json(metaJson(result.row), result.status === 'created' ? 201 : 200);
  });

  v1.route('/snapshots', snaps);
  app.route('/v1', v1);

  return app;
}
