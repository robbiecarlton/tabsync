import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/migrate.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  clean: true,
  // shared is consumed as TypeScript source, so it must be bundled in.
  noExternal: ['@tabsync/shared'],
});
