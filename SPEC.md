# Brave Tab Sync — Project Spec

Oct 22, 2026 · @R

## Overview

Build a personal Brave/Chromium extension that keeps the same tabs, pinned tabs and tab groups across machines, with an end-to-end encrypted backend on Railway and a tiered history of snapshots that can be restored.

**Model:** snapshot-based, not live mirroring. The machine in use pushes its full window/tab layout; the other machine notices it is behind and asks before applying. Each Brave profile installs the extension separately and uses its own secret, so profiles never mix.

**Using this spec with Claude Code:** put it in the repo as `SPEC.md` and ask Claude Code to follow the build order at the end, one milestone at a time, with tests at each step. MVP is everything except the Roadmap section.

**Repo layout:** a monorepo with `extension/` (Manifest V3, TypeScript), `server/` (Node, TypeScript) and `shared/` (snapshot types, crypto helpers, retention logic, shared by both).

## Architecture and tech stack

The server is a dumb, encrypted blob store; all tab logic (capture, diff, reconcile, restore) lives in the extension.

| Part | Choice | Notes |
| --- | --- | --- |
| Extension | Manifest V3, TypeScript, Vite build | Loaded unpacked in Brave developer mode; no store listing needed |
| Extension UI | Popup + options page | Plain TS or a small framework (Preact/Svelte), Claude Code's choice |
| Server | Node, TypeScript, Hono (or Fastify) | Stateless; one process |
| DB layer | Drizzle ORM | Same schema and queries for PGlite and Postgres |
| Local DB | PGlite | In-process, file-backed, no Docker needed |
| Production DB | Railway Postgres | Connection via `DATABASE_URL` |
| Hosting | Railway service from the repo | Migrations run on deploy |
| Crypto | Web Crypto API (in the extension) | HKDF, AES-GCM; no crypto libraries |
| Tests | Vitest | Shared logic and server; extension logic tested against a mocked `chrome.*` API |

Extension permissions: `tabs`, `tabGroups`, `storage`, `alarms`, `favicon` (for the v2 favicon API), plus host permission for the server's URL only. No `<all_urls>` until the v2 link-preview work.

## Security and encryption model

One random secret per profile; the server can authenticate writes but can never read tab data or profile names.

1. **Profile secret.** 32 random bytes, generated in the extension on "Create new profile", shown once as a copyable string (base32 or a word list) with a prompt to save it in a password manager. The other machine joins with "I have a secret".
2. **Key derivation.** HKDF-SHA256 from the secret, with distinct `info` labels, produces three values:
   - `profileId` — public identifier sent to the server
   - `authToken` — sent as a bearer token; the server stores only its SHA-256 hash
   - `encKey` — AES-GCM 256 key, non-extractable, never leaves the extension
3. **Encryption.** Each snapshot is serialized to JSON, optionally compressed (CompressionStream gzip), then encrypted with AES-GCM and a fresh 12-byte random IV per snapshot. The server stores `iv + ciphertext`.
4. **Integrity binding.** Pass `profileId` and the snapshot's `createdAt` as AES-GCM additional authenticated data, so the server can't swap blobs between profiles or times undetected.
5. **Secret storage.** `chrome.storage.local` only, never `chrome.storage.sync`. Options page can re-reveal the secret after a confirm step.

**Visible to the server:** profile IDs, timestamps, blob sizes, request timing. **Not visible:** URLs, titles, groups, device names, profile names.

**Accepted risk:** a lost secret means unrecoverable data. No key rotation in v1.

**Server hygiene:** constant-time token comparison, request body cap (e.g. 2 MB), per-profile and per-IP rate limiting, HTTPS only (Railway provides it), CORS restricted to the extension origin.

## Snapshot data format

A snapshot is the full layout of every normal (non-private) window, versioned from day one so v2 previews can be added without migration.

```typescript
interface Snapshot {
  formatVersion: 1;
  snapshotId: string;          // random UUID
  parentSnapshotId?: string;   // the snapshot this device last synced from (conflict detection)
  createdAt: string;           // ISO timestamp
  device: { id: string; name: string };  // e.g. "Desk iMac"
  reason: 'auto' | 'pre-restore' | 'manual';
  windows: SnapWindow[];
}

interface SnapWindow {
  focused: boolean;
  state?: 'normal' | 'maximized' | 'minimized' | 'fullscreen';
  bounds?: { left: number; top: number; width: number; height: number };
  groups: SnapGroup[];
  tabs: SnapTab[];             // in strip order; pinned tabs first
}

interface SnapGroup {
  key: string;                 // local to this snapshot, e.g. "g1"
  title: string;
  color: chrome.tabGroups.ColorEnum;
  collapsed: boolean;
}

interface SnapTab {
  url: string;
  title: string;
  pinned: boolean;
  groupKey?: string;           // references SnapGroup.key
  active: boolean;
  favIconUrl?: string;         // fallback only; skip data: URLs over ~2 KB
  previewRef?: string;         // v2: reference to separately stored preview data
}
```

**Rules:**

- Browser IDs (tab, window, group) are never stored; they are meaningless on another machine.
- Excluded URLs: `brave://`, `chrome://`, `chrome-extension://`, `devtools://`, `about:` (except `about:blank`), `view-source:`, and `file://` (can't reliably be reopened). New Tab pages are kept as a single placeholder only if they are the only tab in a window.
- **Change fingerprint:** a hash over windows, tab URLs, order, pinned and group membership/properties. Title, favicon and active-tab changes do not alter it, so they never trigger a push.
- If the fingerprint matches the latest stored snapshot, don't create or upload a new one.

## Sync behaviour and decisions

The active machine pushes; the idle machine detects it is behind and asks before changing anything.

**Pushing**

- Listen to `tabs.onCreated`, `onRemoved`, `onUpdated` (URL and pinned only), `onMoved`, `onAttached`, `onDetached`, `tabGroups.onCreated/onUpdated/onRemoved`, `windows.onCreated/onRemoved`.
- Debounce: push 5 seconds after the last change, with a maximum wait of 30 seconds during continuous activity.
- MV3 service workers sleep, so store pending state in `chrome.storage.local` and use a `chrome.alarms` alarm (every 1 minute) as a safety net to flush and check status.
- Offline or server error: keep the latest unsent snapshot locally, retry with backoff, show "pending" status.

**Pulling**

- Check the server for the latest snapshot on browser startup, on window focus (throttled to once per 30 seconds), on popup open, and on the 1-minute alarm.
- Echo suppression: while applying a remote snapshot, set an `applying` flag and ignore tab events; afterwards record the applied snapshot as this device's base and compute the fingerprint so the result isn't pushed back as a change.

**Decisions**

| # | Topic | Behaviour |
| --- | --- | --- |
| 1 | Windows | Sync all normal windows; recreate them as separate windows. Private windows are never captured |
| 2 | Applying remote state | Never automatic. Badge shows "behind"; popup offers Apply, with a summary of what changes |
| 3 | Undo | Before any restore or apply, save a `pre-restore` snapshot of the current state |
| 4 | Closing tabs | Per-restore choice: "Add missing only" or "Make it match exactly". Defaults to Add missing only on first use, then remembers the last choice (stored per device) |
| 5 | Conflicts | If this device has unpushed changes since its base snapshot AND the server has a newer snapshot from another device, show a diff of the two and let the user choose: keep mine (push), take theirs (apply), or merge (add missing) |
| 6 | Loading | Restored tabs open unloaded (create, then `tabs.discard`), except the previously active tab in each window |
| 7 | Exclusions | Internal pages skipped (see format). User exclude list is v2 |
| 8 | Noise | Only URL, order, pinned and group changes count; identical snapshots aren't stored |
| 9 | Secret storage | `chrome.storage.local`, shown once with a password-manager prompt |
| 10 | Server hygiene | Hashed tokens, size cap, rate limits |

**Reconcile algorithm (apply / restore)**

1. Save a `pre-restore` snapshot.
2. Match target windows to current windows (by best URL overlap; unmatched target windows become new windows).
3. Within each window, match tabs by normalized URL as a multiset (duplicates count separately). Normalization for matching only: strip `#fragment` and common tracking parameters (`utm_*`, `fbclid`, `gclid`).
4. Create missing tabs (unloaded), then move tabs into target order: pinned first, then the rest.
5. Rebuild groups: `tabs.group()` the right tabs, then `tabGroups.update()` title, colour, collapsed. Grouped tabs must be contiguous.
6. In "match exactly" mode, close unmatched tabs last, never closing a window's last tab before its replacement exists.
7. Clear the `applying` flag, record the new base snapshot.

## Snapshot retention schedule

Keep a thinning history of about 170 snapshots per profile, so the restore menu can always offer one near each of: 1 minute, 10 minutes, 1 hour, 1 day, 3 days, 1 week, 1 month, 1 year ago.

| Age of snapshot | Keep |
| --- | --- |
| Under 1 hour | One per minute |
| 1 hour to 1 day | One per hour |
| 1 day to 1 month | One per day |
| 1 month to 1 year | One per week |
| Over 1 year | Delete |

**Pruning rule:** for each tier, divide its age range into slots of that tier's size (aligned to UTC clock boundaries so slots don't drift). In each slot keep the **newest** snapshot and delete the rest. Pruning uses only `created_at`, so it runs on the server without decrypting anything: after each insert for that profile, plus a daily sweep.

**Never pruned by the tiers:** the latest snapshot, and `pre-restore` snapshots for 30 days (so a restore is always undoable).

**Restore menu:** for each label, show the newest snapshot at least that old, with its real timestamp and device name ("1 day ago · Tue 14:32 · Laptop"). Labels with no qualifying snapshot are hidden. History only exists while the browser is in use, so "1 day ago" means the last state before that point.

The retention logic lives in `shared/` with unit tests that simulate a year of snapshots at irregular times and assert each label resolves sensibly.

## Server API and schema

Two tables and five endpoints; every request except registration carries `Authorization: Bearer <authToken>` and is scoped to that profile.

**Schema (Drizzle, Postgres/PGlite)**

```sql
profiles (
  id            text primary key,      -- profileId (derived)
  token_hash    text not null,         -- sha256(authToken)
  created_at    timestamptz not null default now()
)

snapshots (
  id            uuid primary key,      -- snapshotId (client-generated)
  profile_id    text not null references profiles(id) on delete cascade,
  created_at    timestamptz not null,  -- client timestamp, also bound as AAD
  kind          text not null,         -- 'auto' | 'pre-restore' | 'manual'
  blob          bytea not null,        -- iv + ciphertext
  size_bytes    integer not null
)
index on snapshots (profile_id, created_at desc)
```

`kind` is stored in plaintext so pruning can protect `pre-restore` snapshots; it reveals nothing about tabs.

**Endpoints**

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/v1/profiles` | Register `{profileId, authToken}`; idempotent if the hash matches, 409 if the ID exists with a different token |
| GET | `/v1/snapshots/latest` | Latest snapshot's metadata + blob. Supports `If-None-Match` with the snapshot ID → 304, keeping polls cheap |
| GET | `/v1/snapshots` | Metadata list (id, created\_at, kind, size), newest first, for the history UI |
| GET | `/v1/snapshots/:id` | One snapshot's blob |
| POST | `/v1/snapshots` | Upload `{id, createdAt, kind, blob}`; triggers pruning for this profile |

Plus `GET /health` for Railway. Optional later: `DELETE /v1/profiles/me` to wipe a profile.

Uploads of an already-stored snapshot ID return 200 (safe retries). Clock skew: the server rejects `createdAt` more than 10 minutes in the future.

## Extension UI

Sync status is visible at a glance on the toolbar badge; everything else lives in the popup and the options page.

**Toolbar badge**

| State | Badge | Meaning |
| --- | --- | --- |
| Synced | Green dot | Local state matches the latest server snapshot |
| Pending | Grey dot | Local changes waiting to push (debounce or offline) |
| Behind | Blue "!" | A newer snapshot from another device is available |
| Conflict | Amber "!" | Both sides changed (decision 5) |
| Error | Red "x" | Auth failure, server unreachable for over 5 minutes, or decrypt failure |
| Not set up | None, tooltip "Set up sync" | No secret yet |

**Popup**

- Status line: state, last push time, last pull time, and which device made the latest snapshot.
- When behind: "Laptop has newer tabs (3 opened, 1 closed, 1 group changed)" with an **Apply** button and the add-missing / match-exactly choice (remembered).
- When in conflict: the diff of mine vs theirs, with Keep mine / Take theirs / Merge.
- **Sync now** button (forces push and pull).
- **History** list: the tier labels (1 min … 1 year), each with timestamp and device, and a Restore button. Restore uses the same mode choice and always saves a pre-restore snapshot first.
- Last error message, if any, with a Retry.

**Options page**

- Setup: "Create new sync profile" (generates and reveals the secret) or "Join with a secret".
- Server URL (default: the Railway URL; editable for local dev, e.g. `http://localhost:8787`).
- Device name.
- Reveal secret (behind a confirm), and Disconnect (clears local secret and state; leaves server data alone).
- Debug section: last 50 log lines from the background worker, useful while building.

## Edge cases and testing checklist

Each item below should have an automated test where possible, or a manual check on two real machines before calling the MVP done.

- [ ] Browser closed mid-push: pending snapshot survives in local storage and pushes on next start
- [ ] Browser restarted: Brave's own session restore fires many tab events; don't treat it as user changes until startup settles (wait \~10 seconds, then fingerprint)
- [ ] Service worker killed between debounce and push: alarm flushes it
- [ ] Applying a remote snapshot does not trigger a push back (echo suppression)
- [ ] Duplicate URLs in one window are preserved as separate tabs
- [ ] Pinned tabs restored first and in order; grouped tabs contiguous; group title, colour and collapsed state correct
- [ ] Collapsed groups: tabs inside can still be created and moved
- [ ] Multiple windows: correct window matching; extra target windows created; "match exactly" can close surplus windows only after asking
- [ ] A window with only excluded tabs (e.g. just settings) is skipped, not recreated empty
- [ ] 200+ tabs: restore stays responsive (unloaded tabs), snapshot under the size cap after compression
- [ ] Wrong secret on join: clear error, nothing written
- [ ] Tampered or swapped blob on the server: decrypt fails cleanly, status shows Error
- [ ] Server unreachable: Pending, then Error after 5 minutes; recovers automatically
- [ ] Clock skew between machines: ordering uses server-visible `created_at` plus `parentSnapshotId`, not wall-clock comparisons alone
- [ ] Two profiles on the same machine use different secrets and never see each other's data
- [ ] Pre-restore snapshot always exists and restoring it returns to the previous state
- [ ] Retention: simulated year of data prunes to roughly 170 snapshots with every label resolvable

## Roadmap: v2 and v3

None of these need server changes except screenshots; the MVP format already leaves room for them (`formatVersion`, `previewRef`).

**v2**

- **Snapshot browser.** Drill into any snapshot: windows, groups and tabs with title and favicon. Open a single link in a new tab, or open a whole group.
- **Diffs.** Pick two snapshots, or one snapshot vs the live state. Categories: opened, closed, moved (same tab, different window/group/position). Matching uses the normalized-URL multiset from the reconcile algorithm. Clicking any tab focuses it if currently open, otherwise opens it.
- **Favicons via the `_favicon` API** (`chrome-extension://<id>/_favicon/?pageUrl=…&size=32`), served from the browser's cache; stored `favIconUrl` as fallback.
- **Link preview images.** A content script reads `og:image` (and `og:title`/`og:description`) from pages; the image URL and description are small enough to store on the tab inside the snapshot, so no server change is needed. Requires `<all_urls>` host permission.
- **User exclude list.** Patterns (domains or URL prefixes) never captured, e.g. banking or one-time login links.

**v3**

- **Tab screenshots** via `tabs.captureVisibleTab` when a tab becomes active. Downscaled JPEG/WebP thumbnails, encrypted, deduplicated per normalized URL, stored in a separate `previews` table with their own retention. Biggest item: needs a new server table and endpoints.
- Possible extras: delete-profile endpoint, key rotation, export of a snapshot as a bookmarks folder.

## Suggested build order

Seven milestones, each ending in something testable; ask Claude Code to finish and test one before starting the next.

1. **Shared core.** Snapshot types, fingerprinting, URL normalization, multiset matching, retention logic, crypto helpers (HKDF, AES-GCM). Unit tests only.
2. **Server.** Hono + Drizzle, PGlite locally, the five endpoints, pruning, rate limits, tests against PGlite.
3. **Extension capture and push.** Setup flow (create/join secret), capture of windows/tabs/groups, debounce, encrypt, push, badge for Synced/Pending/Error.
4. **Pull and apply.** Behind detection, popup Apply with the two modes, reconcile algorithm incl. pinned tabs and groups, unloaded tabs, echo suppression, pre-restore snapshot.
5. **Conflicts and history.** Conflict detection via `parentSnapshotId`, conflict UI, history list with tier labels and restore.
6. **Deploy.** Railway service + Postgres, migrations on deploy, point the extension at the Railway URL, real two-machine test using the checklist.
7. **Polish.** Options page debug log, error messages, retry behaviour; then start v2.
