# /wrapup: record this working block in `docs/sessions/` and refresh the north star

Write a session note `docs/sessions/YYYY-MM-DD-HHmm-<slug>.md`, overwrite section 3 of `docs/NORTH-STAR.md` so the next session starts from reality, and commit both on a branch the Orchestrator will merge.

## Steps

1. **Gather state in one call:** `node tools/agent/wrapup-context.mjs`. It prints the date and note id, whether you are in a linked worktree and where the main checkout is, branch and HEAD, `git status --short`, ahead and behind against `origin/main`, the full north-star section 3, any `_draft-*.md` left by the Stop hook, the three newest session notes and the branch's commits since `origin/main`. Do not rebuild that with separate `git` or `date` calls. For "What changed" detail you may still read `git log` or diffs.

2. **Pick where to commit.** Notes never go on `main` and never into the main checkout (CLAUDE.md).
   - In your own worktree on a task branch: commit the note there; it travels with the branch to the Orchestrator.
   - In the main checkout, or your branch has already been handed off: `node tools/agent/start-task.mjs wrapup-<slug> --type docs`, write the note in that worktree, and hand that branch off with `node tools/agent/finish-task.mjs --docs`.

3. **Slug and title.** 3 to 6 kebab-case words for the most prominent work (`globe-street-map`, `survey-engine-restart`, `agent-workflow-setup`) and a short headline to match.

4. **Write the note** with the template in `docs/sessions/README.md`. "How to test" holds numbered steps for the founder (where in the app, what to click, what should happen), or the one line for work with nothing user-facing. Keep the note under about 30 lines; anything bigger belongs in a plan or an ADR.

5. **Overwrite the north star.** Read `docs/NORTH-STAR.md` with the Read tool first (it has almost certainly changed since you last saw it; never edit it from memory). Then:
   - Replace the section 3 bullets (Phase, Branch, In flight, Next, Owed) with this block's end state. Delete stale bullets; never add a dated "Latest" line. The note is the history.
   - If a milestone's status changed, update its one line in section 2 (and its row in `docs/plans/ROADMAP.md`).
   - Set `last-updated` to today.

6. **Decisions and gotchas.** A real architectural decision or a non-obvious trap gets an ADR in `docs/architecture/adr/` (next free number, same format as the others); link it from the note's `related:`.

7. **Fold drafts.** If the context showed `_draft-*.md` files, fold what is useful into the note and delete them.

8. **Check for names (the repository is public):**

   ```bash
   node tools/agent/check-public-text.mjs docs/NORTH-STAR.md docs/sessions/<note>.md
   ```

   Then read the note yourself for tester or person names, client data paths and anything from the founder's projects; no list catches those. Fix and rerun until it passes.

9. **Commit only the notes.** `git add docs/sessions/<note>.md docs/NORTH-STAR.md` (plus any ADR or ROADMAP row you touched), then `git commit -m "docs(sessions): <slug>"`. Never `git add -A`, never sweep in source changes.

10. **Report** the note path, the commit, one line on what changed in the north star, and whether the branch still needs handing to the Orchestrator.

## Discipline

- Read before Edit: the north star and any note you amend are read in this session before editing.
- The north star is a snapshot: section 3 is overwritten, section 2 stays at one line per milestone.
- No emoji. No em or en dashes.
- A research-only block still gets a note ("No files changed"); skip the north-star edits if nothing moved, apart from `last-updated` when the plan changed.
