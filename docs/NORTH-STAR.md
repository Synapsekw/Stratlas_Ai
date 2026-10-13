---
type: north-star
last-updated: 2026-10-13
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
- **Timeline** (`plans/2026-10-07-timeline-design.md`): T1 to T3 landed (survey dates, adding survey dates, compare across dates); spot history S1 (one spot on every date, `plans/2026-10-13-spot-history.md`) merging, S2 (spot on the map) next; T4 (progress reporting) after.
- **Walks 360** (`plans/2026-10-07-walks-360-design.md`): W1 and W2 landed (camera file import and player, the `walk` layer kind, placing with pins, `walk.process` with a levelled stabilized video and a path); W3 to W5 (3D placing, overlays, compare) next.
- **GPU acceleration**: in progress (`plans/2026-10-10-gpu-acceleration.md`): the spike, the CPU workers, the optional GPU add-on, depth maps, fusion and pair matching on the graphics card and the app finding the add-on are merged; the add-on's card in Settings is planned (`plans/2026-10-11-gpu-addon-in-settings.md`).
- **M12 Licensing**: last, by founder decision.

## 3. Now

- **Phase**: M10 build work is done and waits for the founder's sign-off; Timeline T1 to T3 and Walks W1 and W2 landed on 12 Oct; on 13 Oct **Delete and Start over** landed (#111, `sessions/2026-10-13-1700-delete-and-start-over.md`): Delete... on Datasets rows, groups and date folders with multi-select, a 7-day project trash with Empty, and Delete run and Start over... in the Processing drawer. Spot history S1 was also built (`feat/spot-history`, merging): click an image and see that spot on every survey date (photos, 360s, walk frames, videos; date strip, Compare with linked zoom), `sessions/2026-10-13-1725-spot-history-s1.md`.
- **Branch**: `main` at `0d994a51` (app 0.12.0, pipeline pack 0.6.0), with `feat/spot-history` merging (not yet on main); there is no Orchestrator: each session merges its own branch, one at a time under a merge lock (`CLAUDE.md`). CI is Windows-only with six e2e shards, a window of 1100 x 720 at display scale 1 and the WARP software renderer (`CONTRIBUTING.md` has the recipe); a cloud routine checks the nightly every morning at 07:00 Riyadh time; macOS is parked.
- **In flight**: `feat/spot-history` (S1) is landing; the photo-scale branch (pipeline pack 0.6.1, untwine COPC, new work layout) is rebasing onto this `main` and merges later. Installer 0.12.0 and pack 0.6.0 in `apps/desktop/dist` were built from `8755a2e2` and predate Delete and Start over and spot history.
- **Next**: spot history S2 (pick a spot on the map, ortho or 3D, camera cones, play-through), then Timeline T4 (progress reporting) with the spot sheet; after the M10 sign-off, Walks W3 to W5 (3D placing, overlays, compare), the in-app Restore from the project trash, or the GPU add-on's Settings card (`plans/2026-10-11-gpu-addon-in-settings.md`, waits for the founder's answers).
- **Owed**: founder: a screenshot or project path for the DJI drag-drop report (MP4 + .SRT + .LRF shown as a separate dataset under Video; unconfirmed); Wi-Fi-off M10 smoke tests and the Stage M10 tick-off; installer and pack size sign-off; a window for the GPU benchmark and the 15 min walk benchmark; whether the T3 picker should swap dates again; ruff in `finish-task`; review of the choices of 11 and 12 Oct in those days' session notes (contract rows say "pending founder review") and the first run of the agent's real-model check (`apps/desktop/e2e/agent-eval.spec.ts`). Spot history follow-ups: walk frames have no e2e (no placed-walk fixture); dialog a11y polish; an arrow key in the Media inline strip opens the modal; walk tracks recomputed with two strips; misleading "no position" text if the layer is removed while open; founder review of the S1 choices (ranges 15 m, 25 m, 10 m). Other follow-ups: peer file cleanup on hub sync after a delete; the eye plus "N selected, Delete..." header fit at 252 px not seen visually. Known limits: walk horizon lean up to about 3 deg in long gentle turns; cloud change needs the Standard preset; a walk removed elsewhere can come back once on a sync-only machine; unsaved pins across a `walk.process` manifest reload while placing are unchecked; the drawing pane is small at 1100 x 700 while placing; the CI pack job cache does not cover the ffmpeg conda lock; held entries from failed removals can leak space by design. Cleanup: `check-public-text` flags a site name in `packages/ui/src/i18n/en.ts` (line 1239) on main; real client, asset and site names remain in tracked files (`docs/architecture/data-conventions.md`, `docs/KNOWN-LIMITS.md`, tests, importer sources); large GeoTIFFs and unplayable video codecs have no conversion pipeline; a processing job still files its results outside the manifest's turn taking; a lighter Globe on the Low tier; a samples spec inspection test fails about one run in six; the online map provider and API key; a **Make 3D Tiles** item and an AI model training screen are follow-ups.
