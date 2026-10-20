---
type: session
date: 2026-10-20-0822
branch: feat/odm-progress-feedback
status: complete
related:
  [
    superpowers/specs/2026-10-19-odm-progress-feedback-design.md,
    superpowers/plans/2026-10-19-odm-progress-feedback.md,
    sessions/2026-10-15-1154-odm-engine.md,
  ]
---

# Live progress and a stuck notice while photos align

## What changed

- Python: `photo/odm/sfm_progress.py` turns ODM's lines into plain sub-steps with N of M counts (features, matching pairs, photos placed, undistorted photos). Weights are rebalanced from real timings, the estimate appears only at a steady rate, and resumed runs skip finished sub-steps.
- Python: `photo/odm/liveness.py` measures activity (lines, counts, work-folder writes, a 5 s CPU busy-now check). `run_odm` sends an optional `live` object on every progress tick; the watchdog stop has code `odm-stalled`.
- Schema: optional `JobLive`, plus `JobRecord.startedAt` and `live` (contract row added). Main keeps `live` on the job record.
- Renderer: `liveStatus.ts` and `JobLive.tsx` under the run panel bar show the sub-step line, time on this step and in all, "about N min left", "Last activity N s ago" (only from the engine) and, after 15 minutes of silence, "No progress for 15 minutes. The job may be stuck." with Cancel job and Keep waiting. The 60-minute watchdog stop explains itself. Re-align with ground control and the product steps (dense, mesh, DSM, ortho) get activity and the notice, without counts.
- Test fixtures are synthetic (`python/tests/make_odm_log_fixtures.py`), by founder decision: no real-project log content in the public repo. A review found and fixed a per-line cost that grew with the square of the pair count (50k pairs: 31 s CPU, now 0.36 s).

## Why

On a job of about 500 photos the bar sat at 21% "matching" with nothing new, so the team closed the app thinking it had hung. A real 1,003-photo run showed the engine working throughout (about 21 min matching 12,467 pairs, then 35 and 51 min of reconstruction) with nothing shown. The 21% came from the dataset stage holding 20% of the align step plus UDP-only sub-progress inside OpenSfM, and a taken UDP port froze the bar entirely.

## How to test

1. Open a project with drone photos and choose Create maps (Standard).
2. While it aligns, the line under the bar names the step in plain words with a count ("Finding features: N of M photos", then "Matching photos: N of M pairs", "Building the 3D model: N of M photos placed"), plus time on this step, time in all, and "Last activity N s ago", which keeps returning to a few seconds while the engine works.
3. The bar keeps moving within each step; it no longer sits at 21%.
4. On a large flight, "about N min left" appears during features and matching once the pace is steady (none while building the 3D model).
5. Close the app mid-run and resume: finished steps are skipped and the re-run step counts from zero.
6. The stuck notice appears only after 15 minutes with no engine activity at all. Keep waiting hides it for another 15 minutes; Cancel job stops the run.

## Open threads

- The photo e2e uses stand-in steps that never reach `run_odm`, so no e2e asserts the live line on the real path (unit and Python integration tests cover it).
- Undistort .tif counting is not exercised end to end.
- `python/` changed, so a pack bump is needed at release; the lander does it, along with the version bump.
- Verification: `pnpm check` green (12,937 tests), Python ODM and photo suites the CI way 185 passed, photo-process and gcp-marking e2e the CI way (1100 x 720, scale 1, WARP) 11 passed.

## Next session entry point

After the release build, run a real large flight and compare the step counts and time left with the engine log; then consider an e2e that drives `run_odm` with a recorded synthetic log.
