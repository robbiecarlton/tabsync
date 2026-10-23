import { serve } from '@hono/node-server';
import { createApp } from './app';
import { configFromEnv } from './config';
import { createDb, dbConfigFromEnv } from './db/client';
import { pruneAll } from './repo';

const DAY = 24 * 60 * 60 * 1000;

const port = Number(process.env.PORT ?? 8787);
const { db, close } = createDb(dbConfigFromEnv());
const app = createApp({ db, config: configFromEnv() });

const sweep = () =>
  pruneAll(db, Date.now())
    .then((n) => n > 0 && console.log(`[tabsync] daily sweep pruned ${n} snapshots`))
    .catch((err) => console.error('[tabsync] daily sweep failed', err));
void sweep();
const sweepTimer = setInterval(sweep, DAY);

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`tabsync server listening on http://localhost:${info.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(sweepTimer);
    server.close(async () => {
      await close();
      process.exit(0);
    });
  });
}
