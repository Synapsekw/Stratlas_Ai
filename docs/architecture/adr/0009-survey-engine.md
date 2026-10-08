# ADR 0009: Survey engine (one specification, two executors)

- Status: **Accepted, 7 Oct 2026 (founder: go with the recommendations)**. M11 decision 3 of "Decisions already taken" (one general comparison engine, built by unifying the stockpile kit and `change.surface`, not as a third engine). Written at G0, 8 Oct 2026.
- Deciders: founder; integration lead (M11)
- Plan: `docs/plans/2026-10-07-m11-surveying.md`, "The surface engine: options and recommendation"
- Contracts: `@aio/schema` `survey.ts` (`SurfaceRef`, `BaseSpec`, `ComparisonItem`, `ComparisonResult`, `HeightTiles`), `designs.ts` (`TinHeader`), `jobs.ts` (`survey.prepare`, `survey.compare`); data-conventions section 26; code: `python/src/aio_pipelines/survey/` (`prepare.py`, `compare.py`, `grid.py`, `bases.py`, `tin.py`), `packages/survey/src/engine/` (G2); shared fixtures `packages/schema/src/__fixtures__/survey/`

## Context

The founder asked for surveying "as good as Propeller Aero": every polygon holds one or more comparisons from any surface to any surface (a survey, a design, a flat reference level, a triangulated base or a base edited vertex by vertex), with cut, fill, net and total, a deadband and heat maps, for construction earthworks, mines and quarries, and landfill alike.

Two engines exist and neither is general. The stockpile kit (`packages/volumetric`, `volumetric.build`) computes four bases (`tin`, `plane`, `avg`, `low`) interactively in a web worker, but only on the kit's grids inside a volumetric project. M8's `change.surface` (`python/src/aio_pipelines/change/surface.py`) computes cut and fill between any two DSMs or clouds with a deadband, but has no design surface or base, and its `areas` input is never sent by the UI. Drawing and vertex editing need answers while the person drags (all comparisons of a 1 ha polygon at 5 cm, 4 M cells, under 300 ms), while reports, bulk recompute after a calibration change and whole-site comparisons of 100 ha at 5 cm (400 M cells) need bounded memory and progress in the pipeline pack.

## Options considered

1. **Extend the TypeScript kit engine to everything.** Interactive, but the renderer would need COG, COPC and TIN readers and would duplicate `change.surface`'s gridding and registration; whole-site runs in the renderer do not fit its memory.
2. **Extend `change.surface` to everything.** One code path, but every polygon edit becomes a pipeline round trip of seconds, which kills drawing and vertex editing.
3. **One formula specification, two executors on one prepared surface format (chosen).** A written specification (data-conventions section 26), a Python reference core and a TypeScript interactive executor that both implement it, both reading surfaces prepared once by `survey.prepare` into height tiles.

## Decision

1. **One specification.** Data-conventions section 26 is the single definition of a comparison: the sign convention (`dz = To - From`; fill where `dz > 0`, cut where `dz < 0`, net = fill - cut, total = fill + cut), coverage weights by exact polygon and cell clipping (never a centre test), the deadband (only when `useDeadband` is on, and the result says so), uncovered area (partial above 2% of the polygon, refused above 20%), TIN to TIN exactly by intersecting the triangulations, every base's definition, the outputs and the fingerprint. A change to the formula is a change to that section first.
2. **Two executors.**
   - **Python reference core** (`python/src/aio_pipelines/survey/compare.py` with `grid.py`, `bases.py`, `tin.py`), the `survey.compare` pipeline: stored items for many measurements at once (reports, bulk recompute) and whole-site comparisons, with the difference grid, heat map pyramid and contours of the difference. Results carry `engine: 'py'`.
   - **TypeScript executor** (`packages/survey/src/engine/`) in a renderer web worker over the same tiles fetched through `aio://`, with a tile cache, computing only the tiles a polygon touches and cancelling on edit. Results carry `engine: 'ts'`.
3. **One prepared surface format.** `survey.prepare` turns any surface (DSM COG, `aio.grid/1`, a cloud through PDAL, a design TIN, a cleaned surface) into height tiles in `survey/surfaces/<id>/` (`aio.height-tiles/1`: 256 by 256 float32 heights relative to a float64 base per tile, a nodata mask, a display pyramid), re-prepared only when the source fingerprint changes. Design surfaces stay exact TINs (`aio.tin/1`) for the TIN to TIN path.
4. **One set of fixtures.** Small grids, polygons and expected results in `packages/schema/src/__fixtures__/survey/` run in both executors (pytest and the Vitest parity runner `packages/survey/src/engine/parity.test.ts`); they agree to 1e-6 relative. A difference is a bug in one executor, never a tolerance to widen.
5. **The existing engines become clients.** `change.surface` keeps its contract and its tests and calls the core for its volumes and `areas`. The stockpile kit's four bases become four of the general bases (`tin` is `smart`, `plane` is `fit-plane`, `avg` is `perimeter-mean`, `low` is `reference` `perimeter-min`); the volumetric workspace calls the TypeScript executor with the kit's grids wrapped as a surface; `volumes.json` and the old base names in a volumetric project are unchanged.
6. **Results are never stale and current at once.** Every `ComparisonResult` holds a fingerprint of every input (surface hashes, design offset, base parameters, deadband, cell, calibration and geoid ids); when it no longer matches, the result shows **Stale, recompute**.

## Consequences

- Two implementations of one formula cost more than one, and the parity suite is the price: every quality target (cone, frustum, paraboloid, prism and wedge volumes within 0.5% at 1/50 cells and 0.1% at 1/200; TIN to TIN within 1e-6; the deadband giving exactly zero on sub-deadband noise) is asserted against analytic truth in both executors, and the executors against each other.
- Surfaces are prepared once per source fingerprint, which costs disk (height tiles and their pyramid in `survey/surfaces/`) and a pipeline run before the first interactive volume on a new survey; in return the renderer never parses COG, COPC or LandXML.
- float32 tiles lose precision far from their base; heights relative to a float64 base per tile keep it at 0.06 mm over a 1,000 m range, asserted in tests.
- The stockpile kit regression (the volumetric demo's and the Masafi fixture's volumes on every base, exact on the same grid, 0.1% otherwise) gates G2's merge; nothing builds on the engine before it passes.
- No new layer kind, raster `role` or `ProjectType`: prepared surfaces, measurements and results live in `<project>/survey/`, which 0.10 and older never read.
