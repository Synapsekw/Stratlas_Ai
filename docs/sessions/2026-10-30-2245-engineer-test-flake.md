---
type: session
date: 2026-10-30-2245
branch: fix/engineer-test-flake
status: complete
related: [sessions/2026-10-30-1914-engineering-review.md]
---

# Engineer tests hold up under load, and engineer saves retry on Windows

## What changed

- `868991ab1`: the engineer IPC tests (`packages/ai/src/main.engineer.test.ts`) now get 30 s instead of vitest's 5 s, because under load their chain of small file writes ran about 60 times slower. Each test also keeps its own run folder, so a test that overruns can no longer write into the next one. Cleanups now retry.
- `e429e8aee`: the engineer's spend, approval and proposal-cache saves now retry a rename that Windows refuses while another reader, such as antivirus or the indexer, holds the target open. A refused save surfaced as an AI request "refused: budget". The new `renameOver.ts` matches the retry in `manifestFile.ts` and has tests.
- `878f1d139`: the classes test no longer races its own write of `issues.json`, and it attaches its rejection handler at once.

## Why

A loaded `pnpm check` failed a different engineer test each run, which blocked hand-offs (merge coordinator request, 30 Oct).

## Evidence

Running `@aio/ai` and `@aio/project` 6 at a time: the engineer file failed 2 of 24 heavy runs with the old 5 s timeout and 0 of 12 with all three fixes. `pnpm check` is green with 16,713 tests.

## How to test

Nothing user-facing changes, apart from fewer false "budget" refusals of engineer requests on busy Windows machines. The test suite covers the fix.

## Open threads

- The "refused" failure seen once in a check was not seen again under load. Its cause, a timed-out test writing into the next test's folder or a refused rename, is inferred, not proven.
- Several `@aio/project` test files still time out under load (listed in the North Star). Other writers that rename without a retry belong to the engineering review's "one atomic writer" item.

## Next session entry point

Fix the `@aio/project` test timeouts the same way: per-test folders, cleanup retries and an injected timeout, then the shared atomic writer.
