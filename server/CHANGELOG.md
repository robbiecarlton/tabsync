# Changelog

All notable changes to `@tabsync/server` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-10-23

### Changed

- First stable release; no functional changes from the previous version.

## [0.2.1] - 2026-10-22

### Fixed

- Server failed to start on a fresh checkout because PGlite could not create
  `./.data/pglite` when `./.data` did not exist; parent directories are now created.

## [0.2.0] - 2026-10-22

### Added

- Schema and first migration (`0000_init`, with down): `profiles` and `snapshots`, including
  the server-set `received_at` and indexes on `(profile_id, created_at desc)` and
  `(profile_id, received_at desc)`.
- `POST /v1/profiles`, `GET /v1/snapshots/latest` (ETag / 304), `GET /v1/snapshots`,
  `GET /v1/snapshots/:id`, `POST /v1/snapshots` (idempotent, clock-skew check).
- Bearer auth as `<profileId>.<authToken>` with hashed tokens and constant-time comparison.
- Retention pruning after each upload and a daily sweep, protecting the latest snapshot.
- 2 MB body cap, in-memory rate limits (per IP, per profile, registrations), CORS allow-list,
  optional HTTPS enforcement behind a proxy.

## [0.1.0] - 2026-10-22

### Added

- Hono app with `GET /health` (checks the database).
- Drizzle database client: Postgres when `DATABASE_URL` is set, otherwise PGlite.
- Migrator with paired up/down SQL files and `up` / `down [steps]` / `status` CLI.
