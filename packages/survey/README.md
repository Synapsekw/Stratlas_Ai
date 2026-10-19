# @aio/survey

Surveying in the renderer (M11): the survey engine's TypeScript executor, measurement tools,
cross-sections, templates and calculators. Public API: `src/index.ts`. Depends on `@aio/schema`
and `@aio/geo` (units and the site transform).

## G0 contents

- The stable survey types re-exported from `@aio/schema` (comparison items and results, surfaces
  and bases, measurements, templates, sections, materials, site settings).
- `SURVEY_ENGINE_VERSION`: the TypeScript executor's version, part of every result fingerprint.
- `totals.ts`: `signedVolumeTotals(cut, fill)`, net (fill minus cut) and total (fill plus cut).

## G3 contents (measurement tools and templates)

- `tools/units.ts`: `effectiveUnits`, a measurement's units (the site units with its own overrides on top); formatting, conversion and parsing are `@aio/geo`'s (`formatQuantity`, `toSI`, `unitLabel`).
- `tools/geometry.ts`, `tools/measure.ts`: elevation, elevation difference to a surface
  (`HeightSampler`), horizontal, slope and terrain lengths, grades, the vertex difference table,
  horizontal and vertical components, the berm check, horizontal, slope and terrain areas.
- `tools/readout.ts`: readout rows per tool in the template's order; `ComparisonRunner`, the seam
  volumes come through (the tools never compute volumes).
- `tools/draw.ts`, `tools/edit.ts`: drawing aids as state machines (snapping, angle lock, typed
  distance and bearing, terrain clamping, Esc) and vertex editing.
- `tools/list.ts`: the measurement list's search, filters, sort and folders.
- `tools/telecom.ts`: the manual telecom tools (`azimuth`, `antenna-tilt`, `clearance`), picked on real ENZ points with a fixed vertex count.
- `templates/model.ts`: the template model and editor logic; `templates/industry.ts` with the construction, landfill and mining template sets (JSON), and `templates/designRoles.ts`.

## Other modules

- `engine/` (G2): the comparison engine on height tiles, design TINs and in-memory grids (ADR 0009); `compareItem`, `compareItems`, `fingerprint`.
- `section/` (G5): cross-sections (`profile.ts`, `stations.ts`, `shade.ts`).
- `calc/` (G4): calculators, materials, bulk, heat map and pickers.
- `designs/` (G6): design surfaces in the renderer: `aio.tin/1` reading (`tin.ts`), alignments (`alignment.ts`) and compliance to design (`compliance.ts`).
