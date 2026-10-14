---
type: session
date: 2026-10-14-2004
branch: docs/wrapup-scene-online-ground
status: complete
related:
  [
    sessions/2026-10-14-1734-installer-0-14-0.md,
    sessions/2026-10-14-1509-satellite-providers-map-menu.md,
  ]
---

# The 3D scene's online map covers the ground

## What changed

- Founder report on installer 0.14.0: picking Esri or Mapbox in the 3D scene showed "a line blocking half of the view".
- Root cause: the plain grey ground plane stayed visible a few centimetres from the flat online-imagery mesh; at distance they z-fought and the grey won along a ragged line.
- Fix (PR #128, landed at `8e59d667`): `showSurroundings` in `apps/desktop/src/renderer/workspace/siteTiles.ts` registers the landscape (online map or pack imagery and terrain) as the scene's ground, so the plain ground hides as it does for the street map. Flat landscapes settle just under the lowest model through the shared `groundLevel` and `settleUnder`, now in `siteBasemap.ts`. `packages/tiles/src/surroundings.ts` marks meshes without heights as flat.
- An independent review caught a blocking regression before the merge: projected drone video lost its ground. Fixed by registering the landscape as a projection receiver.
- Tests: unit tests in `surroundings.test.ts` and `siteTiles.test.ts`, and a 3D check in `apps/desktop/e2e/online-map-sources.spec.ts` (landscape shown, plain ground hidden, drape on, pixels probed from a far low camera, plain ground back after switching to streets). CI was green on the first run.
- Earlier in the block: the 0.14.0 wrap and the onlineTiles cache-write fix (#127, `70f759a4`), covered by the installer 0.14.0 note.

## Why

Installer 0.14.0 shipped the online maps in 3D, and the founder's first look showed a band across the view. The ground had to be the landscape itself, not a second surface beside it.

## How to test

Needs a build newer than 0.14.0.

1. Open a project placed on the Earth and go to the 3D view with graphics set to Medium or higher.
2. In the Map chip, pick Esri World Imagery, then a Mapbox style.
3. The imagery should cover the ground with no grey floor or grid over it.
4. Zoom out and tilt low toward the horizon: there should be no grey band or ragged line.
5. A projected drone video should still drape onto the ground.
6. Switching back to streets should look as before.

## Open threads

- 0.14.0 does not contain this fix; a 0.14.1 build is the founder's call.
- The online landscape in 3D reaches 3 km around the site, against 12 km for the street map, so a clean edge can show at low angles on big sites.
- Mapbox 512 px tiles in 3D are not driven by e2e.
- The comparison's second view draws no landscape (existing behaviour).
- On abort, `useSiteSurroundings` disposes the geometry but not the material or texture (older code).
- Pack terrain landscapes now also hide the plain ground and grid, so shadows fall on the landscape only.

## Next session entry point

Wait for the founder's 3D check and the 0.14.1 decision; otherwise continue with drone panoramas P2 or spot history S2.
