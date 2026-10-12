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
- **M11 Surveying**: core and later phases integrated 9 Oct 2026; G12 AI helpers (Suggest boundaries, Snap to ortho edges) approved and built 10 Oct 2026, with MobileSAM in the pipeline pack (ADR 0011).
- **Timeline, Walks 360**: designed (`plans/2026-10-07-timeline-design.md`, `plans/2026-10-07-walks-360-design.md`); the front of Walks 360 part W1 (camera file import, stitch, a look-around player) is merged, the rest follows M10.
- **GPU acceleration**: in progress (`plans/2026-10-10-gpu-acceleration.md`): the spike, the CPU workers, the optional GPU add-on, depth maps, fusion and pair matching on the graphics card and the app finding the add-on are merged; the add-on's card in Settings is planned (`plans/2026-10-11-gpu-addon-in-settings.md`).
- **M12 Licensing**: last, by founder decision.

## 3. Now

- **Phase**: M10 integration rounds; app 0.11.4 with pipeline pack 0.5.4, built for the team's first full test round. Earlier rounds brought the pipeline pack install from Settings (40), the Globe street map (41), the session workflow (45), processing that belongs to the project (57), photo depth maps and fusion on several cores (60) and the Quarter mark (62). Rounds 65 to 91 landed on 11 and 12 Oct: photo maps keep their survey date (65) and can be filed under it from the run's warning (88, 90); the photo memory guard and the job stop touch only the job's own processes (66); the GPU add-on's code paths (64, 67, 68, 76: nothing on screen without the add-on); the original review removed (73); the street map under the 3D scene (74); manifest saves that take turns (75) and an import that saves onto the project as it is then (79); job starts that save pending changes first (77); six project types (78); both views alike in Compare dates (81); the agent on every project screen with its show tools (83); sites on the Globe as chips (84); drawings as a dataset (85); native 360 camera files (89).
- **Branch**: `main` at round 91 (app 0.11.4, pipeline pack 0.5.4); merging goes through the Orchestrator session, one branch at a time, and sessions follow the workflow in `CLAUDE.md` ("How a build runs"). CI is Windows-only with six e2e shards and a window of 1100 x 720 at display scale 1 (`CONTRIBUTING.md` has the recipe); macOS is parked in CI, the nightly and the release.
- **In flight**: nothing is building; the team installer 0.11.4 is built from round 91. The GPU add-on's card in Settings waits for the founder's answers to its plan.
- **Next**: finish M10; then the rest of Walks 360 (placing a walk, its path) and the timeline.
- **Owed**: founder review of the choices made in their absence on 11 and 12 Oct, listed in the session notes of those days (`sessions/2026-10-12-0251-four-founder-requests.md`, `sessions/2026-10-12-0110-agent-shows-you-things.md`, `sessions/2026-10-12-0122-globe-project-chips.md`, `sessions/2026-10-11-2251-gpu-acceleration-build.md`); the contract rows of those days say "pending founder review". Decisions those notes raise: what else a project type sets up, drawing and measuring in the second view of a comparison, DWG and IFC drawings, removing a drawing or a walk, ffmpeg in the pipeline pack, walks as a layer kind, the four open points of the GPU add-on's Settings plan (`plans/2026-10-11-gpu-addon-in-settings.md`), a time for timing a real flight with the graphics card, and the GPU spike's scratch folder (about 120 GB outside the repository), which waits for the founder's word to delete. Also owed: the founder's first run of the agent's real-model check (`apps/desktop/e2e/agent-eval.spec.ts`, opt-in, with their own key), until which the agent's two acceptance requests are verified on a scripted model only; real client, asset and site names remain in about 35 tracked files (tests, importer sources, older docs) and need a cleanup; large GeoTIFFs and videos in a codec the app cannot play have no conversion pipeline (the import says so); a survey date cannot be created by hand in Datasets; a processing job still files its results outside the manifest's turn taking; the two Globe tests that draw map packs each failed once in CI on the software renderer and passed on a rerun, cause not found; founder decisions on the online map provider and API key; a **Make 3D Tiles** item on the layer and a screen for building and training AI models are follow-ups of the processing work; macOS stays parked.
