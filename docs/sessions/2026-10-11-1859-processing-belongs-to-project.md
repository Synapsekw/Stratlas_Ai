---
type: session
date: 2026-10-11-1859
branch: feat/project-processing
status: complete
related:
  - docs/plans/2026-10-11-project-processing-design.md
  - docs/plans/2026-10-11-project-processing.md
---

# Processing belongs to the project: a title bar chip and drawer replace the Jobs screen

## What changed

- The Jobs screen, its "New job" cards and its sidebar item are gone. A **Processing** chip in the title bar opens a drawer with the open project's running and finished jobs (tagged Maps and models, Survey, AI analysis, Files), its maps from photos, and what runs in other projects. New code is in `apps/desktop/src/renderer/processing/`.
- Work starts where it lives: maps from photos from the drawer, the AI inspection from **Detections** (**Turn detections into issues**), the road build from road setup, both through a start dialog for the open project. The raw pipeline forms and every job on the computer are under **Settings**, **Processing tools**, **Advanced**.
- Built task by task from the plan (15 tasks, each reviewed), then a whole-branch review and one fix wave of 22 items. Along the way: the Detections review now reloads when an inspection run ends, and the drawer keeps focus after a row or Back.
- No contract change (schema, IPC, pack untouched). `pnpm check` green (5,499 tests); eleven end to end specs pass the CI way, among them the new `processing-drawer.spec.ts`; `jobs-chooser.spec.ts` is deleted.
- Handed off at `4be6e176`; in integration round 57 as a draft pull request.

## Why

The founder found the Jobs tab unclear: it mixed a job list for every project, shortcut cards that started nothing, raw pipeline forms and tool status. Jobs are map processing or AI analysis of one project, so they are now seen and managed there. The tab can return later, renamed, for building and training AI models.

## Rulings made on the founder's behalf during the build

- The chip's "looked at" stamps are kept in `localStorage` per project, not per session as the first design said: session-only would flag an old interrupted job at every start. The design document is amended.
- One user-facing string changed in `apps/desktop/src/main/libraryActions.ts` (the refusal to delete a project with a running job pointed to "the Jobs screen"). Text only.
- `docs/TESTING.md` and one line of `docs/release/README.md` were swept, although the plan named only the guide: about 30 lines still described the Jobs screen.
- Tasks ran one after the other, not in the plan's parallel batches (two agents committing in one worktree can collide).

## How to test

1. Open a project. The title bar has a **Processing** chip; the sidebar has no **Jobs**.
2. Click **Processing**: a drawer with the project's name, **Create maps from photos** and **Maps from photos**.
3. Start maps from photos from there. The wizard opens, the drawer closes, the chip counts up ("Processing 12%").
4. Click the chip, then the running line: steps, **Cancel**, **Open run**; **Back** returns to the list.
5. Open another project while it runs: the chip reads "Processing · 1 running elsewhere" and the drawer lists it under **Running in other projects**.
6. On an inspection project, **Detections**, **Turn detections into issues**: a dialog that says "Runs in _name_."
7. **Settings**, **Processing tools**, bottom: **Advanced: run a pipeline directly** and **All jobs on this computer**.

## Open threads

- The inspection sample test of `samples.spec` fails about one run in six in its keyboard review loop, on `main` as well; it needs its own fix.
- A CI run once read a new photo layer's survey date as undefined. The layer and its date are written in one manifest write, so the cause is unknown; the spec now polls. Watch for a repeat.
- Follow-ups: a **Make 3D Tiles** item on the layer (it is a raw form under Advanced); the chip squeezes the breadcrumb at the smallest window; the warning icon in the drawer's tools-missing box sits on its own line; `photogrammetry/PhotoRuns.tsx` has a stale comment and an unused `selected` prop.
- A project's processing history is kept per computer and folder, so a moved project starts with an empty list (in `docs/KNOWN-LIMITS.md`).

## Next session entry point

Once round 57 has landed, clean up the worktree and branch `feat/project-processing`. The AI model training screen is a milestone of its own and is not designed yet.
