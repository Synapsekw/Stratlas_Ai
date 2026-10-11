---
type: north-star
last-updated: 2026-10-12
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
- **Timeline, Walks 360**: designed (`plans/2026-10-07-timeline-design.md`, `plans/2026-10-07-walks-360-design.md`); the front of Walks 360 part W1 (camera file import, stitch, a look-around player) is merged, the rest follows M10.
- **GPU acceleration**: plan approved 10 Oct 2026 (`plans/2026-10-10-gpu-acceleration.md`); spike timing and owner open.
- **M12 Licensing**: last, by founder decision.

## 3. Now

- **Phase**: M10 integration rounds; app 0.11.3 with pipeline pack 0.5.3. Pipeline pack install from Settings (round 40), the Globe street map (round 41), the session workflow (round 45), moving a whole group to another survey date (round 46), maps from photos landing under the photos' survey date with the project named (round 49), a photo run saying why its maps could not start (round 50) and processing that belongs to the project (round 57: a **Processing** chip and drawer replace the Jobs screen, the raw pipeline forms move to Settings), photo depth maps and fusion on several cores (round 60) and the new app mark, the Quarter (round 62: three quarters of a ring and a mint square, with its launch screen intro, loader and About sequence) are merged. Rounds 73 to 81 followed on 11 Oct: the original review removed (73), the street map under the 3D scene (74), the manifest save queue (75), job starts that flush saves first (77), project types (78), the import merge (79) and split view parity (81). Then the AI agent (83), sites as chips on the Globe (84), drawings as a dataset (85: PDF and picture drawings, side by side, placed by point pairs) and 360 camera files (89: `.insv` and stitched 360 video imported into `walks/`, a 360 video pane, Cancel for a running import).
- **Branch**: `main` at round 89 (the rounds after 63 are named above as far as this note's session was told of them); merging goes through the Orchestrator session, one branch at a time, and sessions follow the workflow in `CLAUDE.md` ("How a build runs"). CI is Windows-only with six e2e shards; macOS is parked in CI, the nightly and the release.
- **In flight**: the Orchestrator builds the team installer 0.11.4 from `main`.
- **Next**: finish M10; then the rest of Walks 360 (placing a walk, its path) and the timeline.
- **Owed**: founder review of the scope choices of 11 Oct made in their absence, listed in `sessions/2026-10-12-0251-four-founder-requests.md` (project types, split view parity, drawings, 360 camera files; their four contract rows say "pending founder review"), and the decisions those design notes raise: what else a project type sets up, drawing and measuring in the second view of a comparison, DWG and IFC drawings, removing a drawing or a walk, ffmpeg in the pipeline pack, walks as a layer kind; real client, asset and site names remain in about 35 tracked files (tests, importer sources, older docs) and need a cleanup; the founder's first run of the agent's real-model check (`apps/desktop/e2e/agent-eval.spec.ts`, opt-in, with their own key): until then the agent's two acceptance requests are verified on a scripted model only; founder decisions on the online map provider and API key, the GPU spike, and the M11 G12 AI helpers (this line and section 2 say G12 waits for the founder, while `plans/2026-10-07-m11-surveying.md` and ADR 0011 say it was approved and built on 10 Oct: one of them needs correcting); the inspection sample's keyboard review test fails about one run in six on `main` and needs its own fix; a **Make 3D Tiles** item on the layer and a screen for building and training AI models are follow-ups of the processing work; the team test board page (`tools/test-board/page.html`) and the user guide screenshots still show the old mark; macOS stays parked.
