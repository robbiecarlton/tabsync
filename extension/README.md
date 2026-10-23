# @tabsync/extension

The Manifest V3 browser extension (Brave/Chromium). It captures windows, tabs and groups,
encrypts snapshots, and pushes them to the sync server. Written in TypeScript with Vite, and
Preact for the popup and options page.

## Building and loading

```sh
npm run dev -w extension     # rebuild into dist/ on change (with inline sourcemaps)
npm run build -w extension   # production build into dist/
```

To load it in Brave:

1. Open `brave://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and choose `extension/dist`.
3. After each rebuild, click the reload icon on the extension card and reopen the popup.

Inspect the service worker from the "service worker" link on the card.

The manifest is generated at build time from `src/manifest.ts`. Its `version` comes from this
package's `package.json`, so bump the version there.

## Trying it locally

1. Run `npm run dev` at the repo root to start the server on `localhost:8787` and the
   extension build.
2. Load or reload the extension, open its options page and click **Create new sync
   profile**. The badge turns green.
3. Open or close a tab. The badge turns grey, then green again about 5 s later. Each push
   appears in the options page's debug log.

## How it works

| Path                         | What                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------- |
| `src/background/`            | Service worker: registers tab/group/window listeners, alarm, message handler |
| `src/lib/engine.ts`          | `SyncEngine`: capture → fingerprint → debounce → encrypt → push, retries     |
| `src/lib/capture.ts`         | Browser windows/tabs/groups → snapshot windows (via shared capture rules)    |
| `src/lib/api.ts`             | HTTP client for the server (`Bearer <profileId>.<authToken>`)                |
| `src/lib/state.ts`           | Persisted settings, credentials and sync state (`chrome.storage.local`)      |
| `src/lib/status.ts`          | Status and badge rules                                                       |
| `src/lib/schedule.ts`        | Debounce, settle, retry and error timings                                    |
| `src/lib/messages.ts`        | Typed messages between popup/options and the worker                          |
| `src/popup/`, `src/options/` | UI                                                                           |
| `src/manifest.ts`            | Manifest definition                                                          |

Everything the worker needs to resume lives in `chrome.storage.local`. That includes the
pending snapshot and the debounce markers, so the worker can be killed at any point. A
1-minute alarm flushes anything a lost in-memory timer would have handled. The secret lives
only in `chrome.storage.local`, never in `chrome.storage.sync`.

**Custom server URL:** the manifest grants `http://localhost:8787` only. Saving another URL in
options asks Brave for permission to reach that one origin.

## Tests

```sh
npm test -w extension
```

The engine is tested end to end against in-memory fakes in `test/fakes.ts`: a browser, a
store, a server with offline and error switches, and a clock whose timers fire only when the
test advances time. Worker restarts are simulated by dropping timers and building a new
engine over the same storage. The HTTP client is tested against a fake `fetch`.
