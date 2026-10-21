---
type: session
date: 2026-10-21-2124
branch: feat/thermal-analysis
status: complete
related: []
---

# Thermal analysis M1: decoders and settings

## What changed

- Spec `superpowers/specs/2026-10-21-thermal-analysis-design.md` and plan `plans/2026-10-21-thermal-analysis.md`; M1 built on this branch and goes in this PR.
- Python: a FLIR APP1/FFF decoder (XT2 raw is plain little-endian 16-bit words) with the radiometric physics matching an independent reference within 0.01 °C, and a ctypes binding to the DJI Thermal SDK 1.9 (byte-identical to `dji_irp.exe` on the SDK samples; 1.7 is no longer downloadable, the founder approved 1.9).
- Pipeline pack 0.22.0 bundles ExifTool 13.59 and the DJI SDK with notices (CI caches both). The `thermal.decode` job writes float32 °C rasters under `thermal/rasters`, cross-checked against ExifTool raw values with plausibility bounds.
- IPC `thermal:probe`, `thermal:read`, `thermal:write` (journaled); the Thermal bench: palette, auto range, hover °C, settings line and editor, filmstrip, held-status notes, read-only for packages. e2e `thermal-bench.spec.ts` and the `thermal-additive` compat test; `THERMAL_MIN_PACK` is 0.22.0 (photo position edit took 0.21.0).

## Why

Thermal photos were only photos; engineers need real temperatures with per-photo emissivity, distance, air and humidity settings before any measuring tools. The design's claim that flyr reads a wrong offset was wrong; the spec is corrected.

## How to test

1. Install pipeline pack 0.22.0 built from this branch (Settings > Processing tools > Choose file).
2. Open a project folder with an XT2 or DJI thermal dataset imported as photos.
3. Right-click the photos dataset in the sidebar > Analyse thermal. The Thermal tab opens and "Reading temperatures of N photos" shows while it decodes.
4. Hover the image: the temperature shows in °C with one decimal. Change the palette; press Auto range.
5. Press Edit on the settings line, set Emissivity 0.80 for This photo, save: a hot spot reads higher after the re-decode, the background barely changes.
6. Pick other photos in the filmstrip (only thermal photos are listed).
7. Open the same project as a .aio package: the bench is read-only and says "Open the project folder to analyse thermal photos."

## Open threads

- Verified: `pnpm check` 14064 passed; Python suite 2494 passed; Playwright the CI way 11/11 (thermal-bench, photo-position-edit, sidebar-menus); local pack build and smoke decode ok (85.0 °C patch); on a private XT2 sample raw values and constants match ExifTool, 54 of 54 photos parse.
- Follow-ups: palette group aria label string; range-end drag (M2); the plan's M3 block pack number; the settings line shows 10 m before a raster for photos without relAlt; the probe runs sequentially on large layers.

## Next session entry point

M2 bench tools: spot, box, line profile, polygon, isotherm, range drag, a visual twin view using `thermalTwin.ts`, lens table and nudge. M3 takes pack 0.23.0. M4 report and CSV can start on its own branch once M1 lands.
