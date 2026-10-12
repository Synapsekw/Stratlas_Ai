# @aio/brand

The only place the product's identity lives. The product is **Quadrion AI** (called Stratlas until 7 Oct 2026); the full identity kit is in `docs/brand/quadrion/kit/`.

- `brand.json`: product name, app id, executable name, URL schemes, tagline, company, Microsoft Store identity, privacy policy address (`privacyPolicyUrl`, empty until the policy is published; Settings links to it only when set). Installer config is generated from it (`tools/release/brand-config.mjs`).
- `icon.svg`: the 512 px app icon; `icon-small.svg`: its small-size cut (the ring in one piece), used from 32 px down (`tools/release/icon-render.mjs`). Run `pnpm icons` after either changes; the outputs are committed.
- `mark.svg`: the outlined horizontal lockup on dark.
- `src/marks.ts`: the outlined wordmark only, as path data coloured by the caller (title bar, About, printed guide, Store images). It stays free of imports: the release tools load it directly.
- `src/symbol.ts`: the symbol, four pieces and a small cut, built from the geometry in `src/quarter.ts`.
- `src/quarter.ts`: the geometry of the mark, the Quarter: three quarters of a ring and a square tail. The kit (`docs/brand/quadrion/build/kit.mjs`) draws from it and writes `icon.svg`, `icon-small.svg` and `mark.svg` here; run it, then `pnpm icons`, after a change. The moving mark in the app (`apps/desktop/src/renderer/shell/BrandMotion.tsx`) uses the same geometry.
- `src/env.ts`: the `QUADRION_*` environment variable prefix, with the old `STRATLAS_*` names as a fallback (`envVar`, `aliasLegacyEnv`).

Kept on purpose after the rename, so installed copies upgrade in place and old links keep working:

- `appId` (`ai.synapse-solutions.stratlas`): the new installer replaces the old app instead of installing beside it, and vault entries carry over.
- `store`: the Partner Center identity cannot change; the Store shows `productName`.
- `legacyUrlSchemes` (`stratlas`): still registered and handled beside `quadrion://`.
