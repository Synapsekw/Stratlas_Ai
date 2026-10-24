# Notes for Claude sessions

Read `CONTRIBUTING.md` for the code rules. This file holds the rules for how sessions share the repo.

## Nobody builds on main

Several Claude sessions work in this repo at once, and building on `main` (or in the main checkout) is what broke things before. So:

- **Every session works in its own worktree on its own branch.** Before editing anything, create one off the latest `main` with `node tools/agent/start-task.mjs <name> --type <feat|fix|chore|docs|...>`, which cuts `<type>/<name>` into `.claude/worktrees/<name>` and runs `pnpm install` there (the commit hooks need it), then re-root with `EnterWorktree({ path: ".claude/worktrees/<name>" })` so subagents work there too. This applies to doc-only changes too.
- **Never edit the main checkout.** `E:\Dev\AIO Software` stays on `main` with nothing staged or modified. Never touch another session's worktree or uncommitted files; if you find stray edits in the main checkout, tell the founder rather than committing, stashing or deleting them.
- **The hooks enforce it.** A commit or merge commit on `main`, or a push to `main`, is refused (`tools/git/guard-main.mjs`) unless `QUADRION_ORCHESTRATOR=1`. Only the merge coordinator sets it, for its fast-forwards of local `main` and the batch push (below), never for anything else, and nobody bypasses the hooks (`--no-verify`).

## Branches land in a local merge queue, one push per batch

Since 24 Oct 2026 (founder) one session is the **merge coordinator**; the others hand their branches to it. Branches land on the local `main` one at a time and the founder tests the combined app there; only when the founder says the batch is done does the coordinator push, once, behind one green CI run. The coordinator holds the merge lock (`$(git rev-parse --git-common-dir)/quadrion-merge-lock`, its `owner` file names the coordinator) for the whole batch; if you are unsure who coordinates, run `node tools/agent/merge-coordinator.mjs status` or ask the founder. If no coordinator is running, the founder starts one: a Claude session in the main checkout that runs `/coordinate`.

A hook (`tools/agent/merge-guard-hook.mjs`) refuses pushes, pull requests and merges into `main` from any session that is not the coordinator, and its message says what to do: hand the branch to the coordinator, or ask the founder to start one. The git hooks back it up: while a batch is open, every push without the guard lifted is refused. Do not work around either.

**Every other session:**

1. **Commit on your branch** with conventional commits, and get `pnpm check` green there (`pnpm format:check` is enough for doc-only changes). Run `/wrapup` now, so its note and north-star refresh are committed on this branch. Before an e2e run, build the synthetic change demo (`pnpm demo:change --quick`): without it the demo specs skip locally but still run in CI. Run every end to end spec you added or changed the way CI does (a 1100 x 720 window at display scale 1 on the WARP software renderer, every demo built): see "End to end the way CI runs it" in `CONTRIBUTING.md`. Local checks are the only gate before a branch reaches `main`, so do not skip them. Building the installer (`dist:win`) needs the pipeline Python too (`uv sync --frozen` in `python/`).
2. **Prepare.** Run `node tools/agent/finish-task.mjs` (`--docs` for doc-only branches). While a batch is open it rebases onto the **local** `main` (never `origin/main`, which lags the queue), then runs the checks and checks commit messages for client and site names. Scan the added lines too (pattern in `apps/desktop/dist/HANDOVER-2026-10-12.md`, section 3) and look at any screenshot you add. A contract change needs a row in `docs/architecture/contract-changes.md`. A pipeline pack bump takes the number the coordinator gives you.
3. **Hand over.** SendMessage the coordinator: branch, head SHA, what it contains, the check and e2e results, and the "How to test" steps. Do not push, open a pull request, take the lock or touch `main`. When the coordinator announces that `main` moved, rebase onto it; if your branch is queued, rebase and send the new SHA.
4. **Clean up** only after the batch is pushed: `node tools/agent/finish-task.mjs --cleanup <branch>` from the main checkout (it handles Windows' "Filename too long").

**The coordinator:**

1. **Queue.** `/coordinate` takes the lock and walks these steps. Take each handed-over branch in turn and land it with `node tools/agent/merge-coordinator.mjs land <branch>` from the main checkout: it checks the branch sits on top of local `main` and its docs are free of client and site names, then fast-forwards `main` with the guard lifted. Branches that touch many files go last. After each landing, SendMessage every session that `main` moved to `<sha>`.
2. **Batch size.** Keep a batch to a few branches (about 3 to 6, or a working day) so a red run stays easy to trace.
3. **Push once.** When the founder says testing is done, run `pnpm check` on the combined `main`, push it as a branch, open a draft pull request into `main` (each with the guard lifted, since the hooks refuse every push and pull request during a batch) and watch it (`node tools/agent/watch-ci.mjs pr <number>`). When the run is fully green, push that exact commit (`$env:QUADRION_ORCHESTRATOR='1'; git push origin main; Remove-Item Env:QUADRION_ORCHESTRATOR` in PowerShell). Never land red: a known occasional failure (handover section 6) gets one rerun of the failed job (`gh run rerun <id> --failed`); anything else is traced by bisecting the straight-line history, then fixed by its session or dropped from the batch before CI runs again. Close the pull request if GitHub does not.
4. **Release.** Remove the lock (`node tools/agent/merge-coordinator.mjs release --yes`, or keep it for the next batch), tell every session the batch is on `origin/main`, and let them clean up.

Installer builds happen only when the founder asks; the steps are in section 4 of the handover.

## How a build runs

Slash commands in `.claude/commands/` carry the workflow:

- **`/develop <brief>`** takes one brief from a worktree through brainstorming, a plan, a parallel subagent build and the checks to a hand-off. The founder is asked twice: the brainstorming questions and the plan approval.
- **`/whats-next`** reads the north star and recent notes, sizes the candidates, recommends a batch that can be built in parallel, and on the founder's pick cuts one worktree per item with an agent that stops at a written plan.
- **`/wrapup`** ends every working block: a note in `docs/sessions/` and section 3 of `docs/NORTH-STAR.md` overwritten. A session runs it on its feature branch before it hands the branch to the merge coordinator, so the note and the refresh ride on the same branch. The note says "this PR", never a merge SHA. A separate `docs/wrapup-<slug>` branch is only for work that has no branch of its own: research, audits, design-only sessions. A docs-only branch still costs a queue slot, so do not cut one for what the feature branch can carry.
- **`/coordinate`** makes a session in the main checkout the merge coordinator: it takes the merge lock, tells every session the rules and runs the local merge queue up to the one push.
- **`/goal`** reports where the current milestone stands; **`/roast <idea>`** has a council of agents stress-test an idea or decision before work starts.

Working agreements for sessions doing non-trivial work (a typo or one-liner can skip them):

1. **Use the Superpowers skills**: `brainstorming` before building, `writing-plans`, `test-driven-development`, `subagent-driven-development`, `dispatching-parallel-agents`, `systematic-debugging`, `verification-before-completion`. UI work loads the design skills (`impeccable`, `frontend-design`) first.
2. **Every plan has an Execution DAG**: which task depends on which, the parallel batches (no shared files, run at once, each batch dispatched in one message), and the critical path. A plan that is a flat list is not ready to build. It also lists the tests per task, the e2e specs it adds or changes, any contract change and the packages each task touches.
3. **Tests are written and run.** Evidence before claims: `pnpm check` green, and changed e2e specs run the way CI runs them (CONTRIBUTING.md, "End to end the way CI runs it").
4. **Finish with a "How to test" walkthrough** for the founder: numbered steps (where in the app, what to click, what should happen), in the closing message and the session note, or one line saying nothing is user-facing.
5. **Work through subagents to spare the main context.** The main session plans, decides, coordinates and talks to the founder; the reading, building, testing and reviewing happen in subagents, so the main context window and tokens are not burned on file dumps and test output. Split the work into pieces, run independent pieces in parallel (one message), and fit each agent to its piece:
   - **Type:** `Explore` for searches across many files, `Plan` for designing an approach, `general-purpose` for building, running checks or e2e and reviewing, `fork` when the agent needs this conversation's context.
   - **Difficulty:** a light model (`haiku`) and low effort for mechanical or search work, the default model for ordinary building and test runs, the strongest model and high effort only for hard design, debugging or independent review.
   - **Brief and report:** give each agent the worktree path and everything it needs, and ask for a short conclusion (what changed, evidence, open points), not the file contents or full logs. Resume an agent with SendMessage instead of starting a new one for follow-ups.
   - A single lookup in a known file or a one-line edit can stay in the main session.
6. **Session notes and the north star are public**: no client, site, tester or person names (`node tools/agent/check-public-text.mjs <files>` catches the known client and site names).

The SessionStart hook (`tools/agent/session-context.mjs`) prints the branch, worktrees and north-star section 3 at the start of every session; the Stop hook (`tools/agent/north-star-check.mjs`) warns when a plan or ADR changed but `docs/NORTH-STAR.md` did not.

## Other rules

The stash is shared by every worktree, so never run a bare `git stash` / `git stash pop`; park work in a WIP commit on your branch instead. Never force-push `main`, never merge a branch whose checks are red, and never create GitHub Releases or `v*` tags (internal testing only until the founder says otherwise). Prefer ready-made packages over building dependencies from source; licences do not block a choice (founder, 8 Oct 2026), but keep the third-party notices generated.
