# Build Plan

Companion to `SPEC.md`. Records the build order and decisions that refine or deviate from the spec.

## Decisions (2026-10-22)

| #   | Topic                 | Decision                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Migrations            | drizzle-kit generates `up` SQL from the schema; each migration gets a hand-written `down.sql`. A small custom migrator (`up` / `down` / `status`) runs against both PGlite and `pg`. A test applies up → down → up.                                                                                                                                                                                                 |
| D2  | Pre-restore snapshots | Uploaded (so undo is in shared history) but `GET /v1/snapshots/latest` ignores `kind = 'pre-restore'`. After applying another device's snapshot, base = that snapshot and nothing is pushed. After a history restore, the resulting state is pushed as a new `manual` snapshot so other devices see Behind.                                                                                                         |
| D3  | Ordering              | Add server-set `received_at timestamptz not null default now()` to `snapshots`; "latest" is ordered by `received_at`. Client `createdAt` remains the AAD, display time and retention key. Index `(profile_id, received_at desc)` added.                                                                                                                                                                             |
| D4  | Join                  | "Join with a secret" never registers. It derives credentials and checks the server; an unknown profile gives "No sync profile found for this secret" and nothing is written locally. Only "Create new profile" calls `POST /v1/profiles`.                                                                                                                                                                           |
| D5  | History device names  | Device names are encrypted, so the popup fetches and decrypts the (≤ 8) snapshots the labels resolve to, cached by snapshot ID.                                                                                                                                                                                                                                                                                     |
| D6  | Retention horizon     | Weekly slots extend to 1 year + 1 week (not exactly 1 year), otherwise the "1 year ago" label could almost never resolve. Known effect of the spec's tiering: at a tier boundary the first minutes after an idle gap can be pruned in favour of a newer snapshot in the same slot, so a label may land just before the gap (e.g. Friday evening rather than Monday 09:10). Lost activity is always within one slot. |
| D7  | Blob layout           | `version byte (1) + 12-byte IV + AES-GCM ciphertext` (spec: IV + ciphertext). The version byte allows algorithm changes later. Plaintext is always gzipped. AAD is `tabsync/v1\|<profileId>\|<createdAt as epoch ms>`, so it survives the server re-serializing timestamps; decrypt also checks the snapshot ID matches the server record.                                                                          |
| D8  | Auth header           | `Authorization: Bearer <profileId>.<authToken>` (spec: token only). The server looks up the profile by ID, then compares token hashes in constant time; with the token alone there would be nothing to compare. Unknown profile and wrong token both give 401.                                                                                                                                                      |
| D9  | API wire format       | JSON throughout; blobs are base64url strings. Missing latest snapshot is 404 `no_snapshots`. Uploads more than 10 min in the future are 422 `clock_skew`.                                                                                                                                                                                                                                                           |
| D10 | Empty layouts         | The extension never pushes a layout with zero windows (after exclusions). On macOS closing the last window leaves the browser running, and quitting fires removal events; publishing an empty snapshot would invite the other machine to close everything.                                                                                                                                                          |
| D11 | Join baseline         | After joining, the device records its current layout fingerprint but no base snapshot, and pushes nothing until its layout changes. With no base, milestone 4 will show the server's latest as Behind and offer Apply. Fresh browser sessions (detected via an empty `chrome.storage.session`) ignore tab events for 10 s, then flush only if the layout differs from the last push.                                |

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
