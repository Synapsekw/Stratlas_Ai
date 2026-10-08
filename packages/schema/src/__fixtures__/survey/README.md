# Survey engine fixtures (M11 G2)

Shared fixtures of the survey engine (ADR 0009, data-conventions section 26). Both executors run
every case: the Python reference core (`python/tests/test_survey_fixtures.py`) and the TypeScript
executor (`packages/survey/src/engine/parity.test.ts`). They must agree with `expected` to 1e-6
relative and exactly on the status, reason, labels, captures and fingerprint; a difference is a
bug in one executor, never a tolerance to widen.

Everything here is synthetic: analytic shapes at a fictional desert site (UTM 31N, E 302000, N
2574000). Regenerate with `uv run python tests/survey_fixtures.py` from `python/`; the generator
writes `expected` from the Python core (and formats the JSON with prettier), so review the diff of
`cases.json` like code.

## `surfaces.json`

An object of surfaces by id. Survey refs (`{ kind: 'survey', surface }`) name an id directly,
design refs (`{ kind: 'design', design, layer }`) name `<design>/<layer>`, and `current` and
`previous` go through the case's `captures`.

- **Grid** (`kind: 'grid'`): `name`, `fingerprint`, `originE`, `originN` (lower-left corner of
  cell (0, 0)), `cellM`, `nx`, `ny`, `base`, `scale` and `z`: `nx * ny` integers, row-major, row 0
  the southernmost, `null` where there is no data. The height of a cell is `base + z * scale` in
  float64 (`scale` is 2^-10 m, so every height is exact in a float32 tile too). Heights are at the
  cell centres.
- **TIN** (`kind: 'tin'`): `name`, `fingerprint`, `vertices` (`[E, N, Z]`, metres, project CRS),
  `triangles` (vertex index triples) and `offsetM` (the design layer's vertical offset, added when
  used).

## `cases.json`

`{ cases: [...] }`, each case:

- `id`, `note`;
- `ring`: the polygon, `[E, N]` points (the last need not repeat the first);
- `item`: a `ComparisonItem` (`@aio/schema` `survey.ts`);
- `site`: what the fingerprint records of the site (`verticalDatum`, `calibration?`);
- `captures` (optional): `{ current, previous }`, each `{ surface, capture }`;
- `expected`: the Python core's `ComparisonResult` without `engine` and `computedAt`.

## `tiles/cone/`

The `cone` grid prepared as `aio.height-tiles/1` by the Python tile writer (`tiles.json` and
`0/0_0.bin`): the TypeScript tile reader must decode it to the same heights, bit for bit.
