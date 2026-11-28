---
type: session
date: 2026-11-28-0915
branch: docs/landing-options
status: complete
related:
  [
    2026-11-22-1353-split-notice-globe-spec.md,
    2026-11-22-1420-report-open-points.md,
    2026-11-22-1944-telecom-finalize.md,
    ../plans/2026-11-22-telecom-finalize.md,
    ../design/landing-options/README.md,
  ]
---

# A local batch of four branches landed, pipeline pack 0.36.0 built, branches tidied

## What changed

- A session in the main checkout became the merge coordinator and opened a local batch. Landed on local `main`, in order, none pushed: `fix/split-notice-globe-spec`, `fix/report-open-points`, `feat/telecom-finalize`, `docs/landing-options`. Local `main` was 47 commits ahead of `origin/main` before this note.
- Telecom was rebased onto the two fixes. The only conflict was north-star section 3: the report refresh was kept and the telecom lines re-applied. Pipeline pack 0.36.0 is confirmed as the number.
- Checks on the rebased telecom tip (the combined state of the three code branches), run as four steps for a low-memory PC: lint, format check and typecheck clean; unit tests 1651 files, 18,671 tests passed. End to end the way CI runs it (1100 x 720, scale 1, WARP, one file at a time, one worker): `volumetric-report` 1/1, `volumetric-report-edit` 2/2, `volumetric-report-layout` 2/2, `dialogs-a11y` 4/4, `package` 2/2, `telecom-finalize` 13/13, `change-frames` 4/4, `line-up-dates` 5/5. The other spec files were not run locally and are left to the CI run at the batch push. The Python suite was reported at 2,988 passed by the builder session before the rebase and was not rerun after it.
- Pipeline pack 0.36.0 is built from local `main` as an archive in `apps/desktop/dist`: 418.1 MB archived, 1167.5 MB unpacked, inside the budgets; the app's own archive install check passed as app 0.32.0; the pipeline package inside matches the source. It is not signed (no signing key is set). No installer, Store package or team kit was built.
- `docs/landing-options` (this PR): the website landing page mock-ups from October, which had sat untracked, are in `docs/design/landing-options/`, complete and public-safe. Source paths come from `QUADRION_PREVIEW_*` environment variables through `private-sources.mjs`, the name guards use the shared `check-public-text` list, the generated sample PDF is git-ignored because it carries real inspection photographs, and the unmodified originals are kept in a private folder outside the repository. Decided by the coordinator under the founder's delegation: the pages keep their anonymised figures and finding text. Known: four of the older-stage check scripts fail the same way before and after the change (the README describes them as older-stage checks).
- Housekeeping. On GitHub the 76 remote branches fully merged into `origin/main` were deleted; five unmerged ones remain (`fix/class-picker`, `fix/engineer-asset-region`, `integration/round12`, `integration/round25`, `integration/round27`). Locally two finished tool worktrees and nine dead branches were removed (merged ones, patch-equivalent ones, two inspect pre-rebase backups, the local `integration/round27`); eleven October branches with their own commits are kept on the founder's choice, as is the `feat/find-objects-spike` worktree.

## Why

Three code branches and one docs branch were ready and the founder wants to test the combined app on local `main` before anything is pushed. Telecom needs pipeline pack 0.36.0, so the archive was built for an installed build. The branch lists had grown past the point where a stale branch could be told from a live one.

## How to test

On local `main` with `pnpm dev`, started with the demo folder as the telecom and Split notice notes describe. Under `pnpm dev` the app already runs the 0.36.0 pipeline code from the checkout; an installed build needs the archive installed from Settings, Processing tools, Choose file. The full steps are in the three branch notes.

1. Volumetric report (`2026-11-22-1420-report-open-points.md`): on the two-date stockpile project, Export PDF and judge the low box on a flat pile; optionally the order of the stale-pictures messages from a package. Then approve the volumetrics section or name what is left.
2. Split notice (`2026-11-22-1353-split-notice-globe-spec.md`): at about 1100 x 720 press 3 and export a dataset. The notice sits at the strip's end and the strip takes its width back when the notice goes.
3. Telecom: section 5 of `plans/2026-11-22-telecom-finalize.md`. The steps that need the founder are Label with AI with his own provider, opening the coverage GeoTIFF in a GIS, a real tower against reference values, and the looks by eye.
4. Say when testing is done, so the coordinator pushes.

**Founder test (28 Nov 2026, on local `main` with `pnpm dev`):** all three items approved. (1) The volumetric report works, and the volumetrics section as a whole is approved. (2) The Split notice fix is tested and approved. (3) Telecom is tested and approved. With that the telecom rulings and the calls decided under his delegation stand as decided unless he reopens one. The Demo tower was built into the main checkout's demo folder for the test.

Incident: `pnpm dev` failed at first because the main checkout's `node_modules` had been emptied during this session's agent work (cause not traced; most likely a temporary folder linked to it was deleted). `pnpm install --frozen-lockfile` fixed it. Lesson: an agent must never create a link to the main checkout's `node_modules` in a temporary folder and then delete that folder recursively.

## Open threads

- The one push behind a green CI run is in progress by the coordinator; cleanup of the landed worktrees follows it.
- Not recorded as run in the founder's test: Label with AI with his own provider, the coverage GeoTIFF opened in a GIS, a real tower against reference values. The real-data volume check stays open too (it needs reference figures).
- To decide later: the five unmerged remote branches, the eleven kept local branches and six old stashes in the shared stash (untouched).
- Two empty folders (one under `.claude/worktrees`, one tool worktree shell) are held open by other processes and can be deleted once those close. The pack build folder outside the repository is kept.
- The main Python environment's package metadata is stale: it reports 0.24.0 although the code is 0.36.0. `uv sync --frozen` in `python/` refreshes it.

## Next session entry point

Read this note with the telecom note and north-star section 3. The batch is tested and approved; the merge coordinator runs `pnpm check` on the combined `main` and pushes once behind a green run. Confined spaces is the next section in focus under the freeze.
