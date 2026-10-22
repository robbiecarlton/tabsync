# @tabsync/server

The sync backend: a stateless Hono service that stores encrypted snapshot blobs. It never sees
tab data. See `SPEC.md` → "Server API and schema".

## Running

```sh
cp .env.example .env    # optional; defaults work for local dev
npm run dev -w server   # applies migrations, then serves on http://localhost:8787 with reload
```

Without `DATABASE_URL` the server uses file-backed [PGlite](https://pglite.dev) in
`./.data/pglite`, so no Postgres or Docker is needed locally. Set `DATABASE_URL` to use real
Postgres (as on Railway).

| Variable         | Default          | Meaning                                      |
| ---------------- | ---------------- | -------------------------------------------- |
| `DATABASE_URL`   | unset            | Postgres connection string; overrides PGlite |
| `PGLITE_DIR`     | `./.data/pglite` | PGlite data dir; `memory://` for in-memory   |
| `PORT`           | `8787`           | HTTP port                                    |
| `MIGRATIONS_DIR` | `./migrations`   | Override where migration files are read from |

Production: `npm run build -w server`, then `npm run migrate:prod -w server -- up` and
`npm start -w server`.

## Migrations

Migrations can be rolled forward and back. Workflow for a schema change:

1. Edit `src/db/schema.ts`.
2. `npm run db:generate -w server`: drizzle-kit writes `migrations/NNNN_name.sql`.
3. Write `migrations/NNNN_name.down.sql` by hand to undo it. Separate statements with
   `--> statement-breakpoint` as drizzle-kit does. The migrator refuses to load a migration
   without its down file.
4. `npm test -w server`: a test applies every migration up → down → up.

| Command                               | Does                                  |
| ------------------------------------- | ------------------------------------- |
| `npm run migrate -w server -- up`     | Apply all pending migrations          |
| `npm run migrate -w server -- down`   | Roll back the latest (`down 3` for 3) |
| `npm run migrate -w server -- status` | Show applied / pending                |

Each migration runs in a transaction and is recorded in the `_migrations` table.

## Tests

```sh
npm test -w server
```

Tests run against in-memory PGlite and call the app through Hono's `app.request()`, so no server
process or database is needed.
