# ADR 0010: Geodesy (PROJ as the one truth)

- Status: **Accepted, 7 Oct 2026 (founder: go with the recommendations)**. M11 decisions 5 (geoid grids), 8 (calibration formats) and 12 (default units), and decision 7 of "Decisions already taken" (coordinates). Written at G0, 8 Oct 2026.
- Deciders: founder; integration lead (M11)
- Plan: `docs/plans/2026-10-07-m11-surveying.md`, "Coordinates, geoids and site calibration"
- Contracts: `@aio/schema` `geodesy.ts` (`SiteVerticalDatum`, `SiteCalibration`, `HorizontalAdjustment`, `VerticalAdjustment`, `CalibrationPair`, `GeoidPackMeta`, `SiteTransform`, `F64Grid`, `CrsCatalogueEntry`), `survey.ts` (`SurveySettings`, units), `jobs.ts` (`geo.calibration`, `survey.prepare`), `ipc.ts` (`geodesy:*`, `geoidPacks:*`); data-conventions section 25; code: `python/src/aio_pipelines/geodesy/` (`site.py`, `calibration.py`), `packages/geo/src/catalogue/`, `packages/geo/src/siteTransform.ts`, `packages/geo/src/units.ts`, `tools/geo/build-crs-catalogue.mjs` (G1)

## Context

Surveyors check our numbers against their controller and their CAD package to the millimetre. Today `packages/geo/src/index.ts` `crsDefinition` knows WGS84 UTM, 4326 and 3857 only; `Measurement.unit` is `m`, `m2` or `deg`; a project's vertical datum is one offset (`VerticalDatum.absAltOffsetM`, KNOWN-LIMITS "No geoid model"). M11 needs any EPSG national or state grid with its vertical datum, regional geoid models beyond M10's EGM96 and EGM2008, and local site calibrations imported from Trimble and 12d, applied the same way to every survey, design, measurement and export.

Two code paths for coordinates (PROJ in the pack and proj4js in the renderer) would disagree on grid-based datum shifts, geoids and calibrations, and a disagreement of a few centimetres is exactly what a surveyor notices. proj4js has no geoid support and only partial grid-shift support.

## Options considered

1. **Re-implement datums, geoids and calibrations in the renderer** (proj4js plus our own grid interpolation and Helmert code). Fast readouts, but a second implementation of every transform to keep in step with PROJ, and grids loaded into the renderer.
2. **Ask the pack for every readout.** One code path, but a process round trip per cursor move is far too slow for live readouts and drawing.
3. **PROJ is the one truth; the renderer interpolates tables PROJ wrote (chosen).**

## Decision

1. **PROJ in the pipeline pack (pyproj) is the only source of truth.** Every number a person reads or exports comes from PROJ with the site's horizontal CRS, vertical datum, geoid grid and calibration applied in one pipeline, `python/src/aio_pipelines/geodesy/site.py`. Nothing re-implements a datum.
2. **Renderer tables.**
   - Horizontal readouts use proj4js only when the CRS is a pure projection proj4js represents exactly, checked against PROJ at 25 points over the site when written (`SiteTransform.proj4`, `CrsCatalogueEntry.proj4`). Otherwise, and for every calibrated site, `survey.prepare` writes `survey/geodesy/site-transform.json` (`aio.site-transform/1`) with a float64 grid mapping the project frame to the site grid at 1 m spacing (`grid`, two bands, E and N), interpolated bilinearly.
   - Vertical readouts use a geoid subgrid for the site extent (`geoidGrid`, one band, the undulation), cut from the geoid pack by PROJ.
   - **Parity:** renderer readouts equal pyproj within 1 mm horizontally and vertically at 1,000 random points of each synthetic site, in CI for every fixture CRS and calibration.
   - **EPSG catalogue:** a build step reads PROJ's `proj.db` and writes `packages/geo/src/catalogue/epsg.json.gz` (projected, geographic, vertical and compound CRSs), searched by `geodesy:searchCrs`; under 1.5 MB compressed, loaded lazily.
3. **Calibration model** (`survey/calibration.json`, `aio.site-calibration/1`), in the controller's order: geographic to a base projection (`projection`, often a transverse Mercator at the site with a scale factor), then a horizontal similarity (`horizontal`: Helmert 2D about an origin, `local = origin' + scale * R(rotation) * (grid - origin)`, rotation counter-clockwise positive), then a vertical adjustment (`vertical`: a constant shift plus an inclined plane, `dz = shift + slopeN*(N-n0) + slopeE*(E-e0)`), on a geoid or on ellipsoidal heights (`geoid`). Point pairs and their horizontal and vertical residuals are stored beside the controller's own residuals; the source file is kept by hash. Imports (`geo.calibration`): Trimble JobXML and `.dc`, 12d transforms and **Compute from point pairs** (least squares, the same model); Trimble `.cal` only if found documented; Topcon `.gc3` out (decision 8).
4. **A person applies it.** A calibration is a draft until a person confirms it on the residual table (`geodesy:applyCalibration`, journaled as `survey.calibration`); it then applies everywhere (readouts, measurement coordinates, design import, exports, reports) and marks every dependent result stale through its fingerprint.
5. **`PROJ_NETWORK` is off.** The pack's environment sets `PROJ_NETWORK=OFF`, asserted in a test. A missing grid is an exact refusal that names the pack ("needs the AUSGeoid2020 geoid pack"), never a silent fallback to ellipsoidal heights and never a download from PROJ's CDN.
6. **Geoid packs.** EGM96 and EGM2008 ship in the pipeline pack, as in M10. Regional models are separate geoid packs in `<data>/packs/geoid/<id>.tif` with `<id>.json` (`aio.geoid-pack/1`: name, region bbox, horizontal and vertical EPSG codes, PROJ-data file name, licence, attribution, provenance, sha256), built from PROJ-data (AUSGeoid2020, GEOID18, OSGM15 and OSTN15, NZGeoid2016, CGG2013) with their licences and attributions, listed in **Settings, Map packs**, imported from a USB folder or a configured download list; downloading is an explicit online action refused on an offline-only workstation. **Import geoid grid** (GeoTIFF or GTX with the licence and attribution the person states, `imported: true`) covers models not in PROJ-data, such as the GCC national geoids (decision 5). The pack's PROJ search path includes the folder.
7. **Units at the edges.** Stored values stay SI. The international foot (0.3048 m, `ft`) and the US survey foot (1200/3937 m, `us-ft`) are distinct units with distinct labels; a new site's units come from its CRS (decision 12).

## Consequences

- The renderer never loads a geoid model or a grid-shift file, only small float64 tables for the site extent; they are rewritten by `survey.prepare` when the CRS, calibration or geoid changes (`SiteTransform.fingerprint`).
- One parity suite guards the tables against pyproj; a failing point is a bug in the table writer or the interpolator, not a tolerance to widen.
- Datum realisation differences (NAD83(2011) and NAD83(CSRS), ITRF epochs) are visible rather than hidden: every site shows PROJ's chosen operation (`SiteTransform.operation`) in **Site settings, Details**.
- Controllers differ subtly in their calibration models; G1 documents the model above and tests each importer on vendor-shaped synthetic files (no real controller files in the repository).
- Regional geoid packs add download and attribution work: each pack's licence and attribution show in readout details, reports, exports and `THIRD-PARTY-NOTICES.md`. Since 8 Oct 2026 the licence gates only report (ADR 0008, "Amendment").
