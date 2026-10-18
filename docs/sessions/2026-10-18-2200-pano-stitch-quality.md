---
type: session
date: 2026-10-18-2200
branch: fix/pano-stitch-quality
status: complete
related:
  - docs/sessions/2026-10-14-0738-drone-panoramas-p1.md
---

# Drone panorama stitch quality

## What changed

- New `light` step in `pano.stitch` (`pano/photometry.py`):
  - What it fits: per-frame gains and one lens falloff, in linear light, from where frames overlap. The EXIF exposure (`FrameInfo.ev`) is a weak prior.
  - How it applies them: a smooth exposure field over the sphere gives back part of the camera's own exposure (the sky towards the sun stays blue), then one tone curve with a soft shoulder.
- Alignment (`align.py`):
  - Pairs the adjusted sphere still disagrees with (parallax from drone drift) are dropped and the adjustment is run again.
  - Frames without matches (open water, plain sky) now take their neighbours' correction instead of the raw gimbal angles.
  - Stopping at the evaluation cap is no longer treated as "did not converge".
- Compose (`compose.py`):
  - Seams are kept 6 degrees inside frame borders.
  - Frames are extended past their footprint before the multi-band blend, which removes the dark halo along the top edge.
  - The sky fill takes its colour from a circular median, so towers no longer smear into it, and fades only into pixels that look like sky.
- Tests:
  - new `test_pano_photometry.py`, plus cases in the align, compose, geometry, stitch and synth tests;
  - `pano_synth.py` can now render exposure steps and vignetting.
  - All 69 pano tests and the full Python suite pass.
- No contract change: `stitch.json` keeps its fields, and `timings` gains a `light` key (it accepts any keys).

## Why

Real spheres from a coastal site showed blocks and bars over water and sky and were misaligned. On real data the causes were:

- **Exposure:** auto exposure varied by 3.7 stops within a sphere, and one gain per frame on the JPEG could not even that out.
- **Unmatched frames:** 8 of 26 frames over water had no matches and kept gimbal angles about 2 degrees off.
- **Fallback:** one sphere fell back to gimbal angles entirely.

After the fix, all five real spheres align from features and the bars, blocks and ghosted towers are gone. Lens distortion was measured and is negligible (k1 0.004), so it is not modelled.

## How to test

1. Needs a pipeline pack built from this PR. Open a project with drone panoramas (or import a sphere's frames) and click **Stitch** on a sphere row.
2. Open the panorama. Over open water and sky there should be no rectangular blocks or vertical bars, the sea should read as one surface, and tall structures should be whole rather than doubled.
3. Look towards the sun. The sky should brighten smoothly, with no white band.

## Open threads

- The stitch takes about 50 s per sphere at 8K on 24 cores, up from about 30 s (two adjustment passes plus the light step).
- A frame's top corner beyond the sphere's coverage is still cut flat by the sky fill; there is nothing photographed there.
- A tall structure that reaches past the top row still loses its top to the sky fill.

## Next session entry point

Build a pack with this change for the founder. Drone panoramas P2 or P4 are next on that track.
