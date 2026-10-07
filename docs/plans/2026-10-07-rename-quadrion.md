# Rename: Stratlas becomes Quadrion AI

Date: 7 Oct 2026. Status: done on branch `worktree-agent-aec7cc8b6fa741d8c`, not merged.

The working name Stratlas is replaced by the final name **Quadrion AI** (tagline "Four dimensions. One view."). The identity kit is `docs/brand/quadrion/kit/`. This file records the decisions the founder approved and what changed.

## Decisions

1. `packages/brand/brand.json`: `productName` "Quadrion AI", `executableName` "QuadrionAI" (no space, for scripts and process names), `urlScheme` "quadrion", `legacyUrlSchemes` ["stratlas"], `tagline`, `temporary` false.
   - Kept: `appId` `ai.synapse-solutions.stratlas`, so the new installer replaces the old app (same NSIS GUID, same AUMID, same vault service) instead of installing beside it.
   - Kept: the Microsoft Store identity block (Partner Center identity cannot change); the Store shows `productName`.
2. Icons: `icon.svg` and `icon-small.svg` from the kit; `mark.svg` is the outlined horizontal lockup on dark. Sizes of 32 px and less render from the small-size cut; Store tiles sit on night slate `#11161C`. Every committed icon and Store image was regenerated with `pnpm icons`.
3. In the app the product name comes from `brand.productName`; the title bar, About and the printed guide cover draw the outlined symbol and wordmark from `packages/brand/src/marks.ts` (theme colours, no font).
4. Not changed on purpose: frozen contract identifiers, schema field names and on-disk formats (only message text); `tools/compat/corpus/**` and `tools/compat/schema-0.8/**` (old versions); localStorage, IPC and file keys with `stratlas` (`stratlas.author`, `stratlas.crash/1`, the `stratlas-legacy` message source, session partitions, `--stratlas-restore-*` flags of kept copies); the update feed file `stratlas-update.json` (installed 0.9.0 builds look for it); `docs/brand/**` and historical plans, ADRs and past TESTING stages.
5. Settings folder: Electron's userData follows the product name (`%APPDATA%\Quadrion AI`, macOS `~/Library/Application Support/Quadrion AI`). On start, before anything reads it, a packaged app whose new folder has no settings copies the old `Stratlas` folder once (never moves or deletes it), skips Chromium caches and locks, and writes `migrated-from-stratlas.json` (`apps/desktop/src/main/userDataMigration.ts`). Skipped for `QUADRION_USER_DATA` profiles and development runs. AI keys and the device key live in the OS vault under the unchanged app id, so they carry over on Windows and macOS; a key the vault cannot read shows as missing and can be entered again.
6. Data root: `E:\Stratlas Data` stays the founder's root (`DEV_DATA_ROOT`, `DEFAULT_REAL_DATA_ROOT`). New installs default to `Documents\Quadrion AI Data`; an existing `Documents\Stratlas Data` keeps being used.
7. Environment variables are `QUADRION_*`. The old `STRATLAS_*` names still work: main imports `legacyEnv.ts` first, which copies each unset `QUADRION_X` from `STRATLAS_X` (`aliasLegacyEnv` in `@aio/brand`); `playwright.config.ts` does the same; tools read through `envVar`. The isolated profile (`QUADRION_USER_DATA`, off-screen windows) and the real-data guard (`QUADRION_E2E`, `QUADRION_REAL_DATA_ROOT`) work exactly as before under either name.
8. Installers: `QuadrionAI-<version>-win-x64-setup.exe`, `-portable.exe`, `-store.msix`, `QuadrionAI-<version>-mac-<arch>.dmg` (names set in `tools/release/brand-config.mjs` from `executableName`). The install folder, shortcuts and uninstall entry say "Quadrion AI". The NSIS include moves an upgrade from `...\Programs\Stratlas` to `...\Programs\Quadrion AI` and waits for a running `Stratlas.exe` too.
9. Pipelines: LAS header system identifier and generating software are "Quadrion AI" and "Quadrion AI change.cloud" (32-byte fields, NUL padded); provenance text says "run in Quadrion AI".

## Changed

- `@aio/brand`: `brand.json`, `Brand` (`legacyUrlSchemes`, `tagline`), `urlSchemes`, `env.ts`, `marks.ts`, icons, README, tests.
- Release tools: `brand-config.mjs` (artifact names, both URL schemes in `protocols`), `icon-render.mjs`, `store-assets.mjs` (outlined wordmark on Store images), `onnx-probe.mjs` (packaged app paths from `brand.json`), `notes.mjs`, `feed.mjs`, `smoke-packaged.mjs`, `notices.mjs`; `electron-builder.yml` has no artifact names any more; `build/installer.nsh`.
- Desktop main: `legacyEnv.ts`, `userDataMigration.ts`, `appLink.ts` (several schemes), `settings.ts` (data root), messages in `library.ts` and the diagnostics bundle.
- Renderer: `shell/BrandMark.tsx` (symbol, wordmark, lockup), title bar, About (lockup and tagline), printed guide cover, window title; the guide's `{executable}` placeholder for installer names.
- Messages: "saved by a newer version of Quadrion AI", "exported by Quadrion AI", "Made with Quadrion AI" (from the brand name).
- Tests, e2e, tools, CI workflows and current docs: the new names; current docs say Quadrion AI, `docs/README.md` notes the old name.
