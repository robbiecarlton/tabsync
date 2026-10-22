import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { createDb, type DbHandle } from '../src/db/client';

describe('GET /health', () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = createDb({ pgliteDir: 'memory://' });
  });

  afterEach(async () => {
    await handle.close().catch(() => {});
  });

  it('returns ok when the database responds', async () => {
    const res = await createApp({ db: handle.db }).request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('returns 503 when the database is unavailable', async () => {
    const app = createApp({ db: handle.db });
    await handle.close();
    const res = await app.request('/health');
    expect(res.status).toBe(503);
  });
});
