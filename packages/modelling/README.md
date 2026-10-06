# @aio/modelling

Procedural models from drawings and point clouds (PRD BLD-11, M8 stream C5): validation beyond
zod, the mesher (primitives to triangles with one tagged node per part), the GLB writer and the
Model builder screen. Public API: `src/index.ts`. Ownership and dependencies:
`docs/architecture/SPEC.md` section 2 (depends on schema, ui).

## Data

- `<project>/models/<id>.procmodel.json` (`aio.procmodel/1`), schema in `@aio/schema`
  `procmodel.ts`, layout in `docs/architecture/data-conventions.md` section 15.
- Built models: `models/<id>.glb` (accepted parts) and `models/draft-<id>.glb` (preview), added as
  mesh layers with `derived: { kind: 'model' }` by main (`model:build`).
- Drawings come in through the `drawing.import` pipeline (DXF only) and point cloud fits through
  `model.fit_cloud`, both in the pipeline pack.
