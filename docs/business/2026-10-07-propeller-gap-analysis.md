# Propeller Aero vs Stratlas: surveying gap analysis

Date: 7 Oct 2026. Input for the M11 plan ("Surveying to Propeller Aero parity", `docs/plans/ROADMAP.md`). Compares each capability in the [Propeller feature inventory](2026-10-07-propeller-feature-inventory.md) with the code on `main` (0.9.0 plus the staged M10 G0 contracts) and the [M10 plan](../plans/2026-10-07-m10-globe-and-photogrammetry.md).

Status key:

- **Have**: works today (evidence cited).
- **Partial**: some of it exists. The notes say what is missing.
- **M10**: planned in M10 (plan section cited). The M10 Python entry points (`python/src/aio_pipelines/photo/`, `opf/`, `tiles/`, `packs/`) are G0 stubs only.
- **Missing**: nothing in code or plans.

The M11 column suggests scope: **core** (needed for parity with what earthworks and mining surveyors use every week), **stretch**, **out** (clashes with Stratlas's constraints or is low value; see "Constraint clashes"), or **n/a** (already done, or covered by M10).

## Summary

| Status  | Rows |
| ------- | ---- |
| Have    | 25   |
| Partial | 45   |
| M10     | 11   |
| Missing | 61   |
| Total   | 142  |

Suggested M11 scope over the same 142 rows:

- 52 core
- 36 stretch
- 16 out
- 38 n/a (already done, or covered by M10)

Of the 61 Missing rows, 14 are out of scope by constraint or value.

The biggest structural finding: Stratlas has two strong volume engines, but neither is general purpose.

- **The stockpile kit** (`volumetric.build`, `packages/volumetric`) detects piles on its own, with four bases (TIN, plane, average, lowest), a boundary editor, density/tonnage and a register CSV. It works only inside a "volumetric" project.
- **M8 surface change** (`change.surface`) computes cut and fill between any two DSMs or point clouds, with a deadband, automatic regions and site totals. It cannot compare against a design surface. Its `areas` input (per-polygon volumes) is in the contract, but the UI never sends it.

Propeller's core is a single "From surface / To surface" engine behind every polygon. The highest-leverage M11 work is to build that engine once on what already exists, then put typed measurement tools on top.

**Top 10 gaps by user value (earthworks and mining surveyors):**

1. **General surface comparison on any drawn polygon.** From/To can be any survey, any design, a reference level, a triangulated (TIN) base or a custom base. Several comparisons per polygon. Works in every project type, not only stockpile projects.
2. **Design surfaces and compliance.** Import LandXML surfaces, DXF 3DFACE/mesh and TTM. Then cut/fill to design, remaining to design, tolerance heat maps and a vertical offset per design layer.
3. **Units and coordinate systems.**
   - Today the app is metric only, and its CRS registry is WGS84 UTM plus 4326/3857.
   - Missing: US survey ft and imperial, a full EPSG registry offline, regional geoids and local site calibration.
4. **Cross-sections against any number of surveys and designs.** Pins, grade readouts, vertical exaggeration and DXF export. Today: two surveys, stockpile projects only.
5. **Typed measurement tools.** Point elevation (NEZ), polyline with terrain/slope/horizontal distance, grade/slope, terrain and slope area, elevation history. All saved as measurements with templates, custom fields and folders.
6. **Terrain analysis overlays.** Contours (survey and difference), a slope/gradient map and an elevation ramp with editable stops.
7. **Survey and measurement exports.** GeoTIFF DSM/DTM/ortho in the site CRS, LAS/LAZ, DXF/LandXML surfaces, contour DXF/SHP, outlines as DXF/KML, and point CSV in and out.
8. **Earthworks reporting.**
   - A measurement/stockpile PDF with totals and a measurement CSV.
   - A site materials list (density) with shrink/swell and weight calculators.
9. **Survey QA beyond processing.**
   - Check any delivered DSM against checkpoints.
   - QA levels (pass/fail thresholds).
   - "Compare to previous survey" as a named check, built on the M8 registration check and the M10 accuracy report.
10. **Terrain cleanup and crop.** Remove machines and stockpiles from a DEM by polygon, and DTM filter presets. Without this, volumes against a dirty base are wrong.

Stratlas is already ahead of Propeller on:

- issue and inspection workflow, with severity models
- video and 360 sightings
- change detection for every layer type (imagery, cloud, mesh, frames, issues)
- a local AI agent
- a signed audit trail and approvals
- offline customer packages

None of these needs M11 work.

## Reusable engines and libraries already in the repo

| Library                             | Licence                     | Where                                                                               | M11 use                                                                                                                               |
| ----------------------------------- | --------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| proj4                               | MIT                         | `packages/geo` (`crsDefinition` generates UTM only)                                 | Full EPSG definitions bundled offline (for example the epsg-index data, licence to verify) for display and readouts                   |
| GDAL and PROJ (in rasterio), pyproj | MIT-style, MIT              | `python/pyproject.toml` (rasterio); pyproj and the EGM96/EGM2008 grids added in M10 | Reprojection of exports, geoid grids (regional grids from PROJ-data, licences per grid), GeoTIFF export                               |
| PDAL CLI                            | BSD-3                       | `python/src/aio_pipelines/pointcloud.py` (PATH or pack); bundled in M10 G1          | LAS/LAZ export, crop, `filters.smrf`/`filters.csf` presets for DTM cleanup                                                            |
| scipy, scikit-image, shapely/GEOS   | BSD, BSD, BSD/LGPL (shared) | pipeline pack                                                                       | TIN bases (Delaunay), contours (`skimage.measure.find_contours`), polygon clipping                                                    |
| trimesh                             | MIT                         | pipeline pack                                                                       | Mesh plane sections, surface area, design TIN handling                                                                                |
| pyshp                               | MIT                         | pipeline pack                                                                       | Contour and outline SHP export                                                                                                        |
| three.js, MapLibre (raster-dem)     | MIT, BSD-3                  | `packages/engine`, `packages/maps`                                                  | Measurement drawing, heat maps, hillshade on the map                                                                                  |
| copc, laz-perf (npm)                | permissive                  | `packages/pointcloud`                                                               | Measuring on clouds, classification toggles (have)                                                                                    |
| CesiumJS (`@cesium/engine`)         | Apache-2.0                  | M10 G6 (`packages/globe`)                                                           | Globe and site map only: by plan, measuring stays in the site view (M10 "Review focus")                                               |
| New candidates                      | to verify                   | none                                                                                | ezdxf (MIT) for DXF writing; own LandXML reader and writer; RTKLIB (BSD-2) if PPK from RINEX is wanted; WhiteboxTools (MIT) for hydro |

## 1. Viewer and layers

| Propeller feature                                                     | Stratlas status | Evidence / notes                                                                                                                                                                                                                                                               | M11     |
| --------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| 3D site view: ortho draped on terrain, mesh, point cloud              | Have            | `packages/engine`, `packages/pointcloud` (COPC, Potree 2), `packages/volumetric/src/scene`; ortho kit pyramids in `packages/maps/src/pyramid.ts`                                                                                                                               | n/a     |
| Globe with a satellite base map (Road / Satellite / Hybrid)           | M10             | Offline street map (PMTiles) today in `packages/maps`. Globe, satellite imagery packs and terrain packs: M10 G6 and G7 ("Imagery and terrain: sources and licences")                                                                                                           | n/a     |
| Site list on a map                                                    | M10             | GLB-1 and GLB-3 (Globe shows every library project), PRD section 9.1                                                                                                                                                                                                           | n/a     |
| Elevation map with editable colour stops, smooth/step, range slider   | Partial         | Fixed elevation relief for stockpile projects (`packages/volumetric/src/model/dsm.ts` `reliefRaster`; `VolumeTools.tsx` "Elevation"); elevation colouring of clouds (`packages/pointcloud/src/ElevationLegend.tsx`). No editable stops, no DSM ramp outside stockpile projects | core    |
| Gradient (slope) map in %, degrees or ratio                           | Missing         | No slope raster anywhere                                                                                                                                                                                                                                                       | core    |
| Shaded relief with sun azimuth, altitude and intensity                | Partial         | Fixed multi-directional hillshade (`dsm.ts` `hillshade`); M10 G3 adds a hillshade DSM layer and G7 MapLibre `raster-dem` hillshade. No user sun controls                                                                                                                       | stretch |
| Shadows by date and time                                              | Have            | `packages/engine/src/stage/environment.ts`, `apps/desktop/src/renderer/environment/EnvironmentTool.tsx`                                                                                                                                                                        | n/a     |
| Contour lines (minor/major interval, colour, thickness)               | Missing         | Contours are used only inside pile detection (`python/src/aio_pipelines/volumetric/process.py`)                                                                                                                                                                                | core    |
| Point cloud: point size, classification colours, per-class toggles    | Have            | `packages/pointcloud/src/PointCloudControls.tsx`, `ClassificationLegend.tsx` (`onToggle`), `classes.ts`                                                                                                                                                                        | n/a     |
| Crop to a boundary (draw, copy from a previous flight, KML)           | Missing         | The stockpile job has yard and excluded-zone polygons (`volumetric/job.json` `detect`), which only steer pile detection                                                                                                                                                        | stretch |
| Terrain cleanups (remove equipment and piles from the DEM by polygon) | Missing         | Nothing edits a DSM                                                                                                                                                                                                                                                            | core    |
| Camera positions layer                                                | Have            | Photo and flight paths (`apps/desktop/src/renderer/workspace/flightPaths.ts`, photos layers)                                                                                                                                                                                   | n/a     |
| Vertical face imagery (oblique ortho of walls)                        | Partial         | Oblique photos, meshes and back-projection already cover vertical faces (`packages/annotate/src/crossview`); no oblique ortho product. M10 mesh (G3) helps                                                                                                                     | out     |
| Survey explorer: several surveys' layers on at once                   | Partial         | Captures per layer (`packages/workspace/src/captures.ts`); the Timeline T1 design (`docs/plans/2026-10-07-timeline-design.md`, sidebar tree by date) is approved, but no milestone is assigned yet                                                                             | n/a     |
| Photo viewer: click the 3D view, get the source photos                | Have            | `packages/annotate/src/crossview/backproject.ts`, `apps/desktop/src/renderer/workspace/FramesPane.tsx`                                                                                                                                                                         | n/a     |
| X-ray / cutaway / hide objects behind terrain                         | Have            | `packages/engine/src/tools/section.ts`, `apps/desktop/src/renderer/workspace/CutawayTool.tsx`; occlusion in `packages/annotate/src/tools/occlusion.ts`                                                                                                                         | n/a     |
| Fly mode (first-person camera)                                        | Missing         | Orbit and fly-to only                                                                                                                                                                                                                                                          | out     |
| Deep-linkable view state (camera, selection, design layers)           | Partial         | `SavedView` (camera, time, capture, layer) in `packages/schema/src/collab.ts`, used by comments. No link format (offline app)                                                                                                                                                  | stretch |
| Measurement labels on the map ("only when selected", property name)   | Partial         | Decluttered labels for issues and the distance tool (`packages/engine/src/overlay/declutter.ts`); no label options                                                                                                                                                             | core    |

## 2. Coordinate systems and units

| Propeller feature                                                                                    | Stratlas status | Evidence / notes                                                                                                                                                                                                                                                                       | M11     |
| ---------------------------------------------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Published CRS for the site (any EPSG)                                                                | Partial         | `packages/geo/src/index.ts` `crsDefinition` covers WGS84 UTM (326xx/327xx), 4326 and 3857 only; the manifest accepts WKT (`packages/ui/src/coords.ts` `crsLabel`); the pipelines use GDAL/PROJ (any CRS). M10 adds a searchable EPSG list for GCP files (plan "Ground control points") | core    |
| Vertical datum and geoid models (EGM, AUSGeoid, GEOID18, NZGeoid and others)                         | Partial         | One offset today (`VerticalDatum.absAltOffsetM`, `packages/schema/src/builder.ts`; KNOWN-LIMITS "No geoid model"). M10 G2 adds EGM96/EGM2008 through PROJ. Regional geoid grids are missing                                                                                            | core    |
| Local site calibration (Trimble .jxl/.dc/.cal, Topcon .gc3)                                          | Missing         | Proprietary formats; JXL is XML, .cal and .gc3 need reverse engineering or a documented subset                                                                                                                                                                                         | stretch |
| N/E/Z readout, NEZ/ENZ order, survey precision                                                       | Partial         | Cursor readout "E … N … · EL …" at 0.1 m (`apps/desktop/src/renderer/workspace/SceneCursor.tsx`, `packages/ui/src/coords.ts`). No order toggle, no mm precision                                                                                                                        | core    |
| Units: distance, area, volume, density; metric, imperial, US survey ft; per site and per measurement | Missing         | Metric everywhere (`Measurement.unit` is `m`, `m2` or `deg` in `packages/schema/src/annotation.ts`; `formatMetres`). Only DXF import reads `ft`/`us-ft` (`python/src/aio_pipelines/drawing`)                                                                                           | core    |
| Downloads in the site CRS and in WGS84                                                               | Partial         | Layers are stored in the project CRS; the issue GeoJSON export is WGS84 (`packages/project/src/export/geojson.ts`). No CRS choice on export                                                                                                                                            | core    |

## 3. Measurement tools and templates

| Propeller feature                                                                               | Stratlas status | Evidence / notes                                                                                                                                                                                               | M11     |
| ----------------------------------------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Distance (two points, 3D)                                                                       | Have            | `packages/engine/src/tools/measure.ts` (two clicks, not saved); map line length (`apps/desktop/src/renderer/road/useRoadMap.ts` `measureText`); agent `measure_distance` (`packages/ai/src/analysis-tools.ts`) | n/a     |
| Polyline with terrain, slope and horizontal distance                                            | Missing         | The 3D tool is one straight segment; map length is 2D only                                                                                                                                                     | core    |
| Point elevation with N/E/Z, saved                                                               | Partial         | Cursor readout only; issues store a sighting, not a surveyed point                                                                                                                                             | core    |
| Elevation history at a point across surveys                                                     | Missing         | The data is there (captures)                                                                                                                                                                                   | stretch |
| Elevation difference (point vs a surface)                                                       | Missing         |                                                                                                                                                                                                                | stretch |
| Grade/slope line (degrees, %, ratio)                                                            | Missing         |                                                                                                                                                                                                                | core    |
| Horizontal and vertical / vertex difference                                                     | Partial         | Issue measurements can be `height` (`annotation.ts` `Measurement`); no vertex table                                                                                                                            | core    |
| Berm check (height and widths across a barrier)                                                 | Missing         |                                                                                                                                                                                                                | stretch |
| Horizontal area                                                                                 | Have            | Map polygon area (`useRoadMap.ts` `polygonAreaM2`); issue measurement `area`                                                                                                                                   | n/a     |
| Terrain (3D) area and slope area                                                                | Missing         |                                                                                                                                                                                                                | core    |
| Radius buffer around a point                                                                    | Missing         |                                                                                                                                                                                                                | out     |
| Annotation and hazard points with severity                                                      | Have            | Issues with classes and severity models (`packages/schema/src/annotation.ts`, `severity.ts`, `packages/annotate`)                                                                                              | n/a     |
| Freehand draw markup                                                                            | Partial         | Points, lines and polygons on the map (`packages/maps/src/draw.ts`) and on meshes and clouds; no freehand                                                                                                      | stretch |
| Typed measurement templates (point/line/polygon families), tool descriptions, toolbar bookmarks | Partial         | Issue classes and severity models play the template role for issues; there is no saved measurement object type                                                                                                 | core    |
| Custom templates with custom fields (description, dropdown)                                     | Missing         | Issue fields are fixed (`Issue` schema)                                                                                                                                                                        | core    |
| Properties panel, style tab (colour, fill, border, icon, label size)                            | Partial         | Issue card and severity colours; no per-object style                                                                                                                                                           | stretch |
| Survey-scoped vs site-scoped (promote/demote), copy to another dataset                          | Partial         | `Issue.capture` (M8) and change matching across dates (`packages/change/src/issues.ts`)                                                                                                                        | core    |
| Bulk select with running totals                                                                 | Missing         |                                                                                                                                                                                                                | stretch |
| Measurement folders, workspaces, filters (tool, material, created by)                           | Partial         | Issue register filters and sorting (`packages/annotate/src/components/IssueRegister.tsx`); no folders or workspaces                                                                                            | core    |

## 4. Volumes, surface comparison and base surfaces

| Propeller feature                                                                         | Stratlas status | Evidence / notes                                                                                                                                                                                                                                  | M11     |
| ----------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Stockpile volume                                                                          | Have            | Piles found automatically (`python/src/aio_pipelines/volumetric/process.py`), volumes per base (`packages/volumetric/src/model/volume.ts`), boundary editor (`model/edit.ts`). Stockpile projects only                                            | n/a     |
| Base surfaces: smart (triangulated), reference level, lowest/highest, custom (per vertex) | Partial         | `VolumeBaseId` `tin`, `plane`, `avg`, `low` (`packages/schema/src/volumes.ts`). Missing: a typed reference elevation ("set to highest/lowest") and custom base vertices                                                                           | core    |
| Volume of any drawn polygon in any project                                                | Partial         | The boundary editor recomputes all bases for an edited toe line (`model/edit.ts` `editVolumes`), stockpile projects only. `ChangeSurfaceParams.areas` (`packages/schema/src/jobs.ts`) is accepted by `change/surface.py` but never sent by the UI | core    |
| Cut/fill survey to survey (whole site and regions)                                        | Have            | `python/src/aio_pipelines/change/surface.py` (DEM of difference, automatic regions, site totals, registration check); pile change (`volume.ts` `pileChange`)                                                                                      | n/a     |
| From/To surface pickers (any survey, any design, swap)                                    | Partial         | `change.surface` takes any two DSM or cloud layers; no design surfaces, no per-measurement picker                                                                                                                                                 | core    |
| Several surface comparisons in one measurement                                            | Missing         |                                                                                                                                                                                                                                                   | core    |
| Cut/fill heat map: editable stops, smooth/step, deadband used in calculations             | Partial         | Deadband in calculations (`VolumesFile` deadband, `minDepthM`); fixed diverging ramp (`change/imagery.py` `colour_ramp`); "Cut / fill" surface (`VolumeTools.tsx`). No editable stops                                                             | core    |
| 2D cut/fill view and contours of the difference                                           | Partial         | The heat map shows on the map and in 3D; no difference contours                                                                                                                                                                                   | stretch |
| Density and tonnage                                                                       | Have            | `packages/volumetric/src/store.ts` `setDensity`, tonnes in callouts (`scene/controller.ts`), `densityTPerM3` in `VolumesFile`                                                                                                                     | n/a     |
| Shrink/swell (bank, loose, compacted) calculator                                          | Partial         | `swell` in `VOLUME_DEFAULTS` (`python/src/aio_pipelines/volumetric/build.py`), not shown in the UI                                                                                                                                                | core    |
| Weight calculator (tonnage in, achieved density out)                                      | Missing         | The landfill compaction workflow depends on it                                                                                                                                                                                                    | stretch |
| Site materials list (name, ID, density; CSV import)                                       | Missing         | One density per project                                                                                                                                                                                                                           | core    |
| Area progress / remaining to design                                                       | Missing         | Needs design surfaces (section 7)                                                                                                                                                                                                                 | core    |
| Bench / blast volume against a reference level                                            | Missing         | Comes with reference-level bases                                                                                                                                                                                                                  | core    |
| Stockpile inventory CSV                                                                   | Have            | `packages/volumetric/src/model/register.ts` `registerCsv`                                                                                                                                                                                         | n/a     |

## 5. Cross-sections

| Propeller feature                                              | Stratlas status | Evidence / notes                                                                                                                                                                                  | M11     |
| -------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Section along a drawn line                                     | Partial         | `packages/volumetric/src/model/dsm.ts` `sectionProfile` (first vs last survey, cut/fill area along the line) and pile long sections (`model/section.ts`); stockpile projects only, DSM grids only | core    |
| Several surveys and designs, one line each                     | Missing         | Two surveys at most; no designs                                                                                                                                                                   | core    |
| Chart: pins with per-surface values and deltas, grade readouts | Missing         | `packages/volumetric/src/components/ProfileChart.tsx` draws lines and cut/fill shading only                                                                                                       | core    |
| Vertical exaggeration ratio, pop-out window                    | Missing         |                                                                                                                                                                                                   | stretch |
| Cutaway view at the section                                    | Have            | `packages/engine/src/tools/section.ts`, `CutawayTool.tsx`                                                                                                                                         | n/a     |
| DXF export (2D XY/XZ/YZ, 3D)                                   | Missing         |                                                                                                                                                                                                   | core    |
| Sections at stations along an alignment, corridor band         | Missing         | See alignments in section 7                                                                                                                                                                       | stretch |

## 6. Drawing aids

| Propeller feature                                             | Stratlas status | Evidence / notes                                                                                                                                                                                         | M11     |
| ------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Magic polygon (automatic boundary from the ortho)             | Partial         | Automatic stockpile toe lines (`volumetric/process.py`); mask assist **Outline** exists but ships without a model (KNOWN-LIMITS "Builder"). Change regions are found automatically (`change/surface.py`) | stretch |
| Clamp to terrain; measure on point clouds, meshes and designs | Have            | Picking and draping on meshes, clouds and the map: `packages/annotate/src/tools/mesh.ts`, `cloud.ts`, `drape.ts`                                                                                         | n/a     |
| Snap to designs, measurements, guidelines                     | Missing         |                                                                                                                                                                                                          | core    |
| Angle lock (Shift) and typed distance                         | Missing         |                                                                                                                                                                                                          | stretch |
| Edit shape: drag vertices, add midpoints                      | Partial         | Stockpile boundary editor only (`VolumesPanel.tsx`, "Drag a point… midpoint"); issue geometry is redrawn, not edited                                                                                     | core    |
| Keyboard drawing, Esc to cancel                               | Have            | Shortcut registry (`packages/ui/src/shortcuts.ts`)                                                                                                                                                       | n/a     |

## 7. Design surfaces and compliance

| Propeller feature                                                        | Stratlas status | Evidence / notes                                                                                                                                                                                                                                      | M11     |
| ------------------------------------------------------------------------ | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| DXF design import (lines, polylines, text, layers)                       | Partial         | `drawing.import` (`python/src/aio_pipelines/drawing/`): a 2D plot plan placed by control points, layers as GeoJSON plus a plan raster. Bulges drawn straight, block arrays partial, DWG refused (KNOWN-LIMITS). 3DFACE/MESH are not read as a surface | core    |
| LandXML surfaces and CgPoints                                            | Missing         |                                                                                                                                                                                                                                                       | core    |
| LandXML horizontal alignments, station intervals, station/offset readout | Partial         | The road project has a centreline with chainage and jump-to-km (`apps/desktop/src/renderer/road/`, `python/src/aio_pipelines/road/sources.py` reads GeoJSON, KML, DXF); no LandXML, no offset readout                                                 | stretch |
| TTM (Trimble TIN)                                                        | Missing         | Proprietary binary format                                                                                                                                                                                                                             | stretch |
| IFC models                                                               | Missing         | No permissive IFC parser that fits the licence rules (see "Constraint clashes")                                                                                                                                                                       | out     |
| KML/KMZ overlays                                                         | Partial         | KML lines read only as a road centreline (`road/sources.py`)                                                                                                                                                                                          | stretch |
| PDF site plan overlay, georeferenced by point pairs or coordinates       | Partial         | The DXF placement by control points (`drawing/place.py`) is the same maths; no PDF or image plan input                                                                                                                                                | stretch |
| Cut/fill to design, remaining to design, design progress                 | Missing         |                                                                                                                                                                                                                                                       | core    |
| Tolerance heat map against the design (deadband as ±tolerance)           | Missing         | The same engine as section 4                                                                                                                                                                                                                          | core    |
| Vertical offset on a design layer (subgrade, pavement depth)             | Missing         |                                                                                                                                                                                                                                                       | core    |
| Design-vs-design compare                                                 | Missing         |                                                                                                                                                                                                                                                       | stretch |
| Takeoff map (grid sampling, paper sizes)                                 | Missing         |                                                                                                                                                                                                                                                       | stretch |
| Propeller CAD (AI-generated earthwork designs)                           | Missing         | See "Constraint clashes"                                                                                                                                                                                                                              | out     |

## 8. Ground control, accuracy and QA

| Propeller feature                                                             | Stratlas status | Evidence / notes                                                                                                                     | M11     |
| ----------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| GCP and checkpoint import (CSV, EPSG), control vs check                       | M10             | Plan "Ground control points, checkpoints and accuracy"; G2 `gcp.py`; G4 import with column mapping. PHO-3                            | n/a     |
| GCP marking in photos                                                         | M10             | G4 marker view with predicted positions and draft target detection                                                                   | n/a     |
| Accuracy report: per-point error, RMSE, printable                             | M10             | `aio.photo-accuracy/1`, PDF export `photo-report-pdf`, house-report section `processing` (G2, G4). PHO-4                             | n/a     |
| GCP and checkpoint layer in the viewer                                        | M10             | G4 (points on the map); the Globe shows survey footprints (G6)                                                                       | n/a     |
| QA levels (strict/moderate/lenient RMSE thresholds, hold the survey)          | Missing         | M10 reports RMSE and warnings but has no pass/fail level                                                                             | core    |
| Compare-to-previous-survey QA (share of area changed beyond a threshold)      | Partial         | M8 refuses change between dates more than 2 px / 5 cm apart (KNOWN-LIMITS "Change between dates"); not offered as an upload QA check | core    |
| Checkpoint validation of an imported DSM or cloud (not processed by Stratlas) | Missing         | Matters for surveys delivered by Pix4D, DJI Terra or contractors                                                                     | core    |
| Elevation-model filters (equipment, vegetation, structures presets)           | Partial         | M10 G3 builds the DTM from PDAL `filters.smrf` ground points; no presets or parameters in the UI                                     | stretch |
| AeroPoints smart GCPs and the corrections network                             | Missing         | Hardware plus cloud. M10's PPK CSV and RTK EXIF priors are the hardware-neutral path                                                 | out     |

## 9. Survey timeline and comparison

| Propeller feature                                     | Stratlas status | Evidence / notes                                                                                                                                                                              | M11     |
| ----------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Survey picker grouped by date, hidden helper datasets | Partial         | `ProjectManifest.captures` and `captureIndex()` (`packages/workspace/src/captures.ts`); survey date chips in stockpile projects (`VolumeTools.tsx`). The T1 design covers the sidebar by date | n/a     |
| Timeline slider scrubbing orthos over time            | Partial         | `packages/ui/src/timeline/Timeline.tsx` (video and flight time); T1 date bar designed (`docs/plans/2026-10-07-timeline-design.md`)                                                            | n/a     |
| Side-by-side and swipe comparison of dates            | Have            | `apps/desktop/src/renderer/workspace/CompareScene.tsx`, `MapSwipe.tsx`                                                                                                                        | n/a     |
| Change detection across dates                         | Have            | M8: `change.raster`, `change.surface`, `change.cloud`, `change.mesh`, `change.frames` (`python/src/aio_pipelines/change/`), `packages/change`. Wider than Propeller's                         | n/a     |
| Composite surveys (merge flights or TIN datasets)     | Missing         |                                                                                                                                                                                               | stretch |
| Timelapse video                                       | Missing         |                                                                                                                                                                                               | stretch |

## 10. Annotations, collaboration and sharing

| Propeller feature                                          | Stratlas status | Evidence / notes                                                                                                                      | M11     |
| ---------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Annotation, hazard and media points                        | Have            | Issues with sightings on meshes, clouds, photos, video, the map and 360 panoramas (`Sighting` in `packages/schema/src/annotation.ts`) | n/a     |
| Media tab: geotagged photos, 360 photos, walkthrough video | Have            | Photos layers, `pano` sightings, `packages/video`                                                                                     | n/a     |
| Comments, assignment, approvals                            | Have            | M9: `packages/collab`, `apps/desktop/src/renderer/team`, audit trail (`packages/journal`)                                             | n/a     |
| Share site / share measurement by link                     | Partial         | Customer packages (`.aio`, free player), exchange files, shared folders and the team server preview (M9). No URLs, by design          | out     |
| Crew links (time-limited map links for field crews)        | Missing         | Cloud links. An offline reframe (an expiring read-only package) would fit M12 licensing                                               | out     |
| Private workspaces                                         | Partial         | Projects can be private or shared (M9); no workspaces inside a project                                                                | stretch |
| Mobile app, stake-out                                      | Missing         | PRD non-goal "Mobile apps"                                                                                                            | out     |
| Notifications, daily emails                                | Missing         | KNOWN-LIMITS: no email or push; **My work** in the app                                                                                | out     |

## 11. Reports, exports and imports

| Propeller feature                                                                        | Stratlas status | Evidence / notes                                                                                                                                                                                       | M11     |
| ---------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| Stockpile and measurement PDF report (crop to view, reference labels, totals row)        | Partial         | House report with a volumes section and pile map (`apps/desktop/src/renderer/reportPage/house/sections.ts` `layoutVolumes`); branded issue report (`report-pdf`). No measurement report                | core    |
| Measurement report CSV                                                                   | Partial         | Issues CSV (`packages/project/src/export/csv.ts`), stockpile register CSV                                                                                                                              | core    |
| Processing report                                                                        | M10             | G4 accuracy report view and PDF                                                                                                                                                                        | n/a     |
| PDF map print (paper size, orientation)                                                  | Missing         |                                                                                                                                                                                                        | stretch |
| Export view as JPEG                                                                      | Partial         | The agent can capture frames (`packages/maps/src/capture.ts`, `packages/ai/src/renderer-tools.ts`); no user-facing image export                                                                        | stretch |
| Fly-through video                                                                        | Missing         |                                                                                                                                                                                                        | stretch |
| Survey files: DSM/DTM/ortho GeoTIFF (site CRS and WGS84)                                 | M10             | G3 writes `dsm.tif`, `dtm.tif` and ortho COGs in `photogrammetry/<run>/`. Export in a chosen CRS or of imported surveys: missing                                                                       | core    |
| Survey files: LAS/LAZ (full and reduced)                                                 | Partial         | Clouds are stored as COPC (a valid LAZ 1.4); no export with a chosen CRS or decimation                                                                                                                 | core    |
| Survey files: DXF mesh (low/medium/high), DXF contours, terrain boundary GeoJSON         | Missing         |                                                                                                                                                                                                        | core    |
| Measurement export: outline DXF/KML, surface DXF 3D faces/TTM, point CSV                 | Partial         | Issues as GeoJSON and CSV (`packages/project/src/export/`); no DXF, KML or surface export                                                                                                              | core    |
| Import points from CSV                                                                   | Missing         | M10 imports GCP CSV only                                                                                                                                                                               | core    |
| Import pre-processed DEM and ortho GeoTIFF, LAS/LAZ, meshes                              | Have            | `packages/project/src/builder/raw.ts` (TIFF with `.tfw`/`.prj`, LAS/LAZ/E57/PLY to COPC through `pointcloud.to_copc`, OBJ/GLB); a cloud becomes a DSM in `volumetric/cloud.py` and `change/surface.py` | n/a     |
| Import TIN surfaces (from GPS or total station)                                          | Missing         | Comes with LandXML/TTM (section 7)                                                                                                                                                                     | core    |
| Integrations (Procore, Trimble Connect, OneDrive/SharePoint, Autodesk), WMTS, public API | Missing         | Cloud services; see "Constraint clashes". Shared folders (M9) already work with OneDrive or Dropbox folders                                                                                            | out     |

## 12. Hydrology

| Propeller feature                                                    | Stratlas status | Evidence / notes                                                                              | M11     |
| -------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------- | ------- |
| Flood to level (outline, DXF)                                        | Missing         | Cheap on a DSM (cells below a level, connected to a seed); reuses the contour and DXF writers | stretch |
| Surface runoff and preferential flow path                            | Missing         | Needs flow-direction code; check the licences of hydrology libraries (see clashes)            | stretch |
| Catchment / watershed, stream network                                | Missing         |                                                                                               | stretch |
| Direct rainfall simulation (rainfall CSV, Manning's n, infiltration) | Missing         | A 2D hydraulic solver; specialist                                                             | out     |

## 13. Haul roads

| Propeller feature                                                                                                               | Stratlas status | Evidence / notes                                                                                                                                                       | M11     |
| ------------------------------------------------------------------------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Haul road analysis (centreline detection, width, gradient, cross fall, superelevation, berm height, compliance thresholds, PDF) | Missing         | The road project (`python/src/aio_pipelines/road/`) is pavement condition (ASTM D6433 PCI), not geometry. Haul road geometry needs the section and grade engines first | stretch |

## 14. Special site types

| Propeller feature                                                                    | Stratlas status | Evidence / notes                                                                                                                                                                                                                | M11     |
| ------------------------------------------------------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Lidar: pre-processed LAS/LAZ, classification display, DEM from the ground class      | Partial         | Import and class display: Have (`pointcloud.py`, `ClassificationLegend.tsx`). Clouds are gridded to DSMs (mean per cell); a DTM from class 2 or `filters.smrf` arrives with M10 G3. Raw lidar processing stays a non-goal (PRD) | core    |
| Terrestrial and handheld scans (E57, phone lidar) as overlays                        | Have            | E57/PLY import (`builder/raw.ts`), COPC layers                                                                                                                                                                                  | n/a     |
| Landfill: airspace to cell design, compaction (t/m³) per lift                        | Missing         | Needs design compare plus the weight calculator                                                                                                                                                                                 | stretch |
| Mine: blast/bench volumes, berm checks, exclusion zones, mine plans                  | Partial         | Exclusion zones and hazards as issues: Have. Bench volumes, berm checks and mine plan designs: Missing                                                                                                                          | core    |
| Highway: station/offset against an alignment, cross-sections against the final grade | Partial         | Chainage on the road centreline (road project); see sections 5 and 7                                                                                                                                                            | stretch |

## 15. DirtMate machine tracking

| Propeller feature                                                        | Stratlas status | Evidence / notes                                      | M11 |
| ------------------------------------------------------------------------ | --------------- | ----------------------------------------------------- | --- |
| Live machine surface, load/dump cycles, utilisation tables and timelines | Missing         | Proprietary telematics hardware and a live cloud feed | out |
| DirtMate RTK in-cab guidance and stake-out                               | Missing         | Hardware plus a mobile app (PRD non-goal)             | out |

## 16. AI features

| Propeller feature                                         | Stratlas status | Evidence / notes                                                                                                              | M11     |
| --------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------- |
| AI Cut/Fill with automatic volume breakdown into polygons | Have            | `change.surface` joins cut and fill cells into regions with volumes, as proposals a person confirms (rule-based, not learned) | n/a     |
| Magic polygon (learned boundary suggestion)               | Partial         | See section 6. A permissively licensed segmentation model would fill the empty **Outline** slot                               | stretch |
| Propeller CAD (LLM chat produces earthwork designs)       | Missing         | Out; the local AI agent (`packages/ai`) could instead get read-only survey tools (volume, section, grade) to answer questions | out     |

## 17. Upload and processing

| Propeller feature                                                              | Stratlas status | Evidence / notes                                                                                                  | M11 |
| ------------------------------------------------------------------------------ | --------------- | ----------------------------------------------------------------------------------------------------------------- | --- |
| Photogrammetry from drone photos (ortho, DSM, DTM, cloud, mesh)                | M10             | G2 and G3; pipeline diagram in "The pipeline"; PHO-1 to PHO-7                                                     | n/a |
| Photo validation (count, geotags, size, blur) with a reason per rejected photo | M10             | G2 `photo.align` inspect step; PHO-2                                                                              | n/a |
| PPK/RTK workflows                                                              | M10             | RTK EXIF/XMP priors and a PPK CSV ("Ground control points…", "Geotags"). PPK from raw RINEX: not planned          | n/a |
| Processing queue                                                               | Have            | Jobs panel (`apps/desktop/src/renderer/jobs.ts`), resumable pipeline jobs (`python/src/aio_pipelines/runtime.py`) | n/a |
| Automated uploads (DJI Dock), connections to other platforms                   | Missing         | Cloud                                                                                                             | out |

## Constraint clashes

**Offline first (no cloud).** These Propeller features exist only as cloud services. Each should be left out or reframed:

| Propeller feature                                                     | Offline reframe                                                                       |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Share and Crew links                                                  | Customer packages and the free player; an expiring package belongs with M12 licensing |
| Push-to integrations (Procore, Trimble Connect, SharePoint, Autodesk) | File exports into a shared folder (M9 already syncs through OneDrive/Dropbox folders) |
| WMTS streaming                                                        | A GeoTIFF/COG export, or a later local tile server; not in M11                        |
| Public API                                                            | The pipeline pack's JSON-RPC is internal; not in M11                                  |
| Notifications and daily emails                                        | None                                                                                  |
| Org platform analytics                                                | None                                                                                  |
| DJI Dock auto-upload                                                  | A watch folder at most                                                                |
| Satellite base map (Maxar via Cesium ion)                             | M10 imagery packs                                                                     |
| Emailed exports                                                       | Direct file writes                                                                    |

**Hardware-specific.**

- AeroPoints and the Propeller Corrections Network: out. M10's GCP CSV, PPK CSV and RTK priors are the vendor-neutral path. PPK from raw RINEX would need an engine. RTKLIB is BSD-2-Clause, but verify the version and its bundled code first.
- DirtMate telematics, RTK guidance and stake-out: out.
- Propeller PPK hardware: out.
- The mobile app: out (PRD non-goal).

**Licences (permissive only, M10 decision 1).**

- **IFC.**
  - IfcOpenShell is LGPL-3.0: a shared library only, and only with founder approval.
  - web-ifc is MPL-2.0: founder approval needed.
  - Recommendation: out for M11.
- **DWG.** LibreDWG is GPL-3.0 and the ODA SDK is commercial. Stay DXF-only, as today.
- **TTM and Trimble .cal/.dc, Topcon .gc3.** Proprietary formats. Read only from a public specification or a documented subset, and check the vendor terms.
- **Hydrology.**
  - pysheds and RichDEM are GPL-3.0 and GRASS is GPL (verify each before any decision).
  - WhiteboxTools is MIT. Writing our own D8 flow code on numpy/scipy is also small.
  - Direct-rainfall solvers need a licence check, one by one.
- **Magic polygon.**
  - The model weights must be permissive and allowed for commercial use (the M10 exclusions for non-commercial weights apply).
  - SAM and SAM 2 are Apache-2.0 (verify the weights' terms).
- **Propeller CAD.** Generative designs are "not engineer-approved", which brings liability. A cloud LLM would also break offline-only. Out.
- **No new risk** from contours (scikit-image), DXF writing (ezdxf, MIT), LandXML (own parser), geoids (PROJ-data grids; check each regional grid's licence) or EPSG definitions (bundle them offline; check the data licence).

**Contract constraint (from M10).** A new layer kind, raster format or `LayerDerived.kind` makes a 0.9 build refuse the whole manifest. M10 G0 makes 0.10 and later tolerate unknown kinds. M11 measurements and design surfaces should still go in new side files (as `tilesets.json` does) or in layer kinds that 0.10+ readers tolerate, each with a row in `docs/architecture/contract-changes.md`.
