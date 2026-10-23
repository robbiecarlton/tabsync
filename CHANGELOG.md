# Changelog

Unified changelog for all packages. Each package also keeps its own changelog; entries here are
prefixed with the package name and version.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and each
package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
