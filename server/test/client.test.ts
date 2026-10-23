import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb, dbConfigFromEnv } from '../src/db/client';

describe('createDb with PGlite', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('creates missing parent directories for a file-backed database', async () => {
    root = mkdtempSync(path.join(tmpdir(), 'tabsync-'));
    const handle = createDb({ pgliteDir: path.join(root, 'nested', '.data', 'pglite') });
    try {
      await expect(handle.db.execute(sql`select 1`)).resolves.toBeDefined();
    } finally {
      await handle.close();
    }
  });
});

describe('dbConfigFromEnv', () => {
  it('prefers DATABASE_URL and defaults the PGlite dir', () => {
    expect(dbConfigFromEnv({ DATABASE_URL: 'postgres://x' })).toEqual({
      databaseUrl: 'postgres://x',
      pgliteDir: './.data/pglite',
    });
    expect(dbConfigFromEnv({}).databaseUrl).toBeUndefined();
  });
});
