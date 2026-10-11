# /develop: take one brief to a branch the Orchestrator can merge

Take a one-line brief and carry it the whole way, the way an engineer owns a ticket: cut a worktree, scope it with `brainstorming` and `writing-plans`, build the plan with parallel subagents, verify, and hand the branch to the Orchestrator.

```
/develop a legend on the globe that names each map layer
```

There are exactly **two human checkpoints**: the brainstorming questions and the plan approval. After the plan is approved the run is autonomous until the hand-off. Sessions never merge into `main`; the Orchestrator does (CLAUDE.md). A run that stops short (red check, rebase conflict, the founder halts it) is **incomplete: say so** and say exactly where it stopped.

## Precondition: start from the main checkout

Run it from the main checkout (`E:\Dev\AIO Software`, on `main`, nothing modified). The worktree has to be nested at `.claude/worktrees/<slug>` so subagents can write into it. If you are already inside a worktree, stop: print the `start-task` command for the slug and ask the founder to run `/develop` from a fresh session in the main checkout.

## Steps

Make a todo per step and work them in order.

### 1. Slug and worktree

Derive a short kebab-case slug and a branch type (`feat`, `fix`, `chore`, ...). Run `node tools/agent/start-task.mjs <slug> --type <type>`, then `EnterWorktree({ path: ".claude/worktrees/<slug>" })` so this session and every subagent work on that branch.

### 2. Checkpoint 1: scope

Invoke `superpowers:brainstorming` for real: clarifying questions one at a time; the design skills (`impeccable`, `frontend-design`) before any visual decision. The spec goes to `docs/plans/YYYY-MM-DD-<slug>-design.md`. Then `superpowers:writing-plans` writes `docs/plans/YYYY-MM-DD-<slug>.md`, and the plan must have:

- **An Execution DAG**: which task depends on which, the parallel batches (tasks with no unmet dependency and no shared files, run at once), and the critical path.
- **Tests per task**, written and run (TDD), and which e2e specs the work adds or changes.
- **Contract changes**: any change to `@aio/schema`, with its row for `docs/architecture/contract-changes.md`.
- **Package ownership**: which packages each task touches (CONTRIBUTING.md, "Streams and worktrees").

Commit the spec and the plan on the branch.

### 3. Checkpoint 2: approve the plan

Show the plan and wait for the founder's OK. Changes: revise with `writing-plans` and show it again. Abandoned: offer to remove the worktree and branch, then stop. After approval, do not stop for routine decisions.

### 4. Build: parallel subagents

Run the plan with `superpowers:subagent-driven-development`. Dispatch each DAG batch **in one message** (`superpowers:dispatching-parallel-agents`), batches in DAG order. Each task is TDD (`superpowers:test-driven-development`). Tell every subagent: the worktree path, its task and files, that it must not touch files outside its task, must not commit with `git add -A`, and must keep Electron windows off-screen (the e2e fixtures do this). Review each result before the next batch; on a bug use `superpowers:systematic-debugging` and fix the root cause.

### 5. Verify

Invoke `superpowers:verification-before-completion`. In the worktree:

- `pnpm check` green.
- Every e2e spec added or changed, run the way CI runs it (CONTRIBUTING.md, "End to end the way CI runs it"): `pnpm demo:build --quick`, then from `apps/desktop` with `QUADRION_WINDOW_SIZE=1100x700` and `QUADRION_E2E_SWGL=1`, `--workers=1`. `@realdata` specs too when the work touches them.
- Pipeline or installer work: `uv sync --frozen` in `python/` first.

A red result goes back to step 4. Never hand off a red branch.

### 6. Hand off

Run `node tools/agent/finish-task.mjs` in the worktree. It rebases onto the latest `origin/main`, runs `pnpm check` again, checks the commit messages for client and site names and prints the hand-off message. On a rebase conflict it aborts cleanly: resolve it on the branch and run it again. Fill in the summary, e2e and merge-order lines and SendMessage it to the session named "Orchestrator" (find it with ListAgents; if there is none, follow CLAUDE.md "When no orchestrator is running").

### 7. How to test, and wrap up

Give the founder a numbered "How to test" walkthrough (where in the app, what to click, what should happen), or the one line for work with nothing user-facing. Then run `/wrapup`; its note rides the same branch if the Orchestrator has not merged it yet. Once the Orchestrator confirms the merge, clean up with `node tools/agent/finish-task.mjs --cleanup <branch>` from the main checkout.

## Discipline

- Two checkpoints only. Everything after plan approval runs to the hand-off.
- Build only in the worktree you cut. Stage by path. Never `git stash`; park work in a WIP commit.
- Evidence before claims: quote the passing output.
- One brief, one worktree. Parallelism lives inside the build (subagents per DAG batch). For triage across the roadmap use `/whats-next`.
- No emoji. No em or en dashes in user-facing text.
