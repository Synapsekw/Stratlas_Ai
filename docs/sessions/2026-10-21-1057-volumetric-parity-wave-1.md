---
type: session
date: 2026-10-21-1057
branch: feat/volumetric-parity
status: complete
related:
  - ../superpowers/specs/2026-10-20-volumetric-parity-design.md
  - ../superpowers/plans/2026-10-20-volumetric-parity-wave1.md
  - ../architecture/adr/0013-one-volume-engine.md
---

# Volumetric parity Wave 1

## What changed

- One profile chart everywhere (sections, pile detail, elevation over time, the report): chips for dates, designs and base, fixed styles by kind, "Shade vs", a hover readout, units on the axes, and PNG, DXF, CSV and Add to report.
- One measurement card for every tool; elevation history moved into the point card; the road and globe measures use it; the dormant engine measure tool is gone.
- One volume engine: the stockpile kit's base maths and screens are retired. Old projects carry their kit figures labelled "From an earlier version"; recomputing with the standard base (the triangulated toe, one of seven bases) replaces them and keeps "was". Kit piles are matched by outline across rebuilds.
- Volume over time across every survey date: card chart and table, a Volumes view with site inventory, a "Not counted" list, a CSV and a report section.
- Report template stored in the project (travels in .aio exports), Add to report, single-measurement export; the PDF uses the same chart and card. The assistant reads engine figures.
- Fixes: a window freeze opening a pile card on large real surveys, and tonnage 1000x too small. Pack 0.20.0; contract changes additive.
- After the landing review: Recompute all keeps figures from an earlier version (replacing them is its own confirmed action); old projects keep their tonnage at the kit's density, worked out when read; the inventory chart's change matches its table; a saved road line keeps one height rule; a To side on a level or custom base is editable; Add to report saves unsaved measurements first; Remove from report and Clear report template; the report template file is open to later additions; moving a converted pile no longer brings it back; the stockpile map shows every pile.

## Why

Volumes and measurements had grown as separate looks and engines. Wave 1 makes them one family, on the way to Propeller and DroneDeploy parity.

## How to test

1. Open a volumetric project made with an earlier version: each pile shows its old figure, labelled "From an earlier version", numbers unchanged, with tonnes at the old density.
2. Open the Volumes view, click a pile: volume, tonnes, base and "± across bases". Pick "Recompute with the standard base"; the figure updates and "was" shows the old one.
3. Back in the Volumes view, click Recompute all: the piles from the earlier version keep their figures, and a note says so. Click "Recompute N earlier-version piles with the standard base": a dialog asks first; Cancel changes nothing, the confirm replaces them and keeps "was".
4. Change the base in the card's base chip; the hint under each base says when to use it.
5. Scroll to Volume over time in the pile card and the Volumes view: one point per survey date; stale or partial dates are marked; "Not counted" lists what was left out and why.
6. Draw a section, add another date and a design as chips, pick Shade vs Design. Hover to read heights, difference and grade. Export a PNG.
7. Draw a distance, an area and an elevation point: each opens the same card. Change units in Site settings; card, tree, map label and chart follow.
8. Rename a measurement without saving, then use Add to report on it and on one more: the edit is saved first, and the report's measurements section prints exactly those two, plus Volume over time.
9. Right-click one of them (or its card's "⋯"): Remove from report takes it out. On the Reports screen, the note says how many measurements print; Clear report template asks first, then the report lists every measurement again.
10. Run Detect piles again: no pile is duplicated. Drag a converted pile's outline aside, save and reopen the project: no second copy of that pile appears.

## Open threads

- Waves 2 and 3: PPK from raw files, the geoid, the ± on volumes, repeat reports, AI pile detection on real piles.
- Founder review of ADR 0013 and the contract rows; a real-job validation run.
- A BVH for terrain meshes (slow terrain area without prepared surfaces); template section entries (W8).
- A pile detached from the kit (no longer linked) shows no kit tonnes; pick a site material for it.
- Follow-ups from the landing review: the Reports screen does not offer the Volume over time toggle when the report works the dates out itself; the house report still runs the earthworks, landfill and section engines when those sections are off; elevation history for typed coordinates in read-only projects; a kit-project report e2e asserting the carried totals; a kit's swell factor is not carried into the kit material (it was never shown before); a road line is saved at one height, the mean surface height under it (its card reads the terrain length from the surface).
- Lands via the stage-island train for 0.25.0, after the measure-dates branch. `pnpm check`, the Python suite and about 25 CI-like e2e specs (5 new) were green.

## Next session entry point

Start Wave 2 from the design doc, or validate Wave 1 on a real job first.
