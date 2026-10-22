# @tabsync/extension

The Manifest V3 browser extension (Brave/Chromium): captures windows, tabs and groups, encrypts
snapshots, pushes and pulls them, and reconciles. TypeScript, Vite and Preact (popup and options
page).

## Building and loading

```sh
npm run dev -w extension     # rebuild into dist/ on change (with inline sourcemaps)
npm run build -w extension   # production build into dist/
```

Load it in Brave: `brave://extensions` → enable **Developer mode** → **Load unpacked** →
choose `extension/dist`. After each rebuild, click the reload icon on the extension card (and
reopen the popup). Inspect the service worker from the "service worker" link on the card.

The manifest is generated at build time from `src/manifest.ts`, and its `version` comes from
this package's `package.json`, so bump the version there.

## Layout

| Path                           | What                |
| ------------------------------ | ------------------- |
| `src/background/`              | Service worker      |
| `src/popup/`, `popup.html`     | Toolbar popup       |
| `src/options/`, `options.html` | Options page        |
| `src/manifest.ts`              | Manifest definition |

## Tests

```sh
npm test -w extension
```

Logic is unit tested with Vitest; code that touches `chrome.*` is tested against a mocked API.
