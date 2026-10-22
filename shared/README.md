# @tabsync/shared

Code shared by the server and the extension: snapshot types, crypto helpers, fingerprinting,
URL normalization, matching and retention logic. Pure TypeScript with no runtime dependencies;
it uses only Web Platform APIs (Web Crypto, CompressionStream) available in both Node 20+ and
browsers.

It is consumed as TypeScript source (`exports` points at `src/index.ts`): the extension's Vite
build and the server's tsup build bundle it, so there is no separate build step.

## Tests

```sh
npm test -w shared          # once
npm run test:watch -w shared
npm run typecheck -w shared
```
