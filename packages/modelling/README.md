# @aio/modelling

Procedural models from drawings and point clouds (PRD BLD-11, M8 stream C5). Public API:
`src/index.ts`. Ownership and dependencies: `docs/architecture/SPEC.md` section 2 (depends on
schema, ui).

- `procmodel.ts`: building and editing models (`newProcModel`, `addParts`, `setPartStatus`,
  `updatePart`, `applyDimension`, `findPart`) and `checkProcModel`, the problems a person fixes
  before building (crossed or empty footprints, pipes without length, parts far off site, a tag on
  two parts).
- `mesher.ts`: `meshPart` (closed, outward-wound triangles relative to the part) and
  `meshProcModel` (GLB with one node per part, named by tag, else name, else id, as three.js keeps
  node names: `glbNodeName`). Accepted parts by default; `parts: 'all'` is the draft preview
  (rejected parts left out, drafts in amber).
- `glb.ts`: a dependency-free GLB writer and reader.
- `drawing.ts`: imported drawings in a manifest (`drawingsOf`), their candidate parts and
  placement (`drawingToLocal`, `localToDrawing`).
- `ModelBuilder.tsx`: the Model builder panel (presentational; the desktop app wires it in
  `apps/desktop/src/renderer/modeller/`).

## Data

- `<project>/models/<id>.procmodel.json` (`aio.procmodel/1`), schema in `@aio/schema`
  `procmodel.ts`, layout in `docs/architecture/data-conventions.md` section 15.
- Built models: `models/<id>.glb` (accepted parts) and `models/draft-<id>.glb` (preview), added as
  mesh layers `model-<id>` and `model-draft-<id>` with `derived: { kind: 'model', source: [id] }`
  and `tags` for tagged parts, by main (`model:build`).
- Drawings come in through the `drawing.import` pipeline (DXF only): `drawings/<stem>.dxf`,
  `drawings/<stem>/plan.png` (raster layer `plan-<stem>`), `drawings/<stem>/<layer>.geojson`,
  `drawings/<stem>/parts.procmodel.json` (candidate parts) and `drawings/<stem>/placement.json`
  (`aio.drawingplacement/1`: drawing units to the local frame). Point cloud fits come through
  `model.fit_cloud`, which writes draft parts straight into a model.
