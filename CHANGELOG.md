# Changelog

Unified changelog for all packages. Each package also keeps its own changelog; entries here are
prefixed with the package name and version.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and each
package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.0.0] - 2026-10-23

The v2 roadmap from `SPEC.md`, except link preview images (deferred). Project milestone:
package versions follow semver independently (no breaking changes), and are now **shared
1.2.0**, **server 1.0.0** and **extension 1.4.0**.

### Added

- **shared 1.2.0 / extension 1.4.0:** user exclude list (v2).
- **shared 1.1.0 / extension 1.3.0:** diffs: compare snapshots, or a snapshot with what's open
  now (opened / closed / moved), from the snapshot browser and the popup (v2).
- **extension 1.2.1:** the snapshot browser focuses tabs that are already open instead of
  duplicating them.
- **extension 1.2.0:** snapshot browser with open-tab and open-group (v2).
- **extension 1.1.0:** favicons via the `_favicon` API with a stored-URL fallback (v2).

## [1.0.0] - 2026-10-23

First stable release: the MVP from `SPEC.md`, deployed on Railway. **shared**, **server**
and **extension** are all 1.0.0.

### Added

- **extension 0.4.0:** conflict detection (including a pre-push check) with Merge / Keep mine
  / Take theirs, and a history list with restore and undo.
- **extension 0.3.0:** pull and Behind detection, Apply with add-missing / match-exactly,
  reconcile of windows, tabs, pinned tabs and groups with unloaded tabs, pre-restore undo
  snapshot, echo suppression.
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

### Changed

- Node 22.12+ is required (Vitest and Vite need it), and `engines` now says so; npm warns at
  install on older versions.
- **extension 0.6.0:** defaults to the deployed Railway server.
- `DEPLOY.md` describes the default server URL instead of the pending code change.
- **shared 0.3.0 / extension 0.5.1:** snapshots no longer store `data:` favicons; clearer
  size-limit error message.
- **extension 0.5.0:** icon; an unreachable server shows Pending then Error after 5 minutes;
  persistent failures retry every 5 minutes; clearer error messages.
- Root README links the Railway deployment guide (`DEPLOY.md`).

### Fixed

- **extension 0.6.1:** applying touches only tabs and groups that changed; collapsed groups no
  longer flicker open.
- **extension 0.3.1:** Apply failed with "Invalid value for state" when opening a window for a
  maximized snapshot window; one unopenable URL no longer aborts an apply.
- **server 0.2.1:** first start on a fresh checkout failed creating the PGlite data directory.
