---
type: north-star
last-updated: 2026-10-11
---

# North star

The entry point for every session: where the product is going, what is done, and what is happening now. It is a live snapshot, not a log. `/wrapup` overwrites section 3 at the end of each working block; history lives in [sessions/](sessions/) and decisions in [architecture/adr/](architecture/adr/).

## 1. Goal

Quadrion AI: one offline-first Windows desktop app for reviewing, surveying and modelling construction sites from drone and survey data, tested internally until the founder says otherwise (no public releases, no `v*` tags).

## 2. Milestones

The full table, with plans, is [plans/ROADMAP.md](plans/ROADMAP.md). Status and one line each:

- **M1 to M9**: done and merged; founder testing.
- **M10 Globe and photogrammetry**: in progress (globe, offline street map, opt-in online satellite, pipeline pack).
- **M11 Surveying**: core and later phases integrated 9 Oct 2026; G12 AI helpers wait for the founder.
- **Timeline, Walks 360**: designed (`plans/2026-10-07-timeline-design.md`, `plans/2026-10-07-walks-360-design.md`); Walks 360 follows M10.
- **GPU acceleration**: in progress (`plans/2026-10-10-gpu-acceleration.md`): the spike, the CPU workers, the optional GPU add-on, depth maps and fusion on the graphics card and the app finding the add-on are merged; pair matching on the card is handed off; the add-on's card in Settings is planned (`plans/2026-10-11-gpu-addon-in-settings.md`).
- **M12 Licensing**: last, by founder decision.

## 3. Now

- **Phase**: M10 integration rounds; app 0.11.3 with pipeline pack 0.5.3. Pipeline pack install from Settings (round 40), the Globe street map (round 41), the session workflow (round 45), moving a whole group to another survey date (round 46), maps from photos landing under the photos' survey date with the project named (round 49), a photo run saying why its maps could not start (round 50) and processing that belongs to the project (round 57: a **Processing** chip and drawer replace the Jobs screen, the raw pipeline forms move to Settings), photo depth maps and fusion on several cores (round 60) and the new app mark, the Quarter (round 62: three quarters of a ring and a mint square, with its launch screen intro, loader and About sequence), the optional GPU add-on (round 64), photo depth maps and fusion on the graphics card (round 67) and photo jobs finding a GPU add-on placed in `runtime/` (round 68, nothing on screen yet) are merged.
- **Branch**: `main` at round 63 (app 0.11.3, pipeline pack 0.5.3, the Quarter mark); merging goes through the Orchestrator session, one branch at a time, and sessions follow the workflow in `CLAUDE.md` ("How a build runs"). CI is Windows-only with six e2e shards; macOS is parked in CI, the nightly and the release.
- **In flight**: `feat/photo-gpu-match` (photo pair matching on the graphics card) is with the Orchestrator, which builds the next team installer with a new pipeline pack from what is green on `main`.
- **Next**: finish M10; then Walks 360 and the timeline.
- **Owed**: founder decisions on the online map provider and API key, the four open decisions of the GPU add-on's Settings plan (`plans/2026-10-11-gpu-addon-in-settings.md`), a time for timing a real flight with the graphics card, and the M11 G12 AI helpers; the GPU spike's scratch folder (about 120 GB outside the repository) waits for the founder's word to delete; the inspection sample's keyboard review test fails about one run in six on `main` and needs its own fix; a **Make 3D Tiles** item on the layer and a screen for building and training AI models are follow-ups of the processing work; the team test board page (`tools/test-board/page.html`) and the user guide screenshots still show the old mark; macOS stays parked.
