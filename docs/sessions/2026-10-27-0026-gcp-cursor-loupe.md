---
type: session
date: 2026-10-27-0026
branch: feat/gcp-target-zoom
status: complete
related: []
---

# GCP marking gets a cursor loupe at true magnification

## What changed

- The GCP marker's zoom stretched the photo to at most 4 times the viewer width, about 0.77 screen px per photo px on a 4000 px photo, so a target's centre could not be picked. An in-app spike showed three options (deep zoom, cursor loupe, split detail with snap to centre); the founder picked the cursor loupe.
- A 260 px loupe follows the cursor at true magnification (6:1 by default, the wheel steps 2:1 to 12:1, remembered); a click places the mark at the loupe centre, Shift slows the aim, and off the photo the loupe rests on the mark or the prediction.
- The mark is an open crosshair of constant screen size with a gap at the centre. Arrow keys nudge it 1 photo px (Shift 10), saved once the key stops; N and P change photo. Right, middle or Space drag pans. The bar reads e.g. "Photo 1:5.3, loupe 6:1".
- Unit tests in `marks.test.ts` and `GcpMarker.test.tsx`, `e2e/gcp-marking.spec.ts` updated, GCP steps in `docs/TESTING.md`. No contract or pack change. This PR.

## Why

Precise GCP centres drive the georeferencing accuracy of a photo run; the founder could not see the target well enough to click its centre.

## How to test

1. Open a photo run with ground control (Create maps from photos, or an existing run), go to the Ground control tab, import the GCP CSV and click Mark on a point.
2. Move the pointer over the target: a round loupe follows it showing the photo pixels large; the wheel changes its power (the bar shows it).
3. Put the loupe crosshair on the target centre and click: the mark lands there; the loupe label shows the pixel coordinates.
4. Press the arrow keys: the loupe jumps to the mark and it moves 1 pixel per press (Shift for 10). Move the mouse off the photo: the loupe rests on the mark.
5. Zoom the photo with +, then right-drag or Space-drag to pan; Enter confirms and moves to the next photo, N and P change photo.

## Open threads

- Snap to centre (automatic checker-centre detection) was shown in the spike and left out; a possible follow-up.
- A Shift fine aim resets to the cursor point when the photo moves under it. The e2e spec does not drive panning (unit tests do).

## Next session entry point

Founder tests the loupe on a real run; on feedback, tune the default power or add snap to centre.
