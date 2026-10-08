# @aio/survey

Surveying in the renderer (M11): the survey engine's TypeScript executor, measurement tools,
cross-sections, templates and calculators. Public API: `src/index.ts`. Depends on `@aio/schema`
(and `@aio/geo` once G1 lands units and the site transform there).

## G0 contents

- The stable survey types re-exported from `@aio/schema` (comparison items and results, surfaces
  and bases, measurements, templates, sections, materials, site settings).
- `SURVEY_ENGINE_VERSION`: the TypeScript executor's version, part of every result fingerprint.
- `totals.ts`: `signedVolumeTotals(cut, fill)`, net (fill minus cut) and total (fill plus cut).

## G3 contents (measurement tools and templates)

- `tools/format.ts`: a local units formatter with exact factors (international foot 0.3048 m, US
  survey foot 1200/3937 m), same signature as G1's `formatQuantity`, to be swapped for it.
- `tools/geometry.ts`, `tools/measure.ts`: elevation, elevation difference to a surface
  (`HeightSampler`), horizontal, slope and terrain lengths, grades, the vertex difference table,
  horizontal and vertical components, the berm check, horizontal, slope and terrain areas.
- `tools/readout.ts`: readout rows per tool in the template's order; `ComparisonRunner`, the seam
  volumes come through (the tools never compute volumes).
- `tools/draw.ts`, `tools/edit.ts`: drawing aids as state machines (snapping, angle lock, typed
  distance and bearing, terrain clamping, Esc) and vertex editing.
- `tools/list.ts`: the measurement list's search, filters, sort and folders.
- `templates/model.ts`: the template model and editor logic.

## Planned

- `engine/` (G2): the comparison engine on height tiles in a worker (ADR 0009).
- `tools/`, `templates/` (G3): typed measurement tools, drawing aids, the template library.
- `section/` (G5): cross-sections.
- `calc/` (G4): calculators and materials.
