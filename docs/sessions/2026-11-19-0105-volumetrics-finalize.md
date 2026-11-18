---
type: session
date: 2026-11-19-0105
branch: feat/volumetrics-finalize
status: complete
related:
  - plans/2026-11-18-volumetrics-finalize.md
  - architecture/adr/0013-one-volume-engine.md
  - design/glossary.md
---

# Volumetrics finalized for the founder's test

## What changed

- This PR is the first section under the feature freeze of 18 Nov 2026: a plan (`plans/2026-11-18-volumetrics-finalize.md`, 58 punch items, the founder's five decisions in its section 6) and its "Do now" items. No new capability, no contract change, no pipeline pack change.
- One home for each thing: Project > Volumes is the list, Tools > Volumes holds Draw volume and Swipe, a pile always opens in Selection with Back to inventory, the kit Section tile and the Volume bodies control are retired, and "Open the volumes table" stays in the palette.
- One name for each thing: a base reads the same in every picker, list, CSV and report (Toe surface is the standard), with its level where it has one; "Cut & fill", Materials, Dates strip, Volume over time and Volumetric report, held by the glossary test.
- Fixes: a pile deleted on purpose stays gone when piles are detected again, with a note that says so; the number beside Volumes counts the list; a click near another pile's profile line opens the pile; the pile heat legend names the pile; a Map fly lands above the chart window; the inventory fits the small window; a typed weighed tonnage says it is not saved and no longer survives a reopen; export files are named for what they hold.
- Evidence: `pnpm check` green; the new `volumes-finalize.spec.ts` and about 30 changed or affected specs green the way CI runs them, the changed ones also three times in a row; an independent review, its findings fixed (one was not a defect: the report's design cells never took a base).
- The local real-data stockpile spec is rewritten to follow the project as it is, with a figure comparison against a reference file; it has not been run.

## Why

The founder froze features on 18 Nov 2026: one section is finalized, tested and approved before the next (volumetrics, telecom, confined spaces, vertical asset inspection). Volumetrics had grown two homes, several names for one base and a list of loose ends spread over seven notes.

## How to test

The full list is section 5 of `plans/2026-11-18-volumetrics-finalize.md` (36 steps, each with its demo, clicks, expected result and the test that drives it). The short version, on the Quarry demo:

1. Tools > Measure > Volume: draw a pile, Save, Stop, Recompute. It appears in Project > Volumes and the number beside Volumes matches the list.
2. Click a pile in 3D, on the Map, in the sidebar and in the inventory: the same panel in Selection, with Back to inventory.
3. In the panel switch Base to Lowest point and back, Save, close and reopen: the figure and the base name are kept, the same name everywhere.
4. Project > Volumes: Inventory, Cut & fill with another From and To, Materials with a density from a later date; Export saves `Volume-over-time.csv`.
5. Dates strip: click a marker, Compare, Play, Esc.
6. Reports > Open volumetric report: Take pictures, edit, Export PDF and HTML, open the HTML offline.
7. On the stockpile sample: delete a pile, Save, detect piles again (Settings > Processing tools > Advanced, or Detect piles in the empty list): it stays gone and a note says so.
8. Once, on a real two-date project: the comparison run of part E of the list (site totals within 1 %, each pile within 5 %), and a read of ADR 0013.

## Open threads

- For the founder: three points as built to confirm. Detect piles shows only in the empty list (as before) and otherwise runs from the Processing tools; an old-kit pile without a measurement shows only its toe line; Tools > Volumes holds only Draw volume and Swipe.
- By eye only: the pile look, the timelapse crossfade and 3D swap, colours over 3D models, report branding, Wi-Fi really off.
- Deferred past the freeze (plan section 2): volume uncertainty, repeat reports, PPK, geoid grids, weighbridge calibration, AI pile detection, Detect piles on more than two dates, one merged volume card, Swipe in every project.
- Small leftovers: unused `measuredShown` plumbing in `@aio/volumetric`; faint outlines of other piles in a wide 3D view; an open inventory row click during an issue edit is unit-tested only; ADR 0013 stays Proposed until the founder reads it.

## Next session entry point

After the founder's test of section 5 and the real-data run, fix what they find on a new branch; then the telecom section gets the same treatment.
