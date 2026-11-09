---
type: session
date: 2026-11-09-0926
branch: docs/wrapup-flyability-real-export
status: complete
related: [sessions/2026-11-01-0810-flyability-phase-1-done.md]
---

# Flyability import, first run on a real export

## What changed

No source files changed. The import job (pack 0.33.0 code) ran on two chambers of a real Inspector 5 export, and the `@realdata` case of `flyability-import.spec.ts` ran the CI way. Both passed.

- First chamber: 5 flights (2 with an Inspector transform), about 69 M points in the flight clouds plus a 4.2 M merged cloud, 5 flight lines, 77 findings and 154 photos, in 170 s; a re-import took 6 s, kept the clouds and the finding codes.
- Second chamber as a second space: 4 flights, 124 findings, codes unique across both spaces.
- Flight clouds sit about 1 cm from the merged cloud once their transform is applied (the inverse is clearly worse), finding points 2 to 3 cm from the cloud (10 cm at most), flight lines inside the cloud.

## Why

Phase 1 was built on synthetic exports; this run was the owed check on real data.

## How to test

Nothing user-facing changed in this PR.

## Open threads

- The location check reads every distance about 0.14 m shorter than the drone's wall distance (the cast starts at the camera; the drone measures from about 0.14 m behind it), so 8 to 18% of findings are flagged as disagreeing.
- Lidar outliers stretch the merged cloud's bounds to about 69 x 37 m around a 14 x 10 m chamber, so the first view and Zoom to frame it small.
- An Inspector flight named "Undefined" gives `undefined.copc.laz`; "No adapter for flightline layers yet" is logged on open; all overlapping clouds are on at first.
- To check in a project made through Add data: a street-map download offer and a Drafts count beside Issues seen in a scratch project.

## Next session entry point

A small fix branch for the open threads (waiting for the founder's go), then phase 2 (video projected on the cloud).
