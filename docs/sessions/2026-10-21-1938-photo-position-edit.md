---
type: session
date: 2026-10-21-1938
branch: feat/photo-position-edit
status: complete
related: [docs/plans/2026-10-21-photo-position-edit.md, docs/architecture/contract-changes.md]
---

# Edit photo position and read thermal drone photos

## What changed

- **Edit position:** X/Y/Z in site metres. One photo gets set values; several photos get a shift. Corrections are stored in `orientation.json` next to the original, with an Edited mark, a ring on map and 3D markers, Reset to original, and Undo/Redo. Media now multi-selects.
- **XMP-inside-Exif reader fix:** the app reads DJI AbsoluteAltitude, RelativeAltitude and gimbal angles. Wrapped unsigned GPS altitudes are read as signed, in TS and in Python.
- **Thermal `_R` photos with no DJI XMP** take the position of their visual twin (captured within 3 s) as an Edited correction.
- **Re-read photo positions** dataset action for existing projects.
- **ODM** gets the corrected positions; pack 0.21.0 writes `correctionsHonoured`. Contract row in `docs/architecture/contract-changes.md`; plan `docs/plans/2026-10-21-photo-position-edit.md`.
- Evidence: `pnpm check` green (13,941 tests), Python about 2,427 passed, CI-way e2e (photo-position-edit, sidebar-menus, pinned-media, align-to) 14 passed. An independent review found 4 important issues, all fixed; the re-review is clean.

## Why

The founder asked to analyse radiometric thermal JPEGs and to edit photo GPS and altitude by hand after XT2 photos imported at wrong heights. Root cause: the XT2 writes its XMP inside the Exif APP1 block, so the app missed it, and FLIR-written thermals store a negative altitude as unsigned (one photo read as 4,295 km). The XT2 barometric home was also 46 m off, so photos still need a Z shift after import; Edit position covers that.

## How to test

1. In an old XT2 project, right-click the photos dataset, choose Re-read photo positions and confirm, picking the originals folder if asked. Photos get view cones, and the far-off thermal sits by its visual twin, marked Edited.
2. Or import the XT2 folder into a new project: same result.
3. The photos still sit about 46 m low. In Media, click the first photo, Shift-click the last, right-click, Edit position. The panel says "Shift N photos". Type 46 in Z and Save. All rise 46 m and show Edited, with a ring on the map and in 3D. Undo and Redo are in the notice.
4. Right-click one photo, Edit position: X/Y/Z and the original are shown. Change Z and Save: the marker and the camera move.
5. Right-click a map marker, Reset to original: it goes back and the ring goes.
6. On a pinned photo, Edit position is greyed: "Pinned: use Move pin."
7. Processing with pack 0.21.0 sends the edited heights to ODM. After Use refined poses, those photos' Edited marks clear.

## Open threads

- No app-side minimum-pack gate; no automatic restore from the poses backup.
- A thermal copies its twin's imported view direction, not a turned one.
- Site names remain in older e2e specs and one `en.ts` string, predating this PR.
- 360s are not covered by Edit position.
- In flight on another branch (`feat/thermal-analysis`): thermal analysis. Design and plan approved, M1 (decoders and settings) being built; spec `docs/superpowers/specs/2026-10-21-thermal-analysis-design.md` on that branch. XT2 via exiftool raw plus Planck, DJI TSDK 1.7; a Thermal bench with spot, box, line and polygon readings, palettes, isotherm, auto hot spots, severity by delta T (adjustable), issues and pins, a Reports section and CSV.

## Next session entry point

Merge this PR through the train, then the founder tries the steps above on a real XT2 project with pack 0.21.0. Thermal analysis M1 continues on `feat/thermal-analysis`.
