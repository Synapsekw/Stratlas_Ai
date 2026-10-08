# Notes for Claude sessions

Read `CONTRIBUTING.md` for the code rules. This file holds the rules for how sessions share the repo.

## Nobody builds on main

Several Claude sessions work in this repo at once, and building on `main` (or in the main checkout) is what broke things before. So:

- **Every session works in its own worktree on its own branch.** Before editing anything, create one off the latest `main` (the EnterWorktree tool, or `git worktree add .claude/worktrees/<name> -b <type>/<name> main`). This applies to doc-only changes too. Run `pnpm install --frozen-lockfile --prefer-offline` in a new worktree first; the commit hooks need it.
- **Never edit the main checkout.** `E:\Dev\AIO Software` stays on `main` with nothing staged or modified. Never touch another session's worktree or uncommitted files; if you find stray edits in the main checkout, tell the orchestrator (or the founder) rather than committing, stashing or deleting them.
- **The hooks enforce it.** A commit or merge commit on `main`, or a push to `main`, is refused (`tools/git/guard-main.mjs`) unless `QUADRION_ORCHESTRATOR=1`, which only the orchestrator sets for its fast-forward and push. Never set it yourself and never bypass the hooks (`--no-verify`).

## The orchestrator merges, one branch at a time

One **orchestrator session** (its title is "Orchestrator"; find it with ListAgents) merges every branch into `main`, sequentially, pushes, watches CI and rebuilds the installer.

1. **Commit on your branch** with conventional commits, and get `pnpm check` green there (`pnpm format:check` is enough for doc-only changes). Before an e2e run, build the synthetic change demo (`pnpm demo:change --quick`): without it the demo specs skip locally but still run in CI. Building the installer (`dist:win`) needs the pipeline Python too (`uv sync --frozen` in `python/`).
2. **Hand off, don't merge.** SendMessage the orchestrator with: branch name, head SHA, a one-line summary, check and e2e status, and any merge-order needs or contract changes (each needs a row in `docs/architecture/contract-changes.md`).
3. **The orchestrator** merges ready branches one at a time in an integration worktree, resolves conflicts, runs `pnpm check` and the e2e suite on the result, runs CI through a draft pull request into `main`, then fast-forwards `main`, pushes, watches `main`'s CI and rebuilds the installer when it is green. Branches that touch many files go last.
4. **Clean up** your worktree and branch once the orchestrator confirms it landed: `git worktree remove <path>` and `git branch -d <branch>`.

### When no orchestrator is running

If ListAgents shows no "Orchestrator" session, do not merge into `main` on your own. Ask the founder, and offer the two options:

- **Start an orchestrator session first** (recommended whenever more than one session will build at once). It takes over merging, CI and rebuilds as above.
- **With a single active build session**, the founder may let that session merge its own branch: rebase on the latest `main`, get `pnpm check` and CI green on a draft pull request, then fast-forward `main` with `QUADRION_ORCHESTRATOR=1` set for that one merge and push. Only with the founder's explicit yes, and only one session at a time.

### When the founder asks to start building something

Before starting a new milestone or feature with several parallel sessions, offer to **kick off the orchestrator session first**, then the build sessions, so every branch has one place to land.

## Other rules

The stash is shared by every worktree, so never run a bare `git stash` / `git stash pop`; park work in a WIP commit on your branch instead. Never force-push `main`, never merge a branch whose checks are red, and never create GitHub Releases or `v*` tags (internal testing only until the founder says otherwise). Prefer ready-made packages over building dependencies from source; licences do not block a choice (founder, 8 Oct 2026), but keep the third-party notices generated.
