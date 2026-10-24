# /coordinate: become the merge coordinator and run the local merge queue

Makes this session the one session that lands work (CLAUDE.md, "Branches land in a local merge queue, one push per batch"). Other sessions hand their branches here; this session fast-forwards the local `main` to each in turn, the founder tests the combined app, and only then does this session push, once, behind one green CI run. A hook (`tools/agent/merge-guard-hook.mjs`) stops pushes, pull requests and merges into `main` from every session that is not the coordinator; the git hooks (`tools/git/guard-main.mjs`) back it up.

## 1. Take the lock

1. **Check where you are.** This session must run in the main checkout with `main` checked out and nothing modified: `git rev-parse --show-toplevel`, `git rev-parse --abbrev-ref HEAD`, `git status --short`. If you are in a worktree, or the tree is dirty, stop and tell the user (stray edits belong to the founder, never commit, stash or delete them).
2. **Learn your own session name** with ListAgents (the entry marked as you).
3. **Take the lock:** `node tools/agent/merge-coordinator.mjs take --name <your session name>`. It creates `<git-common-dir>/quadrion-merge-lock` and writes the `owner` file only if the folder did not exist.
   - **Held by a session that ListAgents shows as active:** stop. Tell the user that session coordinates and that their branches go to it.
   - **Held for more than two hours by a session that ListAgents does not show:** the lock is stale. Ask the user before you remove it (`node tools/agent/merge-coordinator.mjs release --yes`), then take it again.
   - **Held by you** (a resumed session): carry on.

## 2. Tell every session

SendMessage every active session in this repo (ListAgents) this summary, with your name filled in:

> `<name>` is the merge coordinator. Branches land on the local `main`, one at a time; nobody pushes until the founder has tested the batch. To hand over: commit on your branch, rebase onto the local `main` (`git rebase main`), run `node tools/agent/finish-task.mjs` (`--docs` for doc-only branches; it rebases onto the local `main` while the batch is open), then SendMessage me the hand-off it prints. Do not push, open a pull request, take the lock or touch `main`. When I announce that `main` moved, rebase onto it; if your branch is queued, send me the new SHA. A pipeline pack bump takes the number I give you.

## 3. Run the queue

For each handed-over branch, one at a time:

1. Read the hand-off: checks green, e2e run the CI way for changed specs, "How to test" present. Send it back if not.
2. **Pack numbers.** If the branch bumps the pipeline pack, give it the next free number before it lands, so two branches never claim the same one.
3. **Order.** Branches that touch many files land last in the batch.
4. **Land it:** `node tools/agent/merge-coordinator.mjs land <branch>` from the main checkout. It checks the lock, that the branch sits on top of the local `main`, and the branch's docs for client and site names, then fast-forwards `main`. If the branch is behind, ask its session to `git rebase main` and send the new SHA.
5. **Announce:** SendMessage every active session the line `land` prints (`main moved to <sha> ...`).

Keep a batch to a few branches (about 3 to 6, or a working day) so a red run stays easy to trace. The founder tests the combined app on the local `main` (`pnpm dev`).

## 4. Push once

Only when the founder says testing is done:

1. Run `pnpm check` on the combined `main`.
2. Push it as a branch and open a draft pull request into `main`, with the guard lifted for each command: `$env:QUADRION_ORCHESTRATOR='1'; git push origin main:refs/heads/batch/<date>; Remove-Item Env:QUADRION_ORCHESTRATOR` in PowerShell (or `QUADRION_ORCHESTRATOR=1 git push ...` in bash), then the same prefix for `gh pr create --draft --base main --head batch/<date>`.
3. Watch it: `node tools/agent/watch-ci.mjs pr <number>`. Never land red: a known occasional failure (handover section 6) gets one rerun of the failed job (`gh run rerun <id> --failed`); anything else is traced by bisecting the straight-line history, then fixed by its session or dropped from the batch before CI runs again.
4. When the run is fully green, push that exact commit to `main` with the guard lifted for that one command (`$env:QUADRION_ORCHESTRATOR='1'; git push origin main; Remove-Item Env:QUADRION_ORCHESTRATOR`). Close the pull request and delete the batch branch if GitHub does not.

## 5. Release

`node tools/agent/merge-coordinator.mjs release` shows who holds the lock and warns if `main` is not pushed; run it again with `--yes` to remove the lock (or keep it for the next batch). Tell every session the batch is on `origin/main` and that they can clean up (`node tools/agent/finish-task.mjs --cleanup <branch>` from the main checkout).
