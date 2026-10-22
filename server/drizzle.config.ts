import { defineConfig } from 'drizzle-kit';

// Used only for `drizzle-kit generate`; migrations are applied by src/db/migrator.ts.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './migrations',
});
