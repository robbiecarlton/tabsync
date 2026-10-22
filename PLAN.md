# Build Plan

Companion to `SPEC.md`. Records the build order and decisions that refine or deviate from the spec.

## Decisions (2026-10-22)

| #   | Topic                 | Decision                                                                                                                                                                                                                                                                                                    |
| --- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Migrations            | drizzle-kit generates `up` SQL from the schema; each migration gets a hand-written `down.sql`. A small custom migrator (`up` / `down` / `status`) runs against both PGlite and `pg`. A test applies up → down → up.                                                                                         |
| D2  | Pre-restore snapshots | Uploaded (so undo is in shared history) but `GET /v1/snapshots/latest` ignores `kind = 'pre-restore'`. After applying another device's snapshot, base = that snapshot and nothing is pushed. After a history restore, the resulting state is pushed as a new `manual` snapshot so other devices see Behind. |
| D3  | Ordering              | Add server-set `received_at timestamptz not null default now()` to `snapshots`; "latest" is ordered by `received_at`. Client `createdAt` remains the AAD, display time and retention key. Index `(profile_id, received_at desc)` added.                                                                     |
| D4  | Join                  | "Join with a secret" never registers. It derives credentials and checks the server; an unknown profile gives "No sync profile found for this secret" and nothing is written locally. Only "Create new profile" calls `POST /v1/profiles`.                                                                   |
| D5  | History device names  | Device names are encrypted, so the popup fetches and decrypts the (≤ 8) snapshots the labels resolve to, cached by snapshot ID.                                                                                                                                                                             |

## Tooling

- npm workspaces: `shared/`, `server/`, `extension/` (pnpm not installed; npm workspaces suffice)
- TypeScript, Vitest, ESLint, Prettier
- Server: Hono, Drizzle, PGlite (local/tests), `pg` (Railway)
- Extension: Vite MV3 build, Preact for popup/options
- Each package has its own semver version, `CHANGELOG.md` and `README.md`; the root has a unified `CHANGELOG.md` and `README.md`

## Milestones

Finish and test each before starting the next.

0. **Skeleton.** Workspace, root scripts (`dev`, `test`, `build`, `typecheck`), server with `GET /health` + DB connection + migrator, extension shell (empty worker, popup, options), changelogs and READMEs.
1. **Shared core.** Types + runtime validation, URL normalization/exclusion, fingerprint, multiset + window matching, diff summary, retention (prune + label resolution, simulated-year test), crypto (HKDF, AES-GCM with AAD, gzip, base32 secret).
2. **Server.** Five endpoints, bearer auth (constant-time), 2 MB cap, in-memory rate limits, pruning after insert + daily sweep. Tests on in-memory PGlite via `app.request()`.
3. **Extension capture and push.** Pure logic behind a thin `chrome.*` adapter (mocked in tests). Setup flow, capture, debounce state machine (5 s / 30 s max / alarm flush), startup settle, encrypt + push, badge.
4. **Pull and apply.** Behind detection, Apply with two modes, reconcile as pure planner (current + target → ops) + executor, unloaded tabs, echo suppression, pre-restore.
5. **Conflicts and history.** `parentSnapshotId` conflict detection, conflict UI, history labels + restore.
6. **Deploy.** Railway service + Postgres, migrations on deploy, two-machine checklist (run by the user).
7. **Polish.** Debug log, error messages, retry behaviour.
