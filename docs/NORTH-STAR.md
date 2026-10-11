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
- **Timeline, Walks 360**: designed (`plans/2026-10-07-timeline-design.md`, `plans/2026-10-07-walks-360-design.md`); Walks 360 follows M10.
- **GPU acceleration**: plan approved 10 Oct 2026 (`plans/2026-10-10-gpu-acceleration.md`); spike timing and owner open.
- **M12 Licensing**: last, by founder decision.

## 3. Now

- **Phase**: M10 integration rounds; app 0.11.3 with pipeline pack 0.5.3. Pipeline pack install from Settings (round 40), the Globe street map (round 41), the session workflow (round 45), moving a whole group to another survey date (round 46), maps from photos landing under the photos' survey date with the project named (round 49), a photo run saying why its maps could not start (round 50) and processing that belongs to the project (round 57: a **Processing** chip and drawer replace the Jobs screen, the raw pipeline forms move to Settings), photo depth maps and fusion on several cores (round 60) and the new app mark, the Quarter (round 62: three quarters of a ring and a mint square, with its launch screen intro, loader and About sequence) are merged. Rounds 73 to 81 followed on 11 Oct: the original review removed (73), the street map under the 3D scene (74), the manifest save queue (75), job starts that flush saves first (77), project types (78), the import merge (79) and split view parity (81).
- **Branch**: `main` at round 81 and a few fixes beyond it (the rounds after 63 are named above as far as this note's session was told of them); merging goes through the Orchestrator session, one branch at a time, and sessions follow the workflow in `CLAUDE.md` ("How a build runs"). CI is Windows-only with six e2e shards; macOS is parked in CI, the nightly and the release.
- **In flight**: `feat/ai-agent` is with the Orchestrator: the agent keeps one conversation on every project screen and can show a finding and open Media and Issues filtered (`plans/2026-10-11-ai-agent-design.md`). The Orchestrator builds the team installer 0.11.4 from `main`.
- **Next**: finish M10; then Walks 360 and the timeline.
- **Owed**: the founder's first run of the agent's real-model check (`apps/desktop/e2e/agent-eval.spec.ts`, opt-in, with their own key): until then the agent's two acceptance requests are verified on a scripted model only; founder decisions on the online map provider and API key, the GPU spike, and the M11 G12 AI helpers (this line and section 2 say G12 waits for the founder, while `plans/2026-10-07-m11-surveying.md` and ADR 0011 say it was approved and built on 10 Oct: one of them needs correcting); the inspection sample's keyboard review test fails about one run in six on `main` and needs its own fix; a **Make 3D Tiles** item on the layer and a screen for building and training AI models are follow-ups of the processing work; the team test board page (`tools/test-board/page.html`) and the user guide screenshots still show the old mark; macOS stays parked.
