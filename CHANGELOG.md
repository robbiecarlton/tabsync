# Changelog

Unified changelog for all packages. Each package also keeps its own changelog; entries here are
prefixed with the package name and version.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and each
package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **server 0.2.1:** first start on a fresh checkout failed creating the PGlite data directory.

### Added

- **extension 0.2.0:** setup (create / join with secret), capture of windows, tabs and groups,
  debounced encrypted push with retry and restart safety, popup status and Sync now, toolbar
  badge, options page with settings, reveal secret, disconnect and debug log.
- **server 0.2.0:** database schema and migration, the five sync endpoints with hashed bearer
  auth, retention pruning (after upload and daily), body cap, rate limits, CORS allow-list.
- **shared 0.2.0:** snapshot types and validation, URL normalization and capture rules,
  fingerprinting, tab/window matching, layout diffs, retention pruning and restore labels,
  and crypto helpers (secret format, HKDF, AES-GCM with AAD, gzip).

- Monorepo skeleton with npm workspaces, shared TypeScript, ESLint and Prettier config, and
  root `dev` / `build` / `test` / `typecheck` / `db:*` scripts.
- **shared 0.1.0:** package skeleton.
- **server 0.1.0:** Hono app with `GET /health`, Drizzle over PGlite or Postgres, and a
  forward-and-back migrator (`up` / `down` / `status`).
- **extension 0.1.0:** Manifest V3 build with Vite and Preact; placeholder service worker,
  popup and options page.
