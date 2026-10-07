# Notes for Claude sessions

Read `CONTRIBUTING.md` for the code rules. This file holds the rules for how sessions share the repo.

## One worktree per session, one merge session for main

Several Claude sessions work in this repo at once. Each session commits its own work on its own branch; one merge session (currently "Worktree workflow for sequential merges") merges every branch into `main`, pushes, watches CI and rebuilds the installer.

1. **Start in your own worktree.** Before editing anything, create a worktree on a new branch off the latest `main` (the EnterWorktree tool, or `git worktree add .claude/worktrees/<name> -b <type>/<name> main`). Do all edits, builds and tests there. This applies to doc-only changes too. Run `pnpm install --frozen-lockfile --prefer-offline` in a new worktree first; the commit hooks need it.
2. **Never edit the main checkout.** `E:\Dev\AIO Software` stays on `main` with nothing staged or modified. Never touch another session's worktree or uncommitted files; if you find stray edits in the main checkout, tell the merge session rather than committing, stashing or deleting them.
3. **Commit on your branch** with conventional commits, and get `pnpm check` green there (`pnpm format:check` is enough for doc-only changes).
4. **Hand off, don't merge.** Do not merge into or push `main`. When the branch is ready, SendMessage the merge session with: branch name, head SHA, a one-line summary, check and e2e status, and any merge-order needs (for example "after the M10 contracts").
5. **The merge session** merges the ready branches one at a time in an integration worktree, resolves conflicts, runs `pnpm check` on the result, fast-forwards `main` (`git -C "E:/Dev/AIO Software" merge --ff-only <branch>`), pushes, and watches CI. When CI is green it rebuilds the installer from that commit. Branches that rename or touch many files (for example the product rename) go last.
6. **Clean up** your worktree and branch once the merge session confirms it landed: `git worktree remove <path>` and `git branch -d <branch>`.

The stash is shared by every worktree, so never run a bare `git stash` / `git stash pop`; park work in a WIP commit on your branch instead. Never force-push `main`, never merge a branch whose checks are red, and never create GitHub Releases or `v*` tags (internal testing only until the founder says otherwise).
