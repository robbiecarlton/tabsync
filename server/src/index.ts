import { serve } from '@hono/node-server';
import { createApp } from './app';
import { createDb, dbConfigFromEnv } from './db/client';

const port = Number(process.env.PORT ?? 8787);
const { db, close } = createDb(dbConfigFromEnv());
const app = createApp({ db });

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`tabsync server listening on http://localhost:${info.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(async () => {
      await close();
      process.exit(0);
    });
  });
}
