---
type: session
date: 2026-10-11-1325
branch: fix/photo-products-start-error
status: complete
related:
  - docs/sessions/2026-10-11-1206-photo-maps-survey-date-and-project.md
---

# A photo run whose maps cannot start says why, and offers Create maps again

## What changed

- `startProducts` (`renderer/photogrammetry/actions.ts`) drops the maps the dialog queued whether the start worked or not, and keeps the reason of a refusal per run in the photo UI store (`startErrors`, `setStartError`) until a start works. A call that throws becomes a reason too.
- The run's survey date is cleared only when the maps do start, so a retry files the layers under the same date.
- The run panel's Progress tab shows "The maps could not be started." with the reason above **Next steps**, whose **Create maps** button is back because nothing is queued. A refusal from that button shows in the same place, once.
- Tests: `store.test.ts` (new), five cases in `actions.test.ts`, and one end to end test in `photo-process.spec.ts` on a processing pack of its own, whose manifest is taken away while the photos are matched and put back for the retry.
- Landed on `main` in round 50 at `25838d2` (commit `3123f1af`); the worktree and branch are cleaned up.

## Why

The start that happens by itself when the photos are matched had nobody waiting on its answer. A refusal (no processing tools, parameters turned down) left the queue in place, so the run panel stayed on "Working" with no message and no button. It was found in the final review of the survey date work.

## How to test

1. Open a project with photos, go to Jobs, click **Create maps from photos**, then **Create maps**.
2. While the run says "Matching photos", make the processing tools unavailable: rename the `pipeline-pack-<version>` folder in the data folder's `runtime` folder.
3. When matching finishes the panel says "Done", shows a red notice starting "The maps could not be started." and offers **Create maps** below it. It no longer stays on "Working".
4. Rename the folder back and click **Create maps**. The notice goes, the maps are built, and "Your maps are ready" names the photos' survey date.

## Open threads

- The reason is the job runner's own sentence (it says "pipeline pack"); plain words for it are a change in main, not made here.
- A retry builds the default outputs of the run's quality, not a custom choice made in the dialog (the same as after cancel and resume).
- A start is refused before any pipeline runs, so the stand-in pipelines cannot refuse one; the end to end test breaks its own pack instead.
- Local test runs on the workstation are paused on the founder's word (11 Oct) until told otherwise.

## Next session entry point

Nothing is left open on this fix. The Jobs screen redesign continues in its own session; rewording the job runner's refusals in plain words is a small follow-up in `apps/desktop/src/main/jobs/`.
