# @aio/change

Change between two capture dates (PRD FUS-12, M8 stream C1): change sets and their register, issue,
detection and map vector change in TypeScript, and the Changes panel. Public API: `src/index.ts`
(renderer) and `src/core.ts` (`@aio/change/core`: no React, used by main and the agent tools).
Ownership and dependencies: `docs/architecture/SPEC.md` section 2 (depends on schema, ui,
workspace).

## Data

- Change sets: `<project>/change/<id>.json` (`aio.change/1`), schema in `@aio/schema` `change.ts`,
  layout in `docs/architecture/data-conventions.md` section 14. Ids are `<from>-<to>-<producer>`
  (`changeSetId`, the same rule as `change_set_id` in the pipeline writer). The pipeline producers
  write the same file through `python/src/aio_pipelines/change/changeset.py`.
- A recompute keeps reviews by item id (`mergeReviews`). Main writes atomically with a `.bak`
  (`change:write`), and refuses packages.

## In-app producers (`change:compute`)

- `issues.ts`: dates from `Issue.capture`, else the sightings' layer dates, else `createdAt`;
  matching by a confirmed `track`, else same class within `max(0.5 m, 2% of the site height)` of
  the mesh or point cloud sighting. `resolved` only when a posed photo of the later date looked at
  the place, else `not-seen`. Grown / shrunk by area (`ChangeThresholds.grown.areaPct`), else
  worsened / improved by severity.
- `detections.ts`: accepted detections per class and zone (`component`), dated by their photos
  layer. Method `zone` until C4's `pairsFor` lands.
- `vector.ts`: counterpart vector layers (same slot), features matched by `id`, `fid`, `name`, else
  geometry (boxes, centroid, Hausdorff on segments): added, removed, moved, reshaped, attributes.

## Producers of later streams

Imagery, surface, point cloud, model and frame change (streams C2 to C4) register a
`ChangeProducer` with `registerChangeProducer` (in their own `apps/desktop/src/renderer/change/
producers/*.ts`, imported once from the renderer). The Changes panel offers one "Run ..." action
per registered producer whose `available` check passes for the chosen date pair, and reloads the
sets when the run returns `ids`. Keep the `producers.ts` API stable.

## Mount points in the split (desktop)

- A new pane kind (C4 Frames): add the kind to `PaneKind`, `PANE_KINDS` and `paneOptions` in
  `apps/desktop/src/renderer/workspace/splitModel.ts` and one `EXTRA_PANES` entry in
  `SplitPanes.tsx`.
- A tool beside Compare dates while two dates show (C2 Swipe and Blend):
  `COMPARE_TOOLS.push(MyTools)` from `CompareControls.tsx`.
- "Show changes" pins: `useChangeOverlays` (renderer `change/`) draws them on every 3D view and
  map of the comparison; the inspection hook shows them as `__stratlas.compare().changes`.
