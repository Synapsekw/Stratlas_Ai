# Notes for Claude sessions

Read `CONTRIBUTING.md` for the code rules. This file holds the rules for how sessions share the repo.

## Nobody builds on main

Several Claude sessions work in this repo at once, and building on `main` (or in the main checkout) is what broke things before. So:

- **Every session works in its own worktree on its own branch.** Before editing anything, create one off the latest `main` with `node tools/agent/start-task.mjs <name> --type <feat|fix|chore|docs|...>`, which cuts `<type>/<name>` into `.claude/worktrees/<name>` and runs `pnpm install` there (the commit hooks need it), then re-root with `EnterWorktree({ path: ".claude/worktrees/<name>" })` so subagents work there too. This applies to doc-only changes too.
- **Never edit the main checkout.** `E:\Dev\AIO Software` stays on `main` with nothing staged or modified. Never touch another session's worktree or uncommitted files; if you find stray edits in the main checkout, tell the founder rather than committing, stashing or deleting them.
- **The hooks enforce it.** A commit or merge commit on `main`, or a push to `main`, is refused (`tools/git/guard-main.mjs`) unless `QUADRION_ORCHESTRATOR=1`. Set it only for the one fast-forward and push of your own merge (below), never for anything else, and never bypass the hooks (`--no-verify`).

## Every session merges its own branch, one at a time

There is no Orchestrator session any more (founder, 12 Oct 2026). Each session lands its own branch, but only one session merges at a time, so check with the others first.

1. **Commit on your branch** with conventional commits, and get `pnpm check` green there (`pnpm format:check` is enough for doc-only changes). Before an e2e run, build the synthetic change demo (`pnpm demo:change --quick`): without it the demo specs skip locally but still run in CI. Run every end to end spec you added or changed the way CI does (a 1100 x 720 window at display scale 1 on the software renderer, every demo built): see "End to end the way CI runs it" in `CONTRIBUTING.md`. Building the installer (`dist:win`) needs the pipeline Python too (`uv sync --frozen` in `python/`).
2. **Prepare.** Run `node tools/agent/finish-task.mjs` (`--docs` for doc-only branches) in your worktree: it rebases onto the latest `origin/main`, runs the checks and checks commit messages for client and site names. Scan the added lines too (pattern in `apps/desktop/dist/HANDOVER-2026-10-12.md`, section 3) and look at any screenshot you add. A contract change needs a row in `docs/architecture/contract-changes.md`.
3. **Coordinate before merging.** Run ListAgents and SendMessage every active session working in this repo: your branch, head SHA and that you are about to merge. Then take the merge lock: `mkdir "$(git rev-parse --git-common-dir)/quadrion-merge-lock"` and write your session name, branch and time into an `owner` file inside it. If the folder already exists, another session is merging: wait for its "landed" message, or for the lock to go, then rebase on the new `main` and try again. A lock older than two hours whose owner is not in ListAgents is stale; ask the founder before removing it.
4. **Merge.** Holding the lock, rebase onto the latest `origin/main` once more, push your branch, open a draft pull request into `main` and watch it (`node tools/agent/watch-ci.mjs pr <number>`). When the run is fully green, from the main checkout: `git merge --ff-only <the green commit>`, then push with the guard lifted for that one command (`$env:QUADRION_ORCHESTRATOR='1'; git push origin main; Remove-Item Env:QUADRION_ORCHESTRATOR` in PowerShell). Never land red: a known occasional failure (handover section 6) gets one rerun of the failed job (`gh run rerun <id> --failed`); anything else is yours to fix. Close the pull request if GitHub does not.
5. **Release and announce.** Remove the lock folder, then SendMessage the same sessions that `main` moved to `<sha>` so they rebase before their own merge. Branches that touch many files should merge last; say so when you announce.
6. **Clean up** your worktree and branch: `node tools/agent/finish-task.mjs --cleanup <branch>` from the main checkout (it handles Windows' "Filename too long").

Installer builds happen only when the founder asks; the steps are in section 4 of the handover.

## How a build runs

Slash commands in `.claude/commands/` carry the workflow:

- **`/develop <brief>`** takes one brief from a worktree through brainstorming, a plan, a parallel subagent build and the checks to a hand-off. The founder is asked twice: the brainstorming questions and the plan approval.
- **`/whats-next`** reads the north star and recent notes, sizes the candidates, recommends a batch that can be built in parallel, and on the founder's pick cuts one worktree per item with an agent that stops at a written plan.
- **`/wrapup`** ends every working block: a note in `docs/sessions/`, section 3 of `docs/NORTH-STAR.md` overwritten, both committed on a branch that the session merges as above.
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

The SessionStart hook (`tools/agent/session-context.mjs`) prints the branch, worktrees and north-star section 3 at the start of every session; the Stop hook (`tools/agent/session-draft.mjs`) leaves a `docs/sessions/_draft-*.md` after a substantial session in the main checkout so nothing is lost before `/wrapup`.

## Other rules

The stash is shared by every worktree, so never run a bare `git stash` / `git stash pop`; park work in a WIP commit on your branch instead. Never force-push `main`, never merge a branch whose checks are red, and never create GitHub Releases or `v*` tags (internal testing only until the founder says otherwise). Prefer ready-made packages over building dependencies from source; licences do not block a choice (founder, 8 Oct 2026), but keep the third-party notices generated.
