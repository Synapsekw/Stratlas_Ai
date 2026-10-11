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
- **GPU acceleration**: plan approved 10 Oct 2026 (`plans/2026-10-10-gpu-acceleration.md`); spike timing and owner open.
- **M12 Licensing**: last, by founder decision.

## 3. Now

- **Phase**: M10 integration rounds; pipeline pack install from Settings (round 40), the Globe street map (round 41) and the session workflow (round 45) are merged.
- **Branch**: `main` at round 45; merging goes through the Orchestrator session, one branch at a time.
- **In flight**: `feat/drag-group-to-date` (a group heading in a survey date folder moves its whole group to another date, with Undo) is in integration round 46, in CI as a draft pull request.
- **Next**: finish M10; then Walks 360 and the timeline.
- **Owed**: founder decisions on the online map provider and API key, the GPU spike, and the M11 G12 AI helpers; client and site names still in `docs/TESTING.md` need a clean-up branch; macOS stays parked.
