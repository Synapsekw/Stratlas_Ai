# Notes for Claude sessions

Read `CONTRIBUTING.md` for the code rules. This file holds the rules for how sessions share the repo.

## One worktree per session, merges into main one at a time

Several Claude sessions work in this repo at once. `main` is only ever changed by a fast-forward from a finished, tested branch.

1. **Start in your own worktree.** Before editing anything, create a worktree on a new branch off the latest `main` (the EnterWorktree tool, or `git worktree add .claude/worktrees/<name> -b <type>/<name> main`). Do all edits, builds and tests there. This applies to doc-only changes too. Run `pnpm install --frozen-lockfile --prefer-offline` in a new worktree first; the commit hooks need it.
2. **Never edit the main checkout.** `E:\Dev\AIO Software` stays on `main` with nothing staged or modified. Never touch another session's worktree or uncommitted files; if you find stray edits in the main checkout, tell the founder rather than committing, stashing or deleting them.
3. **Commit on your branch** with conventional commits.
4. **Merge one session at a time.** When the work is ready:
   1. Take the merge lock from your worktree: `mkdir "$(git rev-parse --git-common-dir)/main-merge.lock"`. If the folder already exists, another session is merging: wait and retry. Never remove a lock you did not take; if one looks abandoned, ask the founder.
   2. Rebase on the latest `main` (`git rebase main`) and resolve any conflicts in your worktree.
   3. Run `pnpm check` in the worktree and get it green (`pnpm format:check` is enough for doc-only changes).
   4. Fast-forward main: `git -C "E:/Dev/AIO Software" merge --ff-only <branch>`. If it refuses, `main` moved or the checkout is dirty: go back to step 2, never force it.
   5. Push: `git push origin main`.
   6. Release the lock: `rmdir "$(git rev-parse --git-common-dir)/main-merge.lock"`.
5. **Clean up** once merged: `git worktree remove <path>` and `git branch -d <branch>`.

The stash is shared by every worktree, so never run a bare `git stash` / `git stash pop`; park work in a WIP commit on your branch instead. Never force-push `main`, never merge a branch whose checks are red, and never create GitHub Releases or `v*` tags (internal testing only until the founder says otherwise).
