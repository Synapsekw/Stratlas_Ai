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
- **M10 Globe and photogrammetry**: build work landed (app 0.12.0, pipeline pack 0.6.0); founder sign-off pending (Wi-Fi-off smoke tests, Stage M10 tick-off, size budgets).
- **M11 Surveying**: core and later phases integrated 9 Oct 2026; G12 AI helpers (Suggest boundaries, Snap to ortho edges) approved and built 10 Oct 2026, with MobileSAM in the pipeline pack (ADR 0011).
- **Timeline** (`plans/2026-10-07-timeline-design.md`): T1 to T3 landed (survey dates, adding survey dates, compare across dates); T4 (progress reporting) next.
- **Walks 360** (`plans/2026-10-07-walks-360-design.md`): W1 and W2 landed (camera file import and player, the `walk` layer kind, placing with pins, `walk.process` with a levelled stabilized video and a path); W3 to W5 (3D placing, overlays, compare) next.
- **GPU acceleration**: in progress (`plans/2026-10-10-gpu-acceleration.md`): the spike, the CPU workers, the optional GPU add-on, depth maps, fusion and pair matching on the graphics card and the app finding the add-on are merged; the add-on's card in Settings is planned (`plans/2026-10-11-gpu-addon-in-settings.md`).
- **M12 Licensing**: last, by founder decision.

## 3. Now

- **Phase**: M10 build work is done and waits for the founder's sign-off; Timeline T1 to T3 and Walks W1 and W2 landed on 12 Oct (#98 to #108, `sessions/2026-10-12-2119-m10-timeline-walks-batches.md`): M10 hardening (diagnostics, perf budgets, packages without `work/`, site-clipped map packs, processed products on the Globe), Timeline T2 and T3, the `walk` layer kind with **Place walk**, and `walk.process` with ffmpeg in pipeline pack 0.6.0.
- **Branch**: `main` at `8755a2e2` (app 0.12.0, pipeline pack 0.6.0); there is no Orchestrator: each session merges its own branch, one at a time under a merge lock (`CLAUDE.md`). CI is Windows-only with six e2e shards, a window of 1100 x 720 at display scale 1 and the WARP software renderer (`CONTRIBUTING.md` has the recipe); a cloud routine checks the nightly every morning at 07:00 Riyadh time; macOS is parked.
- **In flight**: nothing is building; installer 0.12.0 (205.6 MB) and pack 0.6.0 (archive 448.7 MB, unpacked 1246.9 MB) are built from `8755a2e2` in `apps/desktop/dist`. This wrapup branch raises the pack archive budget to 500 MB and drops "install ffmpeg" from the guide.
- **Next**: after the M10 sign-off, Walks W3 to W5 (3D placing, overlays, compare), Timeline T4 (progress reporting) or the GPU add-on's Settings card (`plans/2026-10-11-gpu-addon-in-settings.md`, waits for the founder's answers).
- **Owed**: founder: Wi-Fi-off M10 smoke tests and the Stage M10 tick-off; installer and pack size sign-off; a window for the GPU benchmark and the 15 min walk benchmark (no long reference walk exists yet); whether the T3 picker should swap dates again; adding ruff to `finish-task` (local `pnpm check` does not run it); review of the choices of 11 and 12 Oct in those days' session notes (contract rows say "pending founder review"): what else a project type sets up, drawing and measuring in a comparison's second view, DWG and IFC drawings, removing a drawing, the GPU spike's scratch folder (about 120 GB outside the repository) and the first run of the agent's real-model check (`apps/desktop/e2e/agent-eval.spec.ts`). Known limits: walk horizon lean up to about 3 deg in long gentle turns; cloud change needs the Standard preset; a walk removed elsewhere can come back once on a sync-only machine; unsaved pins across a `walk.process` manifest reload while placing are unchecked; the drawing pane is small at 1100 x 700 while placing; the CI pack job cache does not cover the ffmpeg conda lock. Cleanup: real client, asset and site names remain in tracked files (`docs/architecture/data-conventions.md`, `docs/KNOWN-LIMITS.md`, tests, importer sources); large GeoTIFFs and unplayable video codecs have no conversion pipeline; a processing job still files its results outside the manifest's turn taking; a lighter Globe on the Low tier; a samples spec inspection test fails about one run in six; the online map provider and API key; a **Make 3D Tiles** item and an AI model training screen are follow-ups.
