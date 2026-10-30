---
type: session
date: 2026-10-31-0130
branch: fix/desktop-test-timeouts
status: complete
related: [sessions/2026-10-31-0053-load-flakes-2.md, sessions/2026-10-31-0000-project-test-flake.md]
---

# Desktop tests get a load-safe 20 s timeout

## What changed

- `apps/desktop/vitest.config.ts` sets `testTimeout` and `hookTimeout` to 20 s for the `@aio/desktop` project only. Files that need more (ffmpeg, engineer IPC) keep their own allowance. The CI workflows set no timeouts of their own and stay unchanged.

## Why

Each load-flake fix turned up the next file timing out at vitest's 5 s default, whenever several sessions ran checks on this PC at once. The last full run listed five more (`collab`, `packages`, `panos`, `websiteStorage`, `compareStore`), all of which pass alone. The merge coordinator agreed to one project-level allowance in place of a branch per file. A real hang still fails, after 20 s.

## Evidence

A 6 s probe test passes when run through the root config, so the project setting applies. `pnpm check` is green on this branch (finish-task).

## How to test

Nothing user-facing. The test suite covers it.

## Open threads

- `packages/ai` and `packages/ui` showed no project-wide timeouts under load. The one `packages/ai` file that did already has its own allowance, so neither package changed.
- Per-test fixtures in `@aio/project`, and one shared atomic writer, are still open from the engineering review.

## Next session entry point

The engineering review's Wave 1: client names, the CI failure ledger, minify, and process-tree kill.
