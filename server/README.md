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

| Variable          | Default          | Meaning                                                 |
| ----------------- | ---------------- | ------------------------------------------------------- |
| `DATABASE_URL`    | unset            | Postgres connection string; overrides PGlite            |
| `PGLITE_DIR`      | `./.data/pglite` | PGlite data dir; `memory://` for in-memory              |
| `PORT`            | `8787`           | HTTP port                                               |
| `MIGRATIONS_DIR`  | `./migrations`   | Override where migration files are read from            |
| `ALLOWED_ORIGINS` | none             | Comma-separated CORS origins (see `.env.example`)       |
| `TRUST_PROXY`     | off              | Use `X-Forwarded-For` / `-Proto` (set on Railway)       |
| `REQUIRE_HTTPS`   | off              | With `TRUST_PROXY`, refuse requests that came over HTTP |

Production: `npm run build -w server`, then `npm run migrate:prod -w server -- up` and
`npm start -w server`.

## API

All `/v1/snapshots*` requests need `Authorization: Bearer <profileId>.<authToken>` (PLAN.md D8).
The server stores only SHA-256 of the token and compares in constant time. Unknown profile and
wrong token both return 401. Errors are JSON: `{ "error": "<code>", "message": "..." }`.

| Method | Path                   | Purpose                                                                                                                                                                                                      |
| ------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| POST   | `/v1/profiles`         | Register `{profileId, authToken}`. 201 created, 200 if already registered with the same token, 409 if with a different token.                                                                                |
| GET    | `/v1/snapshots/latest` | Newest non-`pre-restore` snapshot by receipt time, with blob. `ETag: "<id>"`; `If-None-Match` → 304. 404 if none yet.                                                                                        |
| GET    | `/v1/snapshots`        | `{snapshots: [...]}` metadata, newest `createdAt` first, all kinds, no blobs.                                                                                                                                |
| GET    | `/v1/snapshots/:id`    | One snapshot with blob.                                                                                                                                                                                      |
| POST   | `/v1/snapshots`        | Upload `{id, createdAt, kind, blob}`. 201 stored, 200 if this ID is already stored (safe retry), 409 if another profile owns the ID, 422 if `createdAt` is over 10 min ahead. Prunes the profile afterwards. |
| GET    | `/health`              | `{status: "ok"}`, or 503 if the database is down.                                                                                                                                                            |

Snapshot JSON: `{id, createdAt, receivedAt, kind, sizeBytes, blob?}` with `blob` in base64url
(`version byte + IV + ciphertext`, see PLAN.md D7).

Limits (in `src/config.ts`): 2 MB request bodies; 300 requests/min per IP; 120/min per
profile; 20 registrations/hour per IP. Rate limits are in memory (one process).

**Retention:** after every upload the profile is pruned with `selectForPruning` from
`@tabsync/shared`; the current latest is always protected. A sweep over all profiles runs at
startup and every 24 hours.

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
