import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, queryRows, type DbHandle } from '../src/db/client';
import {
  loadMigrations,
  migrateDown,
  migrateUp,
  migrationStatus,
  type Migration,
} from '../src/db/migrator';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

async function columns(handle: DbHandle, table: string): Promise<string[]> {
  const rows = await queryRows<{ column_name: string }>(
    handle.db,
    sql`select column_name from information_schema.columns where table_name = ${table} order by column_name`,
  );
  return rows.map((r) => r.column_name);
}

describe('migrator', () => {
  let handle: DbHandle;
  let migrations: Migration[];

  beforeEach(async () => {
    handle = createDb({ pgliteDir: 'memory://' });
    migrations = await loadMigrations(path.join(fixtures, 'migrations'));
  });

  afterEach(async () => {
    await handle.close();
  });

  it('loads migrations in order and splits statements', () => {
    expect(migrations.map((m) => m.name)).toEqual(['0000_widgets', '0001_widget_name']);
    expect(migrations[0]!.up).toHaveLength(2);
    expect(migrations[0]!.down).toHaveLength(2);
  });

  it('rejects a migration without a down file', async () => {
    await expect(loadMigrations(path.join(fixtures, 'missing-down'))).rejects.toThrow(
      /0000_orphan has no 0000_orphan.down.sql/,
    );
  });

  it('applies all pending migrations once', async () => {
    expect(await migrateUp(handle.db, migrations)).toEqual(['0000_widgets', '0001_widget_name']);
    expect(await columns(handle, 'widgets')).toEqual(['id', 'name']);
    expect(await migrateUp(handle.db, migrations)).toEqual([]);
  });

  it('rolls back one step at a time, newest first', async () => {
    await migrateUp(handle.db, migrations);

    expect(await migrateDown(handle.db, migrations)).toEqual(['0001_widget_name']);
    expect(await columns(handle, 'widgets')).toEqual(['id']);

    expect(await migrateDown(handle.db, migrations)).toEqual(['0000_widgets']);
    expect(await columns(handle, 'widgets')).toEqual([]);

    expect(await migrateDown(handle.db, migrations)).toEqual([]);
  });

  it('round-trips up -> down -> up', async () => {
    await migrateUp(handle.db, migrations);
    await migrateDown(handle.db, migrations, migrations.length);
    expect(await migrateUp(handle.db, migrations)).toHaveLength(2);
    expect(await columns(handle, 'widgets')).toEqual(['id', 'name']);
  });

  it('reports status', async () => {
    await migrateUp(handle.db, migrations.slice(0, 1));
    expect(await migrationStatus(handle.db, migrations)).toEqual([
      { name: '0000_widgets', applied: true },
      { name: '0001_widget_name', applied: false },
    ]);
  });

  it('rolls back a failed migration atomically', async () => {
    const broken: Migration[] = [
      { name: '0000_broken', up: ['create table t (id text)', 'not valid sql'], down: [] },
    ];
    await expect(migrateUp(handle.db, broken)).rejects.toThrow();
    expect(await columns(handle, 't')).toEqual([]);
    expect(await migrationStatus(handle.db, broken)).toEqual([
      { name: '0000_broken', applied: false },
    ]);
  });
});

describe('project migrations', () => {
  it('every migration in server/migrations round-trips', async () => {
    const handle = createDb({ pgliteDir: 'memory://' });
    try {
      const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
      const migrations = await loadMigrations(dir);
      await migrateUp(handle.db, migrations);
      await migrateDown(handle.db, migrations, migrations.length);
      expect(await migrateUp(handle.db, migrations)).toHaveLength(migrations.length);
    } finally {
      await handle.close();
    }
  });
});
