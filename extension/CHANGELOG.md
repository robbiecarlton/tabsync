# Changelog

All notable changes to `@tabsync/extension` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-10-22

### Added

- Options page: create a new sync profile (secret shown once with a password-manager prompt),
  join with a secret (clear errors for malformed or unknown secrets; nothing stored on
  failure), device name and server URL (with a runtime permission request for custom
  servers), reveal secret behind a confirm, disconnect, and a debug log of the last 50 lines.
- Popup: status, device name, last push time, last error, Sync now / Retry.
- Background sync engine: captures normal windows, tabs and groups; pushes encrypted snapshots
  5 s after the last change (30 s max during continuous activity); skips unchanged
  fingerprints and empty layouts; persists pending snapshots across worker and browser
  restarts; 1-minute alarm safety net; retry with backoff; ignores session-restore churn.
- Toolbar badge for Not set up / Pending / Synced / Error.
- `optional_host_permissions` so a custom server URL can be granted per origin.

## [0.1.0] - 2026-10-22

### Added

- Manifest V3 build (Vite, Preact) with the manifest generated from `src/manifest.ts`.
- Placeholder service worker, popup and options page.
