# Progress feedback while photos are aligned: design

Date: 19 Oct 2026. Branch: `feat/odm-progress-feedback`.

## Why

Team members run "Align the photos" on a site of about 500 photos. The run panel bar stops at 21% and nothing else changes, so they decide the app has hung and close it. A real 1,003-photo run on 16 Oct shows the engine (OpenDroneMap 3.6.2 / OpenSfM) doing long, real work with no visible progress: about 3 minutes to find features, 21 minutes to match 12,467 photo pairs, then a reconstruction that took 35+ minutes in a first ODM run and another 51 minutes in a second. While it worked, the app's job log showed nothing for 2 hours. Closing the app throws that work away.

The 16 Oct `odm.log` holds **two ODM runs**. The first one's output stops at 15:11:43, partway through the reconstruction. A second run starts at 16:07, skips the finished sub-steps ("already done") and completes the work. The job log says "Resuming" at that point, which fits the app being closed and the job resumed on relaunch (my reading; the files don't prove it). Within each run, the longest quiet stretches are 2.3 to 6.4 minutes (seven of them in the second run), all with the CPU busy.

The goal is that nobody ever has to guess whether a run is alive. People watch the **progress bar in the run panel**, not the logs, so the fix has to show up there.

## What is wrong today (19 Oct, from the code)

- Step weights (`python/src/aio_pipelines/photo/align.py:680`) give the sfm step 10 of 11.7, and the ODM stage end percents (`photo/odm/flags.py:18-22`) give the whole `opensfm` stage only 5 → 25 of that step. Starting opensfm puts the job at (0.5 + 10 × 0.2) / 11.7 = 21.4%.
- Inside opensfm the only finer updates are ODM's UDP progress datagrams on port 6367 (`photo/odm/runner.py:266-310`), sent at six points. Between them the bar is flat for tens of minutes. When the port is taken (`runner.py:561` logs it), no datagrams arrive at all and the bar stays at 21% for the whole stage.
- ODM's output goes to `odm-logs/<job>-sfm/tool-N.out/.err` and is tailed every 0.2 s (`photo/native.py:88-104`). Lines only feed the stage regex and the DTM check (`runner.py:553-557`). Nothing reaches the job log or the UI unless the run fails.
- The watchdog (`runner.py:376-410`) stops ODM after 60 min with no line, no datagram and almost no CPU (`AIO_ODM_STALL_MIN`). It tells the user nothing beforehand.
- No elapsed time, estimate or liveness signal exists anywhere on the path: `ctx.progress` / `Job.emit_progress` (`runtime.py:244,332-346`) → JSON-RPC `progress` → `JobRunner.onNotification` (`apps/desktop/src/main/jobs/runner.ts:491-531`) → `jobs:event` (`JobEvent`, `packages/schema/src/jobs.ts:1460`) → `renderer/jobs.ts:341` → `runView` (`renderer/photogrammetry/phases.ts:121`) → `RunPanel.tsx:355-392`.

## Goals

The founder asked for all four:

1. **A number that moves within each step.** The engine already prints countable lines (all checked against the 16 Oct log, which the pack prints at DEBUG level). Parse them into "N of M":
   - Finding features: count `INFO: Extracting ROOT_SIFT_GPU features for image 00502.jpg` lines. They name the file and carry no number. The total is the photo count (`image_list.txt`). Shown as "Finding features: 212 of 500 photos".
   - Matching: `INFO: Matching 12467 image pairs` gives M, and each `DEBUG: Matching A.jpg and B.jpg. Matcher: …` line adds one. On 16 Oct there were exactly 12,467. Shown as "Matching photos: 4,210 of 12,467 pairs".
   - Building the model: count **distinct** file names in `INFO: Adding X.jpg to the reconstruction` lines (the same photo can be added more than once: 1,779 lines for 991 photos), plus the 2 seed photos named in `Starting reconstruction with A and B`. The total is the photo count. The run will usually end short of it (993 of 1,003 on 16 Oct), so the sub-step finishes on its end line, not on the count. Shown as "Building the 3D model: 312 of 500 photos placed".
   - Undistorting: ODM prints one line for the whole sub-step, so count `.tif` files in `undistorted/images` against the photo count.
   - Smaller sub-steps (tracks, statistics, geocoords) show their plain name with no count.
2. **Plain step names**, as in the examples above. No internal OpenSfM names in the UI.
3. **Elapsed time and an estimate.** Elapsed time for the job and for the current sub-step is always shown. An estimate of time left for the sub-step is shown only while it has a count and a steady rate ("about 12 min left"). Otherwise only elapsed time is shown. No estimate for the whole job.
4. **Proof of life.** "Last activity 8 s ago" next to the bar. Activity is any of: a new engine log line, a count going up, a file written in the engine work folder, or the engine process tree being busy right now. The watchdog's CPU check is not enough for this: it samples every 30 s and averages over its whole 60-minute window (`BUSY_SHARE`, `runner.py:376-410`). The activity check needs its own short-window "busy now" reading, for example the CPU over the last sample or two, reusing the watchdog's process-tree sampling code.

The bar itself should also move more honestly:

- **Rebalance the weights** so the sub-steps inside opensfm (features, matching, tracks, reconstruct, undistort) each get a share close to how long they really take, using the 16 Oct timings as the reference. Within a sub-step that has a count, the bar moves with the count.
- Log parsing is the main source. The UDP datagrams stay as a backup and are no longer needed, so a taken port no longer freezes the bar.
- **Resumed runs** (my call): when ODM reports a sub-step as "already done", that sub-step counts as complete and the bar jumps to the start of the first sub-step that really runs. The status line names that sub-step. Counts start from zero for the sub-step that is re-run.

**Scope** (my call): every job that goes through `run_odm` gets this, which means alignment and re-aligning with ground control (`photo/georef.py:201`, which re-runs the whole opensfm stage). Both get the parsers and the notice, each through its own step weights.

## When it really goes quiet (founder decision)

- **Under 15 minutes without any activity** (as defined above): the bar looks normal and "last activity N min ago" counts up.
- **15 minutes without any activity**: a notice in the run panel, "No progress for 15 minutes. The job may be stuck.", with **Cancel job** and **Keep waiting**. Keep waiting hides it until the next unbroken 15 minutes without activity. The app never cancels a job because of this notice.
- Busy-CPU stretches such as bundle adjustment count as activity, so they never raise the notice.
- **Where the state lives** (my call): `lastActivityAt` is part of the job record in the main process, so the notice comes back after a renderer reload or when the run panel is reopened. "Keep waiting" is remembered per job in renderer memory only. After a reload the notice can reappear if the job is still quiet, which is harmless.
- The existing 60-minute watchdog stays as a last resort (my call). When it fires, the run panel says plainly that the engine was stopped after 60 minutes with no activity, instead of showing a generic failure.

## Non-goals

- Resuming a run after the app is closed. Worth its own piece of work, but separate.
- Making alignment faster (feature quality, matcher, GPU settings).
- An expandable log or details area in the run panel. The founder did not ask for one; the panel keeps a single status line (my call).
- Feedback for steps other than ODM alignment (products, mesh, walks). The new progress fields should be generic so those steps can adopt them later, but this work only wires up alignment.
- Notifications outside the app (tray, sound, email).

## Anti-goals

- An estimate that jumps around or is confidently wrong. Show none rather than a bad one.
- A "may be stuck" notice during normal heavy work. A false alarm teaches people to ignore it, or to cancel good runs.
- A bar that goes backwards.
- Raw engine log text or OpenSfM jargon in the UI.

## Constraints

- Windows only. ODM 3.6.2 as shipped in the pipeline pack. Do not patch ODM's own files; parse what it prints and writes.
- The progress message contract lives in `packages/schema`. New fields are a contract change: add a row to `docs/architecture/contract-changes.md`, and keep them optional so an older pack still works with a newer app.
- The pack/app version ranges (`APP_RANGE`) apply if the pack starts sending fields the app needs. Optional fields avoid a hard requirement.
- Keep progress emissions throttled (the existing 0.2 s). Per-pair matching lines can arrive thousands per minute.
- Tests: unit tests for the line parsers and the activity/stall logic, driven by excerpts of the 16 Oct `odm.log` (sanitised: no project or site names) checked in as fixtures. Split the fixtures at 16:07 into a first run and a resumed run, so the "already done" handling is tested. The anti-false-alarm test uses the 6.4-minute busy stretch; a renderer test for the run panel states (normal, quiet with counter, stuck notice, Keep waiting, watchdog stop message). E2E: extend the existing photogrammetry run-panel spec if one covers the bar, run the CI way.

## Left to the builder

- Exact weights for the rebalanced sub-steps, the estimate smoothing method, and when an estimate counts as "steady".
- Whether liveness and stall timing live in Python (runner) or in the main process. Recommended: Python measures activity and sends `lastActivityAt`, and the app decides when to show the notice, so the 15 minutes is a UI setting.
- Field names and shape of the progress additions (for example `detail: { label, done, total }`, `stepStartedAt`, `lastActivityAt`, `etaSeconds`).
- Run panel layout and copy within the design skills (`impeccable`), keeping to one status line plus the notice.
- How Cancel from the notice reuses the existing job cancel path.
