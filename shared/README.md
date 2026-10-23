# @tabsync/shared

Code shared by the server and the extension. It's pure TypeScript with no runtime dependencies,
using only Web Platform APIs (Web Crypto, CompressionStream) available in Node 20+ and browsers.

It is consumed as TypeScript source (`exports` points at `src/index.ts`): the extension's Vite
build and the server's tsup build bundle it, so there is no separate build step.

## Modules

| Module                                | What                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------- |
| `types`                               | `Snapshot`, `SnapWindow`, `SnapGroup`, `SnapTab`, enums                    |
| `validate`                            | `parseSnapshot`: runtime validation of untrusted (decrypted) data          |
| `urls`                                | Exclusion rules, New Tab detection, URL normalization, `sanitizeWindow(s)` |
| `fingerprint`                         | `canonicalLayout` / `fingerprint`: what counts as a change worth pushing   |
| `matching`                            | `matchTabs` (multiset by URL), `matchWindows` (by overlap)                 |
| `diff`                                | `diffLayouts`, `describeDiff`: summaries for the Behind and Conflict UI    |
| `retention`                           | `selectForPruning`, `resolveRestorePoints`, tier and label constants       |
| `crypto`                              | Secret format, `deriveProfileKeys`, `encryptSnapshot` / `decryptSnapshot`  |
| `encoding`                            | hex, base64url, Crockford base32, UTF-8                                    |
| `compression`                         | `gzip` / `gunzip` via CompressionStream                                    |
| `testing` (`@tabsync/shared/testing`) | Fixture builders (`tab`, `group`, `win`, `snapshot`) for tests             |

See `PLAN.md` decisions D6 (retention horizon) and D7 (blob layout) for where this deviates
from `SPEC.md`.

## Tests

```sh
npm test -w shared          # once
npm run test:watch -w shared
npm run typecheck -w shared
```

`retention.test.ts` includes a deterministic simulation of 420 days of irregular use, pruned
after every insert as the server does, checking the snapshot count and that every restore label
resolves sensibly at regular checkpoints.
