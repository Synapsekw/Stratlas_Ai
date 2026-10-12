---
type: session
date: 2026-10-12-2119
branch: docs/wrapup-m10-timeline-walks
status: complete
related:
  [
    ../plans/2026-10-12-m10-hardening-and-docs.md,
    ../plans/2026-10-07-timeline-design.md,
    ../plans/2026-10-07-walks-360-design.md,
  ]
---

# M10 build work, Timeline T2 and T3, Walks W2 and walk processing land

## What changed

- `/whats-next` scoped batch A (six branches) and batch B (three); each branch had an independent review before landing, which found real defects in most. Landed in order: #98 walks design doc scrubbed; #99 agent tools `process_photos` and `accuracy_summary`, Globe tools in the compact profile; #101 the raw 360 **Not stabilised** hint, the stockpile project reopening on its saved date (volumes overrode the focus, and a localStorage key was shared with the timeline show pref), phase 0 plan scrubbed; #102 M10 diagnostics `photo.json`, wizard axe and keyboard tests, perf-m10 CI budgets and an opt-in GPU benchmark (not run), ROADMAP, PRD and SECURITY docs.
- #103 packages carry only `run.json`, `gcp.json` and the report (never `work/`), ticked imagery and terrain packs are clipped to the site and the player's Globe uses them, the journal records tilesets, GCPs and runs, a `FILE_SET_VERSION` baseline; #104 processed orthos, DSMs and change heat maps on the Globe (a PROJ grid placement for the 2 cm rule, a shared tile cache) and the perf-m10 Globe p95 ceiling at 1000 ms from three CI runs.
- #105 Timeline T2: **Add survey date**, flight folder import, one survey date and one photos layer per import, a filing prompt that skips multi-day layers, dated layer names; #106 Timeline T3: a Panoramas split pane paired within 25 m with linked look, **Compare with...** in the tree, the picker grouped by date, `pnpm demo:pano`.
- #108 the `walk` layer kind (app 0.12.0), side-folder walks migrated once (`.layer` marker), **Place walk** with pins on drawings or the map, **Remove walk** to `.trash`; #107 `walk.process`: an `.insv` trailer and IMU reader, a calibrated dual-fisheye stitch (193.5 deg, seam 0.15 deg), a levelled `stabilized.mp4`, an equirect SfM path with a pins-only fallback, ffmpeg in pipeline pack 0.6.0, a minimum-pack gate. `main` is at `8755a2e2`; installer 0.12.0 (205.6 MB) and pack 0.6.0 (archive 448.7 MB, unpacked 1246.9 MB) are built from it in `apps/desktop/dist`.
- Founder decisions: walks are a `walk` layer kind; stabilization gets the Studio hint now and gyro in `walk.process`; ffmpeg in the pack; pack budget 1300 MB, archive budget 500 MB (this branch); scrub both docs; batch B paused, then resumed, to speed batch A. This branch also drops "install ffmpeg" from the guide and TESTING.md.
- Gotchas: local `pnpm check` does not run ruff (CI caught an import order, and cv2 loaded at import broke the meshlab OpenMP rule); vitest's 5 s default is too short for fixture-building tests on CI; a heavier shared e2e fixture froze other specs on CI (basemap-picker); a pack version bump must widen the GPU add-on `packRange` everywhere and update every stand-in pack in the e2e; the 20 concurrent subagent cap stalls many-branch builds; one shared heavy-run lock serialized nine branches.

## Why

The founder asked to finish M10, then the rest of Walks 360 (placing a walk, its path) and the timeline; mid-way they reported raw Insta360 `.insv` files playing unstabilised, which brought the hint forward and gyro levelling into `walk.process`.

## How to test

1. Install `apps/desktop/dist/QuadrionAI-0.12.0-win-x64-setup.exe` and pipeline pack 0.6.0 (TESTING.md, Install; the pack brings its own ffmpeg).
2. Work through the TESTING.md stages M10 (Wi-Fi off for the smoke tests), Timeline T2 and T3, and Walks W1 and W2.

## Open threads

- Founder: Wi-Fi-off M10 smoke tests and the Stage M10 tick-off; installer and pack size sign-off; a window for the GPU benchmark and the 15 min walk benchmark (no long reference walk exists yet); whether the T3 picker should swap dates again; client names still in `docs/architecture/data-conventions.md`, `docs/KNOWN-LIMITS.md` and others; adding ruff to `finish-task`.
- Known limits: walk horizon lean up to about 3 deg in long gentle turns; cloud change needs the Standard preset; a walk removed elsewhere can come back once on a sync-only machine; unsaved pins surviving a `walk.process` manifest reload while placing is unchecked; the drawing pane is small at 1100 x 700 while placing; the CI pack job cache does not cover the ffmpeg conda lock.

## Next session entry point

After the founder's M10 sign-off: Walks W3 to W5 (3D placing, overlays, compare), Timeline T4 (progress reporting) or the GPU add-on Settings card.
