# @aio/rf

RF coverage maths for telecom towers: the regional band and resource-block tables, antenna
patterns, antenna geometry and tilt, the downlink link budget, path-loss models, sector grouping,
catalogue lookup, the live preview engine and the coverage run's GeoTIFF grids. It is the
TypeScript twin of the pipeline pack's `aio_pipelines/rf/` (the `rf.coverage` job) and is held to
the same golden vectors. Pure functions with no Node or DOM dependency, so the same code runs in
main, the renderer and a Web Worker. Public API: `src/index.ts`. Ownership and dependencies:
`docs/architecture/SPEC.md` section 2 (depends on schema).

## Layout

| Path                    | What                                                                                                                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/bands.ts`          | Regional band table and 3GPP resource-block tables (`BANDS`, `bandById`, `bandOfName`, `nRb`); data, not logic                                                                               |
| `src/ground.ts`         | Ground at the tower base when the antenna file has none: the radius and percentile of the DSM the job uses (`DSM_GROUND_RADIUS_M`, `DSM_GROUND_PERCENTILE`)                                  |
| `src/geometry.ts`       | Grid, true and antenna frames: bearings, true azimuth from the grid convergence, mechanical downtilt (`trueAzimuthDeg`, `gridToTrue`, `toAntennaFrame`, `directionToAntennaFrame`)           |
| `src/pattern.ts`        | Antenna patterns in dB below peak: the TR 38.901 parametric pattern with electrical tilt, and two-cut patterns (`parametricFromPort`, `makeTwoCutPattern`, `patternGainDb`, `patternLossDb`) |
| `src/msi.ts`            | MSI / Planet pattern files: `parseMsi`, `msiToTwoCut` (file angles turned to the engine's clockwise convention, dBd to dBi) and `pickNearestPattern` by frequency and tilt                   |
| `src/budget.ts`         | Downlink link budget per resource element and port: `rsrpDbm`, `evaluatePoint`, `rsrpClass`, margins (`fadeMarginDb`, `DEFAULT_MARGINS`, `PENETRATION_MARGIN_DB`), power conversions         |
| `src/propagation.ts`    | Path loss: TR 38.901 UMa, UMi street canyon and RMa with LOS probability, Okumura-Hata, COST-231 Hata, free space; validity warnings and refusals (`makePathLoss`, `pathLossDb`)             |
| `src/sectors.ts`        | Sector proposals from unit azimuths (30 degree gap), eligibility, and orphaned RF settings (`proposeSectors`, `groupSectors`, `unitEligibility`, `findOrphans`, `reassignOrphan`)            |
| `src/catalogue.ts`      | Catalogue lookup, search and merge (`getEntry`, `searchCatalogue`, `catalogueVendors`, `mergeCatalogues`); the main process reads and validates the files and hands entries here             |
| `src/preview.ts`        | Live preview: cached Float32 path-loss grids plus pattern and budget terms give composite RSRP, best server and overlap (`pathLossGrid`, `computePreview`, `servePreview`, grid helpers)     |
| `src/preview.worker.ts` | Worker entry point; the work is `servePreview`                                                                                                                                               |
| `src/gridTiff.ts`       | `readGridTiff`: reads the one uncompressed GeoTIFF layout a coverage run writes, from bytes                                                                                                  |
| `catalogue/`            | Built-in catalogue seeds: `generic.json` and `vendor.json`                                                                                                                                   |
| `fixtures/golden/`      | Golden vectors (`propagation.json`, `pattern-budget.json`) and the independent Python scripts that generate them                                                                             |

## Data

Layout in `docs/architecture/data-conventions.md` section 39; shapes in `@aio/schema` `rf.ts`.

- `aio.rf-sectors/1`: `rf/sectors.json`, the sectors, per-antenna RF settings and study settings
  that the link budget and preview read.
- `aio.rf-catalogue/1`: the catalogue entries (`antenna`, `radio`, `aau`). The seeds in
  `catalogue/` ship with the app (`resources/rf-catalogue` in an installed build, read only); the
  person's imported entries and the project's `rf/catalogue.json` are the other two origins.
- `aio.rf-run/1`: `rf/runs/<runId>/run.json`, a coverage run's inputs snapshot and outputs; its
  `rsrp.tif`, `best-server.tif`, `overlap.tif` and path-loss cache are the grids `readGridTiff` and
  the preview read.

## Where it is used

- Main: `apps/desktop/src/main/rf.ts` (the `rf:*` IPC: `rf:readSectors`, `rf:writeSectors`,
  `rf:listCatalogue`, `rf:importCatalogue`, `rf:listRuns`, `rf:readRun`; it parses MSI files with
  `parseMsi`) and `apps/desktop/src/main/rf/export.ts` (`rf:export`, reading run grids with
  `readGridTiff`).
- Renderer: `apps/desktop/src/renderer/rf/` (the RF workbench, catalogue picker, coverage layer and
  legend, Auto-plan, and the preview worker that runs `servePreview`).
- The `rf.coverage` job in the pipeline pack (`python/src/aio_pipelines/rf/`) computes the same
  maths for a full run; the preview reuses its path-loss grids, and the golden vectors keep the two
  in step.

## Caveat

Every entry in `catalogue/vendor.json` (and in `generic.json`) carries `verified: false`: the
values have not been checked against the vendors' datasheets, and AAU broadcast-beam gains are
estimates. A run records the catalogue ids it used with their `verified` flag.
