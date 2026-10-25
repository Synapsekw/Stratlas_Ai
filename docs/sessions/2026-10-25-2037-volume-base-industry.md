---
type: session
date: 2026-10-25-2037
branch: feat/volume-base-industry
status: complete
related:
  - architecture/adr/0013-one-volume-engine.md
  - sessions/2026-10-25-1725-volumetric-customer-report.md
---

# Volume bases follow the proven tools; the report names each pile's base

## What changed

- Founder decision recorded in ADR 0013: stockpile bases follow the proven tools (Pix4D, Virtual Surveyor, DroneDeploy, Propeller). The user draws the boundary at the toe and picks a base per pile; the app adds no automatic floor tests or extra base heuristics. The neighbour rule (perimeter samples near another pile's edge left out) is the one deliberate difference.
- The volumetric report names each pile's base by its picker name: a Base column on page A, a Base stat on page B cards and the viewer's pile card; the method note names the shared base, or says "Base per pile, see table" (`390bda249`).
- The Custom base (already per-vertex heights, triangulated, both engines) gains "Use ground here" and "Interpolate between", in the editor and on the vertex rows' right-click menu, the way Virtual Surveyor and Propeller handle a toe on a wall or a shared edge (`a35c4817f`). No engine, schema or pack change.
- Checks: `pnpm check` green; `volumetric-report` and `volumes-general` green the CI way.

## Why

A research pass (vendor docs, accuracy studies, standards, and a synthetic ground-truth benchmark) found the app's base picker already matches the tools' set. The founder chose to follow them rather than add heuristics: boundary placement is the user's job.

## How to test

1. Open a pile's volume, Base, Custom.
2. Click vertex 2, Shift+click vertex 4, Interpolate between: vertices 2 to 4 move onto the line between 1 and 5 and the volume updates.
3. Right-click a vertex row, Use ground here: that row reads an offset of 0.
4. Reports, Customer reports, Open volumetric report: the table, the cards and the HTML pile card show each pile's base, and the method line names it.

## Open threads

- A field check (fly, clear some piles, fly again) before quoting an accuracy figure to customers.
- The CSV still names a kit-carried pile's base as "From an earlier version (kit ...)".

## Next session entry point

Hand `feat/volume-base-industry` (this PR) to the merge coordinator.
