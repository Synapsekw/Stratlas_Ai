---
type: north-star
last-updated: 2026-10-19
---

# North star

The entry point for every session: where the product is going, what is done, and what is happening now. It is a live snapshot, not a log. `/wrapup` overwrites section 3 at the end of each working block; history lives in [sessions/](sessions/) and decisions in [architecture/adr/](architecture/adr/).

## 1. Goal

Quadrion AI: one offline-first Windows desktop app for reviewing, surveying and modelling construction sites from drone and survey data, tested internally until the founder says otherwise (no public releases, no `v*` tags).

## 2. Milestones

The full table, with plans, is [plans/ROADMAP.md](plans/ROADMAP.md). Status and one line each:

- **M1 to M9**: done and merged; founder testing.
- **M10 Globe and photogrammetry**: build work landed (app 0.12.0, pipeline pack 0.6.0); photogrammetry now runs on OpenDroneMap 3.6.2 (`feat/odm-engine`, pack 0.8.0, ADR 0012); founder sign-off pending (Wi-Fi-off smoke tests, Stage M10 tick-off, size budgets).
- **M11 Surveying**: core and later phases integrated 9 Oct 2026; G12 AI helpers (Suggest boundaries, Snap to ortho edges) approved and built 10 Oct 2026, with MobileSAM in the pipeline pack (ADR 0011).
- **Timeline** (`plans/2026-10-07-timeline-design.md`): T1 to T3 landed (survey dates, adding survey dates, compare across dates); spot history S1 (one spot on every date, `plans/2026-10-13-spot-history.md`) landed, S2 (spot on the map) next; T4 (progress reporting) after. Date lanes L1 (one lane per date on a time-of-day axis, `plans/2026-10-14-timeline-date-lanes-design.md`) landed 15 Oct; L2 Sync dates and L3 walks in lanes next.
- **Walks 360** (`plans/2026-10-07-walks-360-design.md`): W1 and W2 landed (camera file import and player, the `walk` layer kind, placing with pins, `walk.process` with a levelled stabilized video and a path); W3 to W5 (3D placing, overlays, compare) next.
- **Drone panoramas** (`plans/2026-10-13-drone-panoramas-design.md`): P1 landed 13 Oct (raw DJI sphere frames grouped, stitched by `pano.stitch`, one marker per sphere; app 0.13.0, pipeline pack 0.7.0); P2 viewer, P3 lifecycle and P4 Augment panel next.
- **GPU acceleration**: the add-on and its Settings card are dropped with our own engine (ODM uses the graphics card itself, ADR 0012); earlier state: in progress (`plans/2026-10-10-gpu-acceleration.md`): the spike, the CPU workers, the optional GPU add-on, depth maps, fusion and pair matching on the graphics card and the app finding the add-on are merged (the add-on lock is 0.1.1 for packs 0.5 to 0.7; the hand-installed 0.1.0 is refused next to pack 0.7.0 until 0.1.1 is built); the add-on's card in Settings is planned (`plans/2026-10-11-gpu-addon-in-settings.md`).
- **M12 Licensing**: last, by founder decision.

## 3. Now

- **Phase**: **Installer 0.22.0 with pipeline pack 0.17.0** is on `main` (`sessions/2026-10-19-0700-release-0-22-0.md`); it carries measurement layers (#184), RF coverage simplified (#188), Line up dates with a turn and a scale, local detection on 360 video, antenna review and everything earlier (see those days' session notes). The ODM install fix in this PR lands after it and needs a new installer build to reach testers; builds happen only when the founder asks.
- **Branch**: `fix/odm-install-check` (this PR, `sessions/2026-10-19-2155-odm-install-check.md`): the ODM first-start check gets 10 minutes, logs to `main.log` and an Inno setup log, hints at a missing VC++ runtime, and a slow first start keeps ODM installed as unverified with a Try again button (additive `OdmState.unverified` contract row). Landings go in batches through a `train/...` branch by the stage-island session (`CLAUDE.md` has the merge lock); CI is Windows-only with six e2e shards at 1100 x 720, scale 1, WARP (`CONTRIBUTING.md`); macOS is parked.
- **In flight**: measurement layers follow-up (filter box at the top of the Measurements group, a second delete keeping the first Undo, a wider save guard, a ready check in `saveMeasurements`); stage 2 of Line up dates (point clouds and directions turn); local detection follow-ups (one streaming ffmpeg per walk, wrapping boxes cannot be resized, the operator near the lens gives large boxes); antenna review follow-ups. ODM install follow-ups: an older-version unverified install reads as update-available, and "for the first time" shows on Try again.
- **Next**: confirm the ODM cause on a tester PC with the new log after the next installer build; local detection on ordinary video clips; RF coverage follow-ups (Edit RF in the antenna list, AI resolving unmatched cell-export text, a captureId on runs); UI foundation Milestone B and UI rework projects 3 and 4; Agent coverage (`plans/2026-10-15-agent-coverage-gaps.md`, `rank_locations` first); the guide's final pass; drone panoramas P2/P4, spot history S2, Walks W3 rest to W5, Timeline T4, date lanes L2/L3; the real 995-photo ODM run once the founder names a window.
- **Owed**: founder: install the next build and try the How to test steps of `sessions/2026-10-19-2155-odm-install-check.md` (ODM install, `main.log`, the setup log, Try again on a slow PC), `2026-10-18-2238-measurement-layers.md`, `2026-10-19-0101-rf-coverage-simplify.md`, `2026-10-19-0223-line-up-turn-and-scale.md` (needs pack 0.17.0), `2026-10-18-2345-local-detection-360-video.md`, `2026-10-18-2215-antenna-review.md`; review the contract rows marked "pending founder review" and the rulings in the recent notes; decide whether the pack segmentation model (SAM) should follow the relaxed licence gate (18 Oct); sign-offs still open: Wi-Fi-off M10 smoke tests, installer and pack size budgets. Earlier owed items stay in their session notes. Known flaky e2e (rerun the failed job once): `panels.spec.ts:617`, `panels.spec.ts:405`, `globe.spec.ts:1012`, `globe.spec.ts:1573`, `perf.spec.ts:381`, `platform.spec.ts:204`, `compare.spec.ts:477`.
- **Engineering checkpoint**: [Engineering review workbench integration](sessions/2026-10-18-0745-engineering-review-workbench.md) carries the source-based modelling and correction workflow from [Model correction review](sessions/2026-10-17-model-correction-review.md). Review uses shared UI parts, preserves unsaved feedback across workbench remounts and keeps one comparison scene owner through drawer transitions. Publication requires full checks and CI-style engineering, inspection and georeference tests. The scripted correction benchmark does not establish live AI correction quality or a complete drawing-free equipment inventory. The UI integration owner alone handles the merge lock and main push.
