---
type: session
date: 2026-10-24-1555
branch: feat/walk-compare
status: complete
related: [../plans/2026-10-24-walk-compare-design.md, ../plans/2026-10-24-walk-compare.md]
---

# 360 walks: compare two walks, the Beam view cone, the track on the ground

## What changed

- Fix: the walk track no longer floats in 3D. One ground sampler (`walks/walkGround.ts`: DSM, then ortho / mesh / cloud, else the pin height) drapes the line, the 3D marker and the spot history track; the line is depth tested. Pins placed on the map now record the 3D ground, so new placements' poses stand on it.
- The Beam marker (founder picked design A of three, judged in an in-app spike): a dot in the date colour with a fading fan that turns with the 360 look, as wide as its field of view, the same size at any map zoom, on the map, drawings and in 3D.
- Compare two walks side by side in the Split: the follower pairs by nearest place (or By time), Link look, Swap lead, a distance chip (neutral under 5 m, amber past it), detour bands on the scrubbers with solo play, a corner map, right-click Compare with walk. Nothing dims (founder: routes can differ a lot).
- Map credit and basemap chip no longer sit over 360 panes. New e2e `walk-compare.spec.ts`; an independent review's 12 findings fixed. No contract change, no pipeline pack change.

## Why

The founder walks roughly the same route on two dates and compares the 360s by eye; pairing has to be by place because pace and path differ.

## How to test

1. Open a project with a placed 360 walk on two dates, over an ortho. In 3D, tilt the camera low: the walk line lies on the ground and hides behind things in front of it.
2. Split with Map on the left and 360 video on the right; play the walk. The map shows a dot with a fan; drag the 360 and the fan turns with it; zoom the 360 in and the fan narrows; zoom the map out and the fan keeps its size.
3. Right-click the March walk in the sidebar, Compare with walk, pick the April walk. Two 360 panes open; play March and April follows by place; the chip reads "x m apart".
4. Drag either 360: both turn together (Link look). Press Swap lead while playing: both keep playing.
5. Where April took another route the chip turns amber and the scrubbers show amber bands; drag April into a band and it plays on its own.

## Open threads

- Walks placed before this change keep their old pose heights until re-placed; spot history bearings and photo / pano poses on a rotated date are moved but not rotated.
- Compare is remembered per project for the session only; pairing uses the placed track, not image matching.
- W3 left: click-to-seek on the path, chevrons and arrow-key hops, the sharp still on pause. W5 left: walk stills in the Timeline compare, overlays in both panes.

## Next session entry point

Founder runs the How to test on local main; then W3 click-to-seek or walks in date lanes (L3).
