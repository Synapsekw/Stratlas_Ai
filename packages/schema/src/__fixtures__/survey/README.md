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
- `lineUp` (optional): a lined-up date, `{ current?: { <surface id>: [east, north] }, ringShift?, ringCurrent? }`: the surfaces' shifts now, the shift added to the stored ring before sampling (the prepared one) and the ring date's shift now; only the "now" shifts join the fingerprint;
- `lineUpTurn` (optional): the turns beside those shifts, `{ current?: { <surface id>: turn }, ring?, ringCurrent? }`, each turn `{ rotationDeg, scale, pivotE, pivotN }` (a capture's `lineUpTurn`): the stored ring is shifted and turned by `ring` before sampling; only the "now" turns join the fingerprint (as `lineUpTurn`, beside `lineUp`). The ring's line-up now is `ringCurrent` (default `ringShift`) with `ringCurrentTurn` when either is given, else `ringShift` with `ring`. A surface prepared before its date was lined up has `ringShift` `[0, 0]` and no `ring` turn;
- `expected`: the Python core's `ComparisonResult` without `engine` and `computedAt`.

## `series.json`

Volume per survey date and the spread across bases (volumetric parity W3, W4): the Python core's
`compare_series` and `base_spread` (`python/tests/test_survey_series.py`) and the TypeScript
`compareSeries` and `baseSpread` (`packages/survey/src/engine/series.parity.test.ts`). Written by
`series_cases()` in the same generator. `{ series: [...], spread: [...], formula: [...] }`; every
series and spread case has `id`,
`note`, `ring`, `item` and `site` as in `cases.json`, and `dates`: the survey dates in order, each
`{ capture, surface }` (`surface` an id in `surfaces.json`, or `null` for a date with no prepared
surface). Viewed on a capture, `current` is that date's surface and `previous` the surface of the
date before it that has one, with the messages of `ProjectSurfaces` when there is none.

- **`series`**: the item (always with a `current` side) run once per date, with that date as
  `current`; `expected` is the list of results in date order, each without `engine` and
  `computedAt`, each carrying its date as `toCapture` or `fromCapture`.
- **`spread`**: `at` is the capture viewed on; `expected` is `{ pct, nets: [{ base, netM3 }] }` (the
  item's `from` replaced by each base of `SPREAD_BASES`; `pct = (max - min) / 2 / mean` of the
  ok or partial total volumes, in percent) or `null` (`from` not a base, fewer than two results, or
  a mean below 1e-6 m³). The spread is over the total volume, not net, because net can cross zero.
- **`formula`**: the spread formula on `totals` alone (`spreadPct` / `spread_pct`), `expected` the
  percentage or `null`. It holds the one-total case, which no surface can produce with these bases.

## `tiles/cone/`

The `cone` grid prepared as `aio.height-tiles/1` by the Python tile writer (`tiles.json` and
`0/0_0.bin`): the TypeScript tile reader must decode it to the same heights, bit for bit.
