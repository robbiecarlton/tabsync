import { mkdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import type { SQL } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as schema from './schema';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DbHandle {
  db: Db;
  close(): Promise<void>;
}

export interface DbConfig {
  /** Postgres connection string; takes precedence over PGlite when set. */
  databaseUrl?: string;
  /** PGlite data directory, or `memory://` for an in-memory database. */
  pgliteDir?: string;
}

export function createDb(config: DbConfig): DbHandle {
  if (config.databaseUrl) {
    const pool = new pg.Pool({ connectionString: config.databaseUrl });
    return { db: drizzlePg(pool, { schema }) as unknown as Db, close: () => pool.end() };
  }
  const dir = config.pgliteDir ?? 'memory://';
  // PGlite creates only the last path segment, so make sure the parents exist.
  if (!dir.includes('://')) mkdirSync(dir, { recursive: true });
  const client = new PGlite(dir);
  return { db: drizzlePglite(client, { schema }) as unknown as Db, close: () => client.close() };
}

export function dbConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DbConfig {
  return {
    databaseUrl: env.DATABASE_URL || undefined,
    pgliteDir: env.PGLITE_DIR || './.data/pglite',
  };
}

/** Runs a query and returns its rows; both PGlite and node-postgres results expose `.rows`. */
export async function queryRows<T>(db: Db, query: SQL): Promise<T[]> {
  const result = (await db.execute(query)) as unknown as { rows: T[] };
  return result.rows;
}
