---
type: session
date: 2026-10-14-1303
branch: docs/wrapup-walk-dot-processing-clear
status: complete
related: [plans/2026-10-07-walks-360-design.md, plans/2026-10-13-spot-history.md]
---

# A placed walk's dot follows its video, no camera wedge on the map, and finished jobs can be cleared

## What changed

- Spot history fixes landed (#120, `336137de`): only the same kind matches nearby (drone photos and video frames within 50 m), and only spot history letterboxes its frames; the change-frames tool fills its box as before.
- Walks (#121, `a5003a11`): a small playback store (`walks/walkPlayback.ts`) carries the playing walk and time; the map and drawing sheet draw a separate `walk-<id>-now` dot for a placed walk, shown on load, following play and seek, cleared on close. Only the dot redraws per tick. The camera-file dialog now says it levels the horizon; a stitched 360 MP4's `mvhd` creation time fills `capturedAt` (UTC) when the name gives none.
- Map: the 3D camera view wedge (the triangle) is hidden by default; `setCameraWedge` stays.
- Processing drawer (#123, `3c4772af`): a "Remove from list" x on each finished row and "Clear finished" (done, cancelled, failed; interrupted jobs are kept for Resume). New `jobs:remove` IPC forgets jobs in `userData/jobs.json`; outputs and logs stay on disk. Contract row added.

## Why

The founder found the walk dot still while a placed walk played (it only existed while placing), the wedge distracting in map and split views, and no way to tidy the Processing list.

## How to test

1. Open a project with a placed 360 walk, Map view: no triangle on the map; switch to Split: none there either.
2. Open the walk's 360 video: a dot shows on its path before play; play moves it, dragging the scrub bar jumps it, closing the 360 view removes it. Same on the drawing sheet.
3. Import a stitched 360 MP4 with no date in its name: the walk shows its recorded date.
4. Processing sidebar: hover a finished job, click x, it leaves the list. Click "Clear finished": done, cancelled and failed jobs go, an interrupted job stays. Restart: removed jobs stay gone, and their maps and models are still in the project. A running job has no x.

## Open threads

- "Also delete the layers this job made" needs a job-to-layer link (job records hold only artifact paths).
- Founder: the 50 m drone match range, the `jobs:remove` contract row, whether the wedge should return as a split-view toggle.
- `test_walk_process.py` "untextured walk is pins only" failed once in CI (half-written JSON), passed on rerun; needs an owner if it repeats.
- Installer not rebuilt; the founder will ask.

## Next session entry point

Start from north-star section 3 Next; Walks W3 click-to-seek on the path is the natural follow-on to the moving dot.
