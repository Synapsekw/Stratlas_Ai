# @aio/change

Change between two capture dates (PRD FUS-12, M8 stream C1): change sets and their register, issue,
detection and map vector change in TypeScript, and the Changes panel. Public API: `src/index.ts`.
Ownership and dependencies: `docs/architecture/SPEC.md` section 2 (depends on schema, ui,
workspace).

## Data

- Change sets: `<project>/change/<id>.json` (`aio.change/1`), schema in `@aio/schema` `change.ts`,
  layout in `docs/architecture/data-conventions.md` section 14. The pipeline producers write the
  same file through `python/src/aio_pipelines/change/changeset.py`.

## Producers

Imagery, surface, point cloud, model and frame change (streams C2 to C4) register a
`ChangeProducer` with `registerChangeProducer`; the Changes panel offers one "Run ..." action per
registered producer whose `available` check passes for the chosen date pair.
