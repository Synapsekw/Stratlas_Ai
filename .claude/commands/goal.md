# /goal: where the current milestone stands

Read-only status of the milestone in progress. It never builds and never edits.

1. Read section 3 of `docs/NORTH-STAR.md` to find the milestone in progress, then its row in `docs/plans/ROADMAP.md` and its plan in `docs/plans/`.
2. Check each task or phase of that plan against reality: merged on `origin/main` (`git log origin/main --oneline --grep <keyword>`), an open branch or worktree (`git branch --list`, `git worktree list`), an open draft pull request (`gh pr list --state open`), or a session note in `docs/sessions/`.
3. Report a compact table: task, done / in flight / not started, and the evidence (commit, branch or note).
4. End with one line: the next batch the plan's DAG allows to start now, to hand to `/whats-next` or `/develop`.

When the milestone changes, nothing here needs editing: `/wrapup` keeps the north star pointing at the current one.
