---
type: session
date: 2026-10-31-0000
branch: fix/project-test-flake
status: complete
related: [sessions/2026-10-30-2245-engineer-test-flake.md]
---

# Project tests hold up under load, and project files move into place on Windows

## What changed

- `a4cdf0235`: more project writers now retry while Windows briefly refuses a rename because a scanner or indexer is reading the file or folder that was just written. These go through `renameWhenFree` (`import/rename.ts`, the package's existing helper): the folder of an extracted project (`package/unpack.ts`), a written package (`package/writer.ts`), import copies (`import/writer.ts`) and playback proxies (`import/proxy.ts`). The folder cleanups in `unpack`, `layerFiles`, `remove` and `walks` now retry through `rm`'s `maxRetries`.
- `18ef08dfe`: `packages/project/vitest.config.ts` gives every `@aio/project` test and hook 30 s instead of vitest's 5 s and 10 s. These tests build projects on disk and finish well under a second alone, but a loaded check slows file work many times over. Every `afterEach` now removes its folder with retries (`ENOTEMPTY`, `EBUSY`, `EPERM`).

## Why

A loaded `pnpm check` failed 4 to 13 `@aio/project` tests per run, spread over about 19 files. Almost all were 5 s test or 10 s hook timeouts. The rest were cleanups that failed because a timed-out test was still writing into its folder (merge coordinator request, 30 Oct).

## Evidence

Four `@aio/project` runs at a time (`--retry=0`), two rounds per phase. Before (main `4fdb6198e`): 7 of 8 runs failed, with 9 failing tests (`remove` 3, `manifestFile` 3, `removePlan` 2, `rawWalks` 1); 8 were timeouts and 1 an `ENOTEMPTY` cleanup. After: 0 of 8 runs failed, with 1005 of 1005 tests passing in each. `pnpm check`: lint, format and typecheck green, every `@aio/project` test passed, and 16,712 of 16,713 tests passed in all. The one failure was in another package (below).

## How to test

Nothing user-facing changes, apart from fewer "operation not permitted" failures when a project is extracted, a package is written or an import is copied on a busy Windows machine. The test suite covers it.

## Open threads

- Tests still share a module-level folder variable per file. With the 30 s allowance a test no longer overruns into the next one, but moving to per-test fixtures (`test.extend`) would make that impossible rather than unlikely. That means about 650 references across the eight worst files.
- Same kind of failure outside this package: `apps/desktop/src/main/update/rollback.ts:213` renames a freshly copied version folder into place with no Windows retry, and `rollback.test.ts` failed once in the check with `EPERM`. The test then fails, and on a real machine a rollback copy could fail too.
- `manifestFile.ts` keeps its own short rename retry (about 2.5 s) next to `renameWhenFree` (about 30 s). One shared atomic writer is the engineering review's open item.

## Next session entry point

The engineering review's "one atomic writer" item: fold `manifestFile`'s `renameOver`, `renameWhenFree` and `packages/ai`'s `renameOver` into one helper.
