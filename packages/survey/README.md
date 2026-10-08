# @aio/survey

Surveying in the renderer (M11): the survey engine's TypeScript executor, measurement tools,
cross-sections, templates and calculators. Public API: `src/index.ts`. Depends on `@aio/schema`
(and `@aio/geo` once G1 lands units and the site transform there).

## G0 contents

- The stable survey types re-exported from `@aio/schema` (comparison items and results, surfaces
  and bases, measurements, templates, sections, materials, site settings).
- `SURVEY_ENGINE_VERSION`: the TypeScript executor's version, part of every result fingerprint.
- `totals.ts`: `signedVolumeTotals(cut, fill)`, net (fill minus cut) and total (fill plus cut).

## Planned

- `engine/` (G2): the comparison engine on height tiles in a worker (ADR 0009).
- `tools/`, `templates/` (G3): typed measurement tools, drawing aids, the template library.
- `section/` (G5): cross-sections.
- `calc/` (G4): calculators and materials.
