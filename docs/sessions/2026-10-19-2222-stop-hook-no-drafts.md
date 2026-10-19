---
type: session
date: 2026-10-19-2222
branch: fix/session-draft-noise
status: complete
related: []
---

# Stop hook no longer writes draft notes

## What changed

- The Stop hook is now `tools/agent/north-star-check.mjs` (was `session-draft.mjs`). It only warns when a plan or ADR changed without `docs/NORTH-STAR.md`; it no longer writes `docs/sessions/_draft-*.md` stubs. Its tests now run the hook on a temporary repo.
- `noteStamp` moved to `session-context.mjs`. The session context and `wrapup-context.mjs` no longer list drafts, and `finish-task.mjs` no longer deletes them.
- `.claude/settings.json`, `CLAUDE.md` and the `/wrapup` command (fold-drafts step removed) follow. The `.gitignore` line stays so old local stubs remain ignored.

## Why

41 unfilled stubs had piled up in the main checkout, written about every two hours. The hook skips linked worktrees, so since every session works in a worktree it only fired in the main checkout, where no work happens. An untracked 61-file folder there crossed the changed-files threshold on every stop, and the tool-call count covered the whole transcript, so long sessions crossed it too. None of the stubs was ever folded into a note.

## How to test

No user-facing behaviour to test; covered by the test suite.

## Open threads

- The old stubs in the main checkout are untracked and ignored; the founder deletes them by hand.
- An untracked `docs/design/landing-options/` folder sits in the main checkout; its owner should commit it on a branch or remove it.

## Next session entry point

Nothing pending from this branch once it lands.
