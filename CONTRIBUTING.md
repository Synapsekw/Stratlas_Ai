# Contributing to Quadrion AI

## Setup

```bash
pnpm install
pnpm check        # lint, format check, typecheck, unit tests
pnpm dev          # run the desktop app (once apps/desktop exists)
```

Node 24 and pnpm 10 are required. Hooks (lefthook) run lint-staged on commit and commitlint on the message.

## Rules

- TypeScript strict everywhere; no `any`, no non-null assertions.
- Every package exposes its public API from `src/index.ts` and depends only on the packages listed in `docs/architecture/SPEC.md` section 2.
- Renderer code never imports `electron` or `node:*`; it talks to main through `window.aio` (typed by `@aio/schema` `ipc`).
- The product name lives only in `@aio/brand` (Quadrion AI; Stratlas until 7 Oct 2026).
- Environment variables are `QUADRION_*`. The old `STRATLAS_*` names still work as a fallback (`@aio/brand` `envVar` / `aliasLegacyEnv`), but new code and docs use `QUADRION_*`.
- Client data never enters git. Fixtures live in git-ignored `fixtures/data/`; full projects live in `E:\Stratlas Data\` on the founder's workstation (or the path in Settings; new installs default to `Documents\Quadrion AI Data`).
- No em or en dashes in user-facing text.
- Conventional commits: `feat(scope): ...`, `fix(scope): ...`, `chore: ...`.

## Streams and worktrees

Parallel work follows SPEC section 9. Each stream works in its own worktree and branch:

```bash
git worktree add ../quadrion-wt/s3-engine -b stream/s3-engine
```

- A stream owns its package(s) and may not edit another stream's package. Ask the integration lead instead.
- Nobody edits the main checkout directly; every change, docs included, starts in its own worktree.
- Get `pnpm check` green on your branch, then hand it to the orchestrator session, which merges branches into `main` one at a time and pushes. Nobody commits on `main` (the hooks refuse it). `CLAUDE.md` has the full steps.
- Contracts in `@aio/schema` are frozen (`contracts-v1`). A change needs an entry in `docs/architecture/contract-changes.md` and the integration lead's sign-off before merge.

## Tests

- Unit: Vitest, next to the code as `*.test.ts`.
- End to end: Playwright with Electron in `apps/desktop/e2e/`, including the zero-network test.

### End to end the way CI runs it

CI runs the end to end specs under conditions a workstation does not have by default, so a spec can pass locally and fail on every CI run:

- **A small window, at display scale 1.** CI asks for no window size (`.github/workflows/ci.yml` sets no `QUADRION_WINDOW_SIZE`). The app asks for its default, 1440 x 900, and the runner's 1024 x 768 screen cuts that down: the width to the app's minimum, 1100, and the height to what the screen has left above the taskbar, about 720 (`src/main/windowMode.ts`). That is not the smallest window, 1100 x 700. The exact size is in the log of every e2e job, in a line the fixtures print with the first window: `[e2e] window 1100 x 720 px at display scale 1`. At that width the stage toolbar folds groups into **More tools** (`COLLAPSE_ORDER` in `workspace/toolbarFit.ts`), panels are narrower and popovers have less room.
- **A screen at 100 %.** A workstation's screen may be at 150 or 200 %. A CSS pixel is then more than one device pixel and positions round differently: a row that lies a fraction of a pixel across an edge passes a "fully in view" check on one and fails it on the other, in a window of the same size.
- **A software renderer.** The runners have no GPU.
- **Every demo built.** CI runs `pnpm demo:build --quick` before the specs, not only the change demo.

Before a hand-off, run every spec you added or changed that way, from `apps/desktop`:

```bash
pnpm demo:build --quick
QUADRION_WINDOW_SIZE=1100x720 QUADRION_E2E_SCALE=1 QUADRION_E2E_SWGL=1 npx playwright test e2e/<spec>.spec.ts --workers=1
```

In PowerShell, set `$env:QUADRION_WINDOW_SIZE = '1100x720'`, `$env:QUADRION_E2E_SCALE = '1'` and `$env:QUADRION_E2E_SWGL = '1'` first. The run must print `[e2e] window 1100 x 720 px at display scale 1` (with the first window that a spec did not size itself); if a CI log shows another height, use that one. `--repeat-each=3` shows a timing problem early.

`QUADRION_E2E_SCALE` and `QUADRION_E2E_SWGL` are read by the e2e fixtures only (`e2e/fixtures.ts`): they add Chromium's `--force-device-scale-factor` and the SwiftShader switches to every app a spec starts. CI sets neither, and no window size: its runners are like that already.

Write specs so they hold at that size:

- Open a stage tool from the bar, or from **More tools** when it is folded there (`environment.spec.ts`, `designs.spec.ts` and `haul.spec.ts` show how).
- Click the 3D, Map or Split switch inside the "Stage tools" toolbar, not the first button named "3D" on the page, and wait for its pressed state.
- Wait for the scene canvas before looking for a tool that only the 3D view has.
- A new floating control must not cover the view: assert with `document.elementFromPoint` that clicks on the view reach it, in the smallest window, 1100 x 700, as well.
- A spec about the smallest window asks for it itself, whatever the run's size: `test.use({ appEnv: { QUADRION_WINDOW_SIZE: '1100x700' } })` (`small-window.spec.ts`).
- `scrollIntoViewIfNeeded` moves an element that is partly in view by whole pixels and can leave a fraction of a pixel of it clipped. Before a "fully in view" check or a drag, scroll the list yourself (`showTogether` in `timeline.spec.ts`).

### End to end on real client data

Some specs run on the founder's real projects. They must never write into them:

- The real data root is `QUADRION_REAL_DATA_ROOT`, default `E:\Stratlas Data`. Only `e2e/realData.ts` names it; a spec never reads it from the environment or writes the path itself.
- A spec gets real data only through that gate: `realProject(ids)` or `realDataTest(ids)` (fixtures.ts) copy the projects to a temp data root, launch the app on the copy and delete it afterwards; `copyRealProjects` / `copyRealData` copy for specs that build their own data root. Large read-only files are hard-linked when the copy is on the same drive (`QUADRION_E2E_COPY_DIR` picks the folder; the system temp folder by default). The real folder is never the app's data root: `launchApp` refuses it.
- Every app a test starts runs with `QUADRION_E2E=1` (`playwright.config.ts`); main then refuses any write under the real data root, and any write in place to a hard-linked file (`src/main/realDataGuard.ts`). A refusal fails the test at `app.close()`.
- Every test that uses real data has `@realdata` in its title (test or describe). The run without real data is `npx playwright test --grep-invert @realdata`; with `QUADRION_REAL_DATA_ROOT` set to an empty folder the `@realdata` tests skip.
- `src/e2eRealData.test.ts` (part of `pnpm check`) fails on a literal real data path in `e2e/`, on the old per-spec data variables, on an `electron.launch` without its own `QUADRION_DATA` or next to the gate, and on a real-data spec without `@realdata`.
- Agent runs keep their windows off-screen through the fixtures (an isolated `QUADRION_USER_DATA` profile) and run with `--workers=1`.
- The launch screen never shows in an e2e run (`QUADRION_E2E=1`), so specs land straight in the app. `QUADRION_SHOW_GATE=1` brings it back (only `e2e/launch-gate.spec.ts` does); `QUADRION_SHOW_GATE=0` skips it in any run.
