# Changelog

All notable changes to `@tabsync/server` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-22

### Added

- Hono app with `GET /health` (checks the database).
- Drizzle database client: Postgres when `DATABASE_URL` is set, otherwise PGlite.
- Migrator with paired up/down SQL files and `up` / `down [steps]` / `status` CLI.
