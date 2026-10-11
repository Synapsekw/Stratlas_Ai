# Notes for Claude sessions

Read `CONTRIBUTING.md` for the code rules. This file holds the rules for how sessions share the repo.

## Nobody builds on main

Several Claude sessions work in this repo at once, and building on `main` (or in the main checkout) is what broke things before. So:

- **Every session works in its own worktree on its own branch.** Before editing anything, create one off the latest `main` with `node tools/agent/start-task.mjs <name> --type <feat|fix|chore|docs|...>`, which cuts `<type>/<name>` into `.claude/worktrees/<name>` and runs `pnpm install` there (the commit hooks need it), then re-root with `EnterWorktree({ path: ".claude/worktrees/<name>" })` so subagents work there too. This applies to doc-only changes too.
- **Never edit the main checkout.** `E:\Dev\AIO Software` stays on `main` with nothing staged or modified. Never touch another session's worktree or uncommitted files; if you find stray edits in the main checkout, tell the orchestrator (or the founder) rather than committing, stashing or deleting them.
- **The hooks enforce it.** A commit or merge commit on `main`, or a push to `main`, is refused (`tools/git/guard-main.mjs`) unless `QUADRION_ORCHESTRATOR=1`, which only the orchestrator sets for its fast-forward and push. Never set it yourself and never bypass the hooks (`--no-verify`).

## The orchestrator merges, one branch at a time

One **orchestrator session** (its title is "Orchestrator"; find it with ListAgents) merges every branch into `main`, sequentially, pushes, watches CI and rebuilds the installer.

1. **Commit on your branch** with conventional commits, and get `pnpm check` green there (`pnpm format:check` is enough for doc-only changes). Before an e2e run, build the synthetic change demo (`pnpm demo:change --quick`): without it the demo specs skip locally but still run in CI. Run every end to end spec you added or changed the way CI does before the hand-off (a 1100 x 700 window on the software renderer, every demo built): see "End to end the way CI runs it" in `CONTRIBUTING.md`. Building the installer (`dist:win`) needs the pipeline Python too (`uv sync --frozen` in `python/`).
2. **Hand off, don't merge.** Run `node tools/agent/finish-task.mjs` (`--docs` for doc-only branches) in your worktree: it rebases onto the latest `origin/main`, runs the checks, checks commit messages for client and site names and prints the hand-off message. SendMessage it to the orchestrator: branch name, head SHA, a one-line summary, check and e2e status, and any merge-order needs or contract changes (each needs a row in `docs/architecture/contract-changes.md`).
3. **The orchestrator** merges ready branches one at a time in an integration worktree, resolves conflicts, runs `pnpm check` and the e2e suite on the result, runs CI through a draft pull request into `main` (`node tools/agent/watch-ci.mjs pr <number>` watches it), then fast-forwards `main`, pushes, watches `main`'s CI and rebuilds the installer when it is green. Branches that touch many files go last.
4. **Clean up** your worktree and branch once the orchestrator confirms it landed: `node tools/agent/finish-task.mjs --cleanup <branch>` from the main checkout (it handles Windows' "Filename too long").

### When no orchestrator is running

If ListAgents shows no "Orchestrator" session, do not merge into `main` on your own. Ask the founder, and offer the two options:

- **Start an orchestrator session first** (recommended whenever more than one session will build at once). It takes over merging, CI and rebuilds as above.
- **With a single active build session**, the founder may let that session merge its own branch: rebase on the latest `main`, get `pnpm check` and CI green on a draft pull request, then fast-forward `main` with `QUADRION_ORCHESTRATOR=1` set for that one merge and push. Only with the founder's explicit yes, and only one session at a time.

### When the founder asks to start building something

Before starting a new milestone or feature with several parallel sessions, offer to **kick off the orchestrator session first**, then the build sessions, so every branch has one place to land.

## How a build runs

Slash commands in `.claude/commands/` carry the workflow:

- **`/develop <brief>`** takes one brief from a worktree through brainstorming, a plan, a parallel subagent build and the checks to a hand-off. The founder is asked twice: the brainstorming questions and the plan approval.
- **`/whats-next`** reads the north star and recent notes, sizes the candidates, recommends a batch that can be built in parallel, and on the founder's pick cuts one worktree per item with an agent that stops at a written plan.
- **`/wrapup`** ends every working block: a note in `docs/sessions/`, section 3 of `docs/NORTH-STAR.md` overwritten, both committed on a branch for the orchestrator.
- **`/goal`** reports where the current milestone stands; **`/roast <idea>`** has a council of agents stress-test an idea or decision before work starts.

Working agreements for build sessions doing non-trivial work (a typo or one-liner can skip them). The Orchestrator coordinates (merges, CI, installer rebuilds) and does not use the Superpowers skills; these agreements are for the sessions that build:

1. **Use the Superpowers skills**: `brainstorming` before building, `writing-plans`, `test-driven-development`, `subagent-driven-development`, `dispatching-parallel-agents`, `systematic-debugging`, `verification-before-completion`. UI work loads the design skills (`impeccable`, `frontend-design`) first.
2. **Every plan has an Execution DAG**: which task depends on which, the parallel batches (no shared files, run at once, each batch dispatched in one message), and the critical path. A plan that is a flat list is not ready to build. It also lists the tests per task, the e2e specs it adds or changes, any contract change and the packages each task touches.
3. **Tests are written and run.** Evidence before claims: `pnpm check` green, and changed e2e specs run the way CI runs them (CONTRIBUTING.md, "End to end the way CI runs it").
4. **Finish with a "How to test" walkthrough** for the founder: numbered steps (where in the app, what to click, what should happen), in the closing message and the session note, or one line saying nothing is user-facing.
5. **Session notes and the north star are public**: no client, site, tester or person names (`node tools/agent/check-public-text.mjs <files>` catches the known client and site names).

The SessionStart hook (`tools/agent/session-context.mjs`) prints the branch, worktrees and north-star section 3 at the start of every session; the Stop hook (`tools/agent/session-draft.mjs`) leaves a `docs/sessions/_draft-*.md` after a substantial session in the main checkout so nothing is lost before `/wrapup`.

## Other rules

The stash is shared by every worktree, so never run a bare `git stash` / `git stash pop`; park work in a WIP commit on your branch instead. Never force-push `main`, never merge a branch whose checks are red, and never create GitHub Releases or `v*` tags (internal testing only until the founder says otherwise). Prefer ready-made packages over building dependencies from source; licences do not block a choice (founder, 8 Oct 2026), but keep the third-party notices generated.
