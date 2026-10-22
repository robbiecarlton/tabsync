import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, dbConfigFromEnv } from './db/client';
import { loadMigrations, migrateDown, migrateUp, migrationStatus } from './db/migrator';

// Lives directly in src/ (and dist/ after build) so `../migrations` resolves in both.
const migrationsDir =
  process.env.MIGRATIONS_DIR ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

const [command = 'up', stepsArg] = process.argv.slice(2);
const { db, close } = createDb(dbConfigFromEnv());

try {
  const migrations = await loadMigrations(migrationsDir);
  if (command === 'up') {
    const ran = await migrateUp(db, migrations);
    console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'No pending migrations');
  } else if (command === 'down') {
    const reverted = await migrateDown(db, migrations, stepsArg ? Number(stepsArg) : 1);
    console.log(reverted.length ? `Rolled back: ${reverted.join(', ')}` : 'Nothing to roll back');
  } else if (command === 'status') {
    for (const s of await migrationStatus(db, migrations)) {
      console.log(`${s.applied ? '[x]' : '[ ]'} ${s.name}`);
    }
  } else {
    console.error(`Unknown command "${command}". Use: up | down [steps] | status`);
    process.exitCode = 1;
  }
} finally {
  await close();
}
