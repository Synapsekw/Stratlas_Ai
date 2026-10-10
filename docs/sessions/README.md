# Session notes

One note per working block, written by `/wrapup` (`.claude/commands/wrapup.md`) as `YYYY-MM-DD-HHmm-<slug>.md`. They carry what git cannot: why the work happened, how to test it, what is left open and where the next session starts. [../NORTH-STAR.md](../NORTH-STAR.md) is the live snapshot; these are the history behind it.

`_draft-*.md` files are left by the Stop hook (`tools/agent/session-draft.mjs`) after a substantial session in the main checkout; the next `/wrapup` folds them into a note and deletes them. They are never committed.

The repository is public: no client, site, tester or person names, no paths to client data, no screenshots of client projects. `/wrapup` checks each note with `tools/demo/check-no-client-data.mjs` before committing it.

## Template

```markdown
---
type: session
date: YYYY-MM-DD-HHmm
branch: <branch>
status: complete
related: []
---

# <Title>

## What changed

- (3 to 6 bullets: what was built or decided, commits, branches handed off)

## Why

(1 to 3 sentences of context the git log cannot carry.)

## How to test

(Numbered steps for the founder: where to go in the app, what to click, what should happen. If nothing is user-facing: "No user-facing behaviour to test; covered by the test suite.")

## Open threads

- (unfinished work, blockers, follow-ups)

## Next session entry point

(1 to 2 sentences: where the next session starts.)
```
