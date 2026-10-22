import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import type { Db } from './db/client';

export interface AppDeps {
  db: Db;
}

export function createApp({ db }: AppDeps) {
  const app = new Hono();

  app.get('/health', async (c) => {
    try {
      await db.execute(sql`select 1`);
      return c.json({ status: 'ok' });
    } catch {
      return c.json({ status: 'error', detail: 'database unavailable' }, 503);
    }
  });

  return app;
}
