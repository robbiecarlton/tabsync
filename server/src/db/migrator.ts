import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { queryRows, type Db } from './client';

/**
 * Forward-and-back migrations. drizzle-kit generates `NNNN_name.sql` (up); each one needs a
 * hand-written `NNNN_name.down.sql` beside it. Statements are separated by drizzle-kit's
 * `--> statement-breakpoint` marker. Applied migrations are tracked in `_migrations`.
 */

const BREAKPOINT = '--> statement-breakpoint';

export interface Migration {
  name: string;
  up: string[];
  down: string[];
}

export interface MigrationStatus {
  name: string;
  applied: boolean;
}

function splitStatements(source: string): string[] {
  return source
    .split(BREAKPOINT)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function loadMigrations(dir: string): Promise<Migration[]> {
  const files = await readdir(dir);
  const ups = files.filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql')).sort();
  return Promise.all(
    ups.map(async (file) => {
      const name = file.slice(0, -'.sql'.length);
      const downFile = `${name}.down.sql`;
      if (!files.includes(downFile)) {
        throw new Error(`Migration ${name} has no ${downFile}`);
      }
      const [up, down] = await Promise.all([
        readFile(path.join(dir, file), 'utf8'),
        readFile(path.join(dir, downFile), 'utf8'),
      ]);
      return { name, up: splitStatements(up), down: splitStatements(down) };
    }),
  );
}

async function ensureTable(db: Db): Promise<void> {
  await db.execute(
    sql.raw(
      'create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())',
    ),
  );
}

async function appliedNames(db: Db): Promise<string[]> {
  const rows = await queryRows<{ name: string }>(
    db,
    sql.raw('select name from _migrations order by name'),
  );
  return rows.map((r) => r.name);
}

/** Applies all pending migrations in order. Returns the names applied. */
export async function migrateUp(db: Db, migrations: Migration[]): Promise<string[]> {
  await ensureTable(db);
  const applied = new Set(await appliedNames(db));
  const ran: string[] = [];
  for (const m of migrations) {
    if (applied.has(m.name)) continue;
    await db.transaction(async (tx) => {
      for (const stmt of m.up) await tx.execute(sql.raw(stmt));
      await tx.execute(sql`insert into _migrations (name) values (${m.name})`);
    });
    ran.push(m.name);
  }
  return ran;
}

/** Rolls back the most recent `steps` applied migrations. Returns the names rolled back. */
export async function migrateDown(db: Db, migrations: Migration[], steps = 1): Promise<string[]> {
  await ensureTable(db);
  const byName = new Map(migrations.map((m) => [m.name, m]));
  const toRevert = (await appliedNames(db)).reverse().slice(0, steps);
  for (const name of toRevert) {
    const m = byName.get(name);
    if (!m) throw new Error(`Applied migration ${name} not found on disk`);
    await db.transaction(async (tx) => {
      for (const stmt of m.down) await tx.execute(sql.raw(stmt));
      await tx.execute(sql`delete from _migrations where name = ${name}`);
    });
  }
  return toRevert;
}

export async function migrationStatus(db: Db, migrations: Migration[]): Promise<MigrationStatus[]> {
  await ensureTable(db);
  const applied = new Set(await appliedNames(db));
  return migrations.map((m) => ({ name: m.name, applied: applied.has(m.name) }));
}
