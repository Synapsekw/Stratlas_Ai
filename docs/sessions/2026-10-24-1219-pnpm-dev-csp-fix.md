---
type: session
date: 2026-10-24-1219
branch: fix/dev-csp
status: complete
related: [2026-10-21-2354-security-hardening.md]
---

# pnpm dev renders again under the app CSP

## What changed

- `pnpm dev` opened a black window: the app policy from the security hardening reached dev pages as a response header, blocked Vite's inline React preamble (`@vitejs/plugin-react can't detect preamble`, the root never mounted) and the request filter cancelled the hot-reload socket.
- `devAppCsp(devUrl)` in `apps/desktop/src/main/csp.ts`: the app policy plus `'unsafe-inline'` in `script-src` and `ws://<dev host>` in `connect-src`; main uses it only when `ELECTRON_RENDERER_URL` is set (never when packaged).
- `rendererUrlAllowed` lets through the dev server's own `ws://` origin, nothing else.
- Built and packaged pages keep `APP_CSP` unchanged; tests in `csp.test.ts` and `rendererUrl.test.ts`.

## Why

The founder now tests local `main` with `pnpm dev` before anything is pushed, so dev mode has to work.

## How to test

1. In the main checkout (once this is merged into local `main`), run `pnpm dev`.
2. The app window shows the project library instead of a black window.
3. Edit any visible text in a renderer file and save: the window updates without a restart.

## Open threads

- A worktree's `pnpm install` leaves no Electron binary; for a dev run there, set `ELECTRON_EXEC_PATH` to the main checkout's `node_modules/electron/dist/electron.exe`.

## Next session entry point

Nothing further on this; `pnpm dev` is the founder's test path for local merges.
