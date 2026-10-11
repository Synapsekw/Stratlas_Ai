---
type: session
date: 2026-10-11-1609
branch: docs/wrapup-agent-workflow-setup
status: complete
related: []
---

# The parallel session workflow: task scripts, hooks and slash commands

## What changed

- `tools/agent/`: `start-task.mjs` (worktree and branch off `origin/main`, then `pnpm install`), `finish-task.mjs` (rebase, checks under a machine-wide lock, name check, hand-off message; `--cleanup` removes a landed worktree, long paths included), `watch-ci.mjs`, `check-public-text.mjs`, plus the SessionStart and Stop hooks and `wrapup-context.mjs`, with 31 tool tests. Landed in round 45.
- `.claude/commands/`: `/develop`, `/whats-next`, `/wrapup`, `/goal`, `/roast`; `docs/NORTH-STAR.md` and `docs/sessions/` as the shared memory; `CLAUDE.md` gained "How a build runs".
- Follow-up `docs/agent-workflow-fixes`: the working agreements apply to build sessions and the Orchestrator does not use the Superpowers skills; section 3 of the north star caught up with `main`. With the founder's yes this session merged it itself, after the Orchestrator agreed to hold its pushes: PR #55 green, `main` fast-forwarded to `2f35e9af`, worktree and branch cleaned up.
- A `/doctor` pass on the Claude Code setup: one unused plugin removed; the founder turned off two unused connectors.

## Why

Several sessions build at once, and the same tooling already worked in another project. Scripts are Node so they run on Windows without bash; the Orchestrator still merges, since this repo has no develop branch.

## How to test

No user-facing behaviour to test; the tools are covered by the `tools` test project, and `finish-task.mjs` has run end to end on real hand-offs (a conflict abort, a rebase, checks and cleanup).

## Open threads

- Stop-hook drafts stay in the main checkout by the founder's decision; drafts from other sessions are left for their own `/wrapup`.
- `docs/sessions/README.md` now points at `check-public-text.mjs`.

## Next session entry point

Nothing is left open on the workflow. Build sessions start with `node tools/agent/start-task.mjs <name> --type <type>` and end with `/wrapup` and `finish-task.mjs`.
