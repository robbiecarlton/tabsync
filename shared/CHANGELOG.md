# Changelog

All notable changes to `@tabsync/shared` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-10-23

### Changed

- First stable release; no functional changes from the previous version.

## [0.3.0] - 2026-10-23

### Changed

- `sanitizeWindow` drops all `data:` favicon URLs, not only those over 2 KB (PLAN.md D16).

### Removed

- `MAX_DATA_FAVICON_LENGTH`.

## [0.2.0] - 2026-10-22

### Added

- Snapshot types and `parseSnapshot` runtime validation for decrypted data.
- URL rules: `isExcludedUrl`, `isNewTabUrl`, `normalizeUrlForMatching`, and
  `sanitizeWindow(s)` applying the capture rules (exclusions, New Tab placeholder, empty
  windows, unused groups, large `data:` favicons).
- `canonicalLayout` / `fingerprint` over windows, URLs, order, pinned and groups.
- `matchTabs` (multiset, exact then normalized) and `matchWindows` (greatest overlap).
- `diffLayouts` and `describeDiff` ("3 opened, 1 closed, 1 group changed").
- Retention: `selectForPruning` (tiered UTC-aligned slots, protected latest and pre-restore
  snapshots) and `resolveRestorePoints` for the restore menu.
- Crypto: secret generation and Crockford base32 formatting, HKDF key derivation,
  gzip + AES-GCM snapshot encryption with profile/time-bound AAD, token hashing.
- `@tabsync/shared/testing` fixture builders.

## [0.1.0] - 2026-10-22

### Added

- Package skeleton exporting `FORMAT_VERSION`.
