# Tab Sync

A personal Brave/Chromium extension that syncs tabs, pinned tabs and tab groups between machines
through an end-to-end encrypted snapshot store. See [`SPEC.md`](SPEC.md) for the design and
[`PLAN.md`](PLAN.md) for the build plan and decisions.

## Layout

| Package                    | What                                                                      | Version / changelog                                |
| -------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------- |
| [`shared/`](shared/)       | Snapshot types, crypto, fingerprinting, retention (used by both others)   | [`shared/CHANGELOG.md`](shared/CHANGELOG.md)       |
| [`server/`](server/)       | Hono + Drizzle encrypted blob store (PGlite locally, Postgres on Railway) | [`server/CHANGELOG.md`](server/CHANGELOG.md)       |
| [`extension/`](extension/) | Manifest V3 extension (TypeScript, Vite, Preact)                          | [`extension/CHANGELOG.md`](extension/CHANGELOG.md) |

Each package is versioned independently with semver. [`CHANGELOG.md`](CHANGELOG.md) at the root
is the unified changelog across all packages.

## Getting started

Requires Node 20+ (see `.nvmrc`).

```sh
npm install
npm run dev        # server on http://localhost:8787 + extension rebuild on change
```

Then load the extension: open `brave://extensions`, enable Developer mode, click **Load
unpacked** and pick `extension/dist`. After a rebuild, click the reload icon on the extension card.

## Commands (from the repo root)

| Command               | Does                                             |
| --------------------- | ------------------------------------------------ |
| `npm run dev`         | Run the server (watch) and rebuild the extension |
| `npm run build`       | Production build of server and extension         |
| `npm test`            | Unit tests in every package (Vitest)             |
| `npm run typecheck`   | `tsc --noEmit` in every package                  |
| `npm run lint`        | ESLint                                           |
| `npm run format`      | Prettier (write); `format:check` to verify       |
| `npm run db:migrate`  | Apply pending DB migrations                      |
| `npm run db:rollback` | Roll back the most recent migration              |
| `npm run db:status`   | List migrations and whether each is applied      |

Run a single package's tests with e.g. `npm test -w server`.

## Deploying

The server runs on Railway with Railway Postgres. See [`DEPLOY.md`](DEPLOY.md) for setup,
variables, migrations on deploy, pointing the extension at it, and operations.

## Note on npm versions

npm 10 crashes (`Cannot read properties of null (reading 'edgesOut')`) when resolving Vitest 5's
optional peer dependencies. Installing from the existing lockfile works fine; when **adding** a
dependency, use npm 11: `npx npm@11 install <pkg> -w <package>`.
