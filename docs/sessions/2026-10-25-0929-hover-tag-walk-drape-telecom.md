---
type: session
date: 2026-10-25-0929
branch: fix/profile-hover-bar
status: complete
related: []
---

# Hover tag, walk drape and telecom groups fixes

## What changed

- The linked hover tag no longer stretches into a dark panel over the 3D view and the map on a fill point: its state classes were the bare `cut` / `fill`, and `fill` is the global `inset: 0` helper in `styles.css`; they are now `is-cut` / `is-fill`.
- Survey and construction projects (older `type: 'volumetric'` projects without a purpose included, via `projectKind`) no longer list Antennas, Sectors or Coverage plan in "In this project", nor the Telecom measure family (Azimuth, Antenna tilt, Clearance); `resetAntennas()` clears a previous project's antennas when the next one loads none.
- 360 walks in 3D drape onto the floor under the walker: the ground ray starts 2.7 m above the walk's stored ground (camera height plus 1 m) so roofs, canopies and towers overhead are skipped, a mesh or cloud floor beats the ortho plane, and the old top-down cast is the fallback. Line, Beam, spot track (and so the 360 camera) and 3D and map pin picks use it.
- Checks: `pnpm check` green; 37 e2e tests the CI way (project-list-groups, pile-panel, linked-hover, every walk spec, spot-history, telecom-antennas) green.

## Why

Founder reports on local `main`: a black bar off the profile hover dot, a walk floating several metres up (up to 30 m beside a tall structure) on a real project, and telecom items in volumetrics projects. The "Timeline shows the footage timeline" report is already fixed on local `main` by the Stage C dates strip.

## How to test

1. Quarry demo: click a pile, Profile tab, move along the chart: the tag stays one small line on the pile, no dark panel on fill points (Map view too).
2. Open a telecom project, then a volumetrics project: the Project tab shows Measurements and Issues only, and the tools have no Telecom group.
3. A project with a walk under a shelter or next to a tall structure, with a cloud or mesh and the ortho shown: in 3D the walk line and Beam lie on the floor, not on the roof or the ortho; a pin clicked through to the ortho lands on the cloud floor.

## Open threads

- Per-walk height offset with Drop to ground (contract change), so walks whose pins sit on a roof or below the floor are corrected, and `pose.json` follows; the drape margin uses the default 1.7 m camera height.
- Timeline: with no video and fewer than two dates the Timeline tile still opens the footage timeline; founder to pick hide or disable with a tip.
- Unknown-kind projects (road, confined space, fusion) still list tower groups when they hold antennas.

## Next session entry point

Hand `fix/profile-hover-bar` to the merge coordinator; then the walk height offset as its own branch.
