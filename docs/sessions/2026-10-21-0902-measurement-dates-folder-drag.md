---
type: session
date: 2026-10-21-0902
branch: feat/measure-dates
status: complete
related:
  [
    ../superpowers/specs/2026-10-20-measurement-dates-design.md,
    ../superpowers/plans/2026-10-20-measurement-dates.md,
  ]
---

# Measurements belong to survey dates and drag between folders and dates

## What changed

- New measurements record their source layer and per-vertex pick kind (model or ground) and are filed under that layer's survey date. Each date folder in Datasets has its own Measurements group and folders; rows drag into, out of and between folders, and right-click Move to folder lists that date's folders.
- Dragging a measurement onto another date moves it and measures it again on that date's matching data. Refusals show in the sidebar note: no matching layer, no data under the shape, model data not loaded, surfaces not prepared, antennas stay on their date. One note with Undo; a later edit retires the Undo. Moving a layer to another date takes its measurements along.
- Older undated measurements are filed automatically when their heights clearly match one date (0.10 m tolerance, 0.25 m margin), marked stale and recomputed; the rest wait in "Needs a date". "Whole site" is retired.
- The Selected panel shows Survey date and Measured on; readouts use the measurement's own date; Copy to another date measures again. The stockpile report keeps one column per prepared date for a dated pile.
- Fixed on the way: a measurement name squeezed to 0 px in narrow dated trees; whole-site region volumes offset on a date lined up after its surfaces were prepared.
- Contract: `SurveyMeasurement` gains optional `source.layer` and `pickedOn` (row in `contract-changes.md`; older apps read and keep them). No Python change, no version bump.

## Why

The founder could not drag measurements into folders and wanted every measurement tied to the survey date of the data it was measured on, movable between dates.

## How to test

1. Open a project with two survey dates and prepared surfaces (Volumes > Prepare surfaces if needed).
2. In 3D, draw a polygon on a date's DSM or cloud: it appears in that date's Measurements group.
3. Right-click it > Move to folder > New folder; drag it out and back in.
4. Drag it onto another date folder: the note says it was measured again; the Selected panel shows the new Survey date and Measured on, and the values change. Undo in the note restores it.
   Or right-click the row > Move to date > another date: the same move and note, no drag needed.
5. Drag an antenna measurement to another date: refused, antennas stay on their date.
6. Drag a DSM layer to another date: its measurements follow.
7. Open an older project with undated measurements: a note says how many were filed (Undo available); the rest sit under "Needs a date".

## Open threads

- Evidence: `pnpm check` green (13213 tests); e2e the CI way 41/41 across 12 specs, then 11/11 after the last fix wave. Two unit tests (`compareStore.test.ts`, `main/packages.test.ts`) time out at 5 s under full parallel load on this PC.
- Whole-site region starting heights still come from stage terrain; a stale move is dropped silently on a race; follow ignores volume-hint-only dates; the `.titem .tm` 50 percent cap is global; `copyToSurvey` and `setScope` are unused in `measureStore`.
- Calls to overturn if wrong: backfill thresholds; a Needs-a-date drag files without measuring again; antennas follow a moved layer with values unchanged; a layer move keeps the folder name; the report keeps per-date columns.

## Review fixes

The release review of this PR found seven points; all are fixed in this PR, each with tests. A comparison of survey A with survey B, moved onto B, is refused (it would compare B with itself and show 0 cut and fill). The measurement row menu has a Move to date submenu, the keyboard path of the folder drop (disabled for antennas and while read-only), and the panel's Needs a date line names it. A measurement whose date was deleted is filed like a Needs a date one, and a no-match note without a layer name reads cleanly. The backfill stores its recomputed results as derived numbers, so only the filing is unsaved, and an Undo (or Revert) of the filing is remembered per project in localStorage so later sessions do not file those again. `MeasurementSource` is a loose object (contract row updated). A model-only measurement moves to a date with no prepared ground, and a date with no height map gets its own refusal without Prepare. The report samples terrain through the line-up the surface was prepared with, as the panel does. The measurement-dates e2e now waits for three still reads before drawing (a read before the flight started passed at once). Evidence: `pnpm check` green (13275 tests); e2e the CI way: measurement-dates 3/3 with repeat-each, measurement-layers and sections 7/7. Left: the review's optional nit on exporting `MeasurementsFileStrict`; the declined-backfill memory is per computer, not in the project.

## Next session entry point

Land this branch first in the 0.25.0 train (the release session coordinates), Volumetrics after; then fix the follow-ups above.
