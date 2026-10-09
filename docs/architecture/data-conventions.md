# Data conventions (contracts v1 clarifications)

These rules sit beside `@aio/schema` and are binding for every stream. They clarify how data inside a native project package is laid out; they do not change any schema.

## 1. Scene frame

- All geometry in a project (meshes after their layer `transform`, point clouds, poses, rasters, sightings) lives in one **local frame**: metres, right-handed, **Y up, X east, Z south** (three.js convention). North is `-Z`.
- Project CRS coordinates relate to the local frame by `E = origin[0] + x`, `N = origin[1] - z`, `H = origin[2] + y`, where `origin` is the manifest `origin` in the manifest `crs` (projected, metres).
- Source data in another frame (Asset Inspection Kit: Y up, X north, Z east; plant grids) is converted **at import** (stream S10). Mesh GLBs are not rewritten; the importer bakes the rotation and offset into the mesh layer `transform` (column-major 4x4, three.js `Matrix4.elements` order).

## 2. Project package layout

```
<dataRoot>/projects/<project-id>/
  manifest.json          aio.project/1
  issues.json            { "schema": "aio.issues/1", "issues": Issue[] }
  thumbnail.jpg          library poster (optional)
  models/                GLB files
  video/                 MP4 (H.264 or H.265)
  posters/               JPG poster per clip
  flights/               pose files (section 3)
  clouds/                point cloud data (section 4)
  rasters/               ortho, plans (image + placement or tile pyramid)
  photos/                review copies (<= 2560 px) + thumbs/
  panoramas/
  report/                PDF report and exports
  legacy/                the original offline viewer, copied unchanged (legacy layer `entry`)
  journal/               M9: signed history of every change (section 17); older builds ignore it
  team.json              M9: only when the project is shared (section 19)
  photogrammetry/<run>/  M10: processing runs (section 21); older builds ignore it
  tilesets.json          M10: 3D Tiles of the project (section 22), tiles in tiles/<id>/
  survey/                M11: surveying side files (sections 25 to 30); older builds ignore it
```

`<dataRoot>` defaults to `E:\Stratlas Data` on the development machine (elsewhere `Documents\Quadrion AI Data`, or an existing `Documents\Stratlas Data` from before the rename) (`QUADRION_DATA` env var overrides; Settings `dataRoot` in the app). End-to-end tests never use the real data root as the app's data root: they run on temporary copies made by `apps/desktop/e2e/realData.ts`, and an app started by a test (`QUADRION_E2E=1`) refuses every write under `QUADRION_REAL_DATA_ROOT` (default `E:\Stratlas Data`); see CONTRIBUTING.md, "End to end on real client data". Map packs live in `<dataRoot>/packs/<id>.pmtiles` with `<id>.json` (`MapPackInfo`).

**Layers of a kind this build does not know** (0.10 and later, M10 G0): a manifest from a newer 1.x build that added a layer kind opens; such a layer (an object with a string `kind` this build does not know, an `id` and a `name`) is set aside (`parseManifestTolerant`, `unknownLayersOf`), never drawn, and carried over unchanged, after the known layers, every time this build saves the manifest (`keepUnknownLayers` in `writeManifestFile`). A new layer that would take its id is refused. 0.9 and older refuse such a manifest outright, which is why M10 itself adds no layer kind, raster format or derived kind. Packages made by 0.10 leave such layers out.

`aio://project/<project-id>/<relative path>` serves any file under the project folder with HTTP range support; `aio://packs/<id>.pmtiles` serves map packs.

Photo files (review copies and their `thumbs/`) store their pixels the way the camera saw them: the original's EXIF Orientation applied, no Orientation tag left, so image +Y is the pose's up (section 3) for every reader (browser, PIL, the pipelines). Importers turn delivered copies that dropped the tag (the HCl kit's Elios 3 thumbnails, Orientation 3) and every image sighting on them (`@aio/project` `orientation.ts`); `pnpm reorient:photos` (packages/project) repairs an existing project against its camera originals, with a backup.

`aio://thumb/<project-id>/<relative path>` serves a small thumbnail of an image for grids (Media): the project's own `<dir>/thumbs/<name>.jpg` beside the image (`photos/thumbs/p001.jpg` for `photos/p001.jpg`), else one cached in the app profile (userData `cache/thumbs/`, keyed by project location, path, size and date), else 404. On a 404 the renderer makes a 320 px thumbnail in a worker and stores it with IPC `thumbs:put`. Thumbnails are never written into a project folder.

Reports Quadrion AI generates (issue register PDF) carry the person's own branding from Settings, Report branding (`Settings.reportBranding`; the logo is copied to userData `branding/` and served as `aio://branding/<file>`), or none. A manifest's `brand` (a client brand from an import or an older wizard) is kept but never used for reports. Delivered PDFs under `report/` are shown as delivered.

A `legacy` layer's `entry` is the viewer's HTML inside `legacy/`, for example `{ "path": "legacy/Masafi Stockpile Review.html" }`, with everything the viewer reads (`data/`, `lib/`, `tiles/`, `report/`, ...) beside it as delivered. HTML under `legacy/` is served with the platform shims injected first and a CSP that allows the viewer's own `aio:` files and nothing remote (see `apps/desktop/src/main/protocol/shim.ts`).

## 3. Flight pose files

A video layer's `flight.src` points to a JSON file:

```json
{
  "schema": "aio.flight/1",
  "startUtcMs": 1676970000000,
  "lens": { "model": "ftheta", "hfovDeg": 114, "aspect": 1.7778 },
  "samples": [{ "t": 0, "pos": [x, y, z], "q": [qx, qy, qz, qw] }]
}
```

- `t` is milliseconds since `startUtcMs`; samples sorted, about 10 Hz or better.
- `pos` in the local frame (section 1).
- `q` is the **camera** orientation as a three.js quaternion: the camera looks along its local `-Z` with `+Y` up in the image. Gimbal angles are already folded in.
- Video time `v` (seconds) maps to project time `startUtcMs + offsetMs + v * 1000`, with `offsetMs` from the video layer.
- Calibration on the video layer (BLD-3, optional): the camera that took the frame is at `pos + positionOffsetM` (local frame, metres) with orientation `q * Ry(yawDeg) * Rx(pitchDeg) * Rz(rollDeg)` from `orientation` (camera-frame bias, three.js Euler `YXZ`). Projection, frustum, drone-eye view, map footprint and video sightings all use the calibrated pose; the pose file stays as logged.
- Camera direction keyframes set by hand ("Align camera to map") live in `orientation.json` (section 21), not in the flight file or the manifest. **The one pose rule** (`clipPoseAt` in `@aio/geo`, used by the 3D rig, the map, sightings, frame pairing, the AI tools and the tools themselves): position = normalised log + `positionOffsetM`; orientation = the clip's keyframes when it has at least one (absolute: the logged orientation **and** the calibration bias `orientation` do not apply), else the logged orientation (gimbal angles or the importer's estimate) turned by `orientation`. Calibrate video therefore still composes with gimbal clips; on a clip with keyframes only its position offset, lens and time offset matter.
- Optional `heights` (`FlightHeights`): the rule the sample heights came from (section 3a), `{ "source": "absolute" | "relative" | "none" | "mixed", "absOffsetM": 100, "takeoffH": 100 }` (`mixed`: some samples fell back to the other altitude). A file without it predates the record; an importer that rewrites the file compares the two to rebase calibration.

## 3a. Camera elevation (drone altitudes to project heights)

Every importer that places a drone camera (raw import of photos and of video with its SRT, the Al-Zour importer, pipeline `aik.cameras`) follows one rule. Code: `@aio/geo` `projectHeight`, `@aio/project/builder` `resolveHeights`, `python/src/aio_pipelines/aik/cameras.py` `camera_height`.

Drones log two altitudes:

| Altitude | Where                                                                                                                         | What it is                                                                                                                                                                                                                                                                                                                                                           |
| -------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Relative | SRT `rel_alt` (older `BAROMETER`, `H`), XMP `RelativeAltitude`                                                                | Barometric height above the take-off point. Steady within a flight; a project height only once the take-off point's height is known.                                                                                                                                                                                                                                 |
| Absolute | SRT `abs_alt` (older `altitude`, or the third value of `GPS(lon, lat, alt)`), XMP `AbsoluteAltitude`, else EXIF `GPSAltitude` | Barometric, offset to GNSS at power-on, nominally above mean sea level but often tens of metres off, and it drifts between flights (Al-Zour: the take-off point read 41.9, 32.2, 28.4, 25.6, 22.7 m over five flights; a Mavic 3 SRT logged `abs_alt` 81 m below `rel_alt`). RTK aircraft write ellipsoidal heights. A project height only through a vertical datum. |

The project's vertical datum is the optional manifest field `verticalDatum` (`VerticalDatum`): `H = absolute altitude + absAltOffsetM`, with a `note`. For ellipsoidal (RTK) altitudes in an orthometric project the offset is minus the geoid undulation at the site; for a site datum it is the shift between the two (Al-Zour: plant EL = absolute + 100). The new project wizard sets offset 0 when the origin height comes from a photo's absolute altitude (heights then share that datum); the Al-Zour importer sets +100.

Rule:

1. **Absolute altitude with the datum** when the project defines `verticalDatum` (or the person picks absolute altitude at import with an offset; the import saves it as the project's datum so later imports agree).
2. **Else relative altitude plus the take-off height** `H = takeoffH + relative`. The import UI asks for the take-off H before it imports and proposes the model height under the take-off point (a ray down through the loaded models at the SRT `HOME` point, else at the lowest logged position); with no model there it proposes the origin height (local y 0) with a visible warning.
3. Per reading, a file without the preferred altitude uses the other one; a reading with neither sits at the take-off height. Items say so (`ImportItem.heightSource`: `absolute`, `relative`, `none`, `mixed`).
4. Absolute altitude without a datum (a project with none, files with no relative altitude) is used as logged and the summary warns that it can be tens of metres off.

The import summary (`builder:import` response `heights`, `ImportHeights`) states the source and the number: the datum offset, or the take-off H and where it came from (`terrain`, `typed`, `origin`), so the person can correct it. `builder:altitudePlan` returns what the files carry (`AltitudePlan`: counts, the project datum, the proposed rule, the take-off position and the take-off point's absolute altitude, the median of absolute minus relative altitude). The wizard's origin from a photo takes the take-off point's absolute altitude (absolute minus relative) as the ground height, not the camera's.

Relative altitude plus a take-off height is the better choice when the take-off point's height is known (surveyed, or a take-off on the model) and when the absolute altitude drifts between flights; absolute altitude is better when the project has a fitted or surveyed datum and the flights took off from places of unknown height. A video layer's `positionOffsetM` (BLD-3 calibration) soaks up what remains; a re-import that changes the logged heights takes that change off the offset (Al-Zour, `carryVideoCalibration`).

`aik.cameras` (kit frame, heights above the ground altitude of `origin`): with a given origin, absolute altitude minus its ground altitude; without one, the ground is the take-off point (median of absolute minus relative altitude) and heights are relative altitude plus `takeoffHeight` (default 0). Params `altitude` (`auto`, `absolute`, `relative`) and `takeoffHeight` override; every camera record carries `altitude_source`.

## 4. Point clouds

- `format: "kit-packed"`: `src` is a binary in **planar** layout, little-endian: all points' int16 x, y, z (millimetres, interleaved per point, 6 bytes each) first, then all uint8 intensities (1 byte per point), as in the HCl artifact `vy()` decoder. Coordinates already in the local frame unless the layer is given a transform; scale 0.001. One file per flight is allowed; then use one layer per flight.
- `format: "png-packed"`: `src` is an index JSON `{ "schema": "aio.pngcloud/1", "bounds": {"min":[..],"max":[..]}, "chunks": [{ "file": "clouds/c000.png", "points": n, "bounds": {...}, "lod": 0 }] }` with the decoding rules taken from the Al-Zour artifact (uint16 xyz quantised to chunk bounds, rgb), documented in `packages/pointcloud/README.md` (authoritative). The legacy Al-Zour `pc.json` index is also accepted.
- `format: "copc"`: a COPC LAZ file in the project CRS; the adapter subtracts `origin` and applies section 1.

## 5. Rasters

- `format: "image"`: a single JPG/PNG/WebP with `corners` (`tl`, `tr`, `bl` in the local frame); drawn as a textured quad on the ground.
- `format: "kit-pyramid"`: `src` is a `tiles.json` `{ "schema": "aio.tiles/1", "levels": [{ "z": 0, "tileSize": 512, "cols": c, "rows": r, "pattern": "rasters/ortho/{z}/{x}_{y}.webp" }], "corners": {...} }`.

## 6. Issues

`issues.json` holds every issue of the project. Writes go only through IPC `project:writeIssues` (atomic replace). Severity values must exist in the named severity model (`validateIssueAgainstModel`).

## 7. Test data

- Small real fixtures: `E:\Dev\AIO Software\docs\design\assets\` (git-ignored, see its `MANIFEST.md`): HCl tank GLB, 280k-point cloud, two clips with pose JSON (in tank frame), photos; Al-Zour plant GLB (Meshopt), ortho with placement, two clips with paths, panoramas.
- Full sources being staged: `E:\Stratlas Data\sources\{hcl,alzour}\` with `INVENTORY.md`.
- Native packages produced by S10: `E:\Stratlas Data\projects\{hcl,alzour}\`.

## 8. Single-file packages (`.aio`)

A project folder (section 2) delivered as one file (BLD-9) and opened in place (APP-5). Written and read by `@aio/project/package` (format details in `packages/project/README.md`).

- ZIP with ZIP64 records, **store mode only**; members are the folder's relative paths. Optional WinZip AES-256 (AE-2) for every member. No unpacking: `aio://project/<id>/<path>` serves members by offset with ranges, exactly as for a folder.
- `aio-package.json` (`PackageHeader`, `aio.package/1`) first, then `manifest.json` with the excluded layers removed. A package without a header is treated as a read-only customer package.
- A package is **never written**: `project:writeIssues` refuses it, the renderer switches annotation to read-only, and no file is added next to it. Cloud AI runs only when Settings allow it **and** the header says `aiPolicy: 'allow'`. `dialog:saveFile` accepts only the export kinds in the header (`exportKindForFile`).
- Customer packages (`readOnly: true`) open on the welcome screen (player mode).
- Map packs (optional): the export can carry the map region the project needs, clipped from an installed pack to the site (origin and placed rasters) plus a margin, up to a chosen zoom, as `packs/<id>.pmtiles` with `packs/<id>.json` (`MapPackInfo`). While the package is open, `packs:list` adds it as `pkg-<project id>-<id>` (`source: 'package'`) unless an installed pack has that id or covers its area at its zoom or deeper, and `aio://packs/pkg-...pmtiles` serves it from inside the package. Without one, basemap layers fall back to the installed packs and the project rasters.
- Extract to edit: `package:extract` copies an open (unlocked) package into `<dataRoot>/projects/<file name>-edit/` (never an existing folder; `-2`, `-3` ...), verified member by member, with the manifest `id` set to the folder name and `package-origin.json` (`PackageOrigin`, `aio.origin/1`: package file name, its `createdAt` as `exportedAt`, `extractedAt`, `extractedBy`). Refused when the header's `editPolicy` is `forbid`; without `editPolicy`, a working package (`readOnly: false`) may be extracted and a customer package may not. The `.aio` file is only read.
- The OS association (`fileAssociations` written by `tools/release/brand-config.mjs`, one entry for NSIS, MSIX and macOS) and the single-instance hand-off pass a double-clicked `.aio` to the running app; opened packages join the library (`library.json` keeps the file path).

## 9. Vector overlays and road surveys

- A `vector` layer (`format: "geojson"`) points at a GeoJSON FeatureCollection in lon/lat (WGS84). Its optional `style` (line, fill, circle, label, a step `colorBy` ramp on a numeric property, `minZoom`) draws it on the 2D map.
- A road survey keeps `road.json` (`aio.road/1`, `RoadModel` in `@aio/schema`) at the package root. The app looks for it when the project declares a `legacy` layer with `viewer: "road"` or a class catalogue with `assetType: "road"`, and then opens the road workspace (map first, chainage ruler, PCI and density overlays).
- Road grids (PCI sample units and density cells) are aligned to the project CRS: cell `(i, j)` of size `c` spans local x `origin[0] + j c` to `+ c` and z `origin[2] + i c` to `+ c` (`origin` is `pci.grid.origin` or `density.gridOrigin`).
- `road.json` `overlays` names project-relative GeoJSON files by role: `centreline` (the centreline as a LineString with `chainageKm`, and chainage ticks as Points with `km` and `label`) and `pciUnits` (unit cells as MultiPolygons with `id`, `km`, `pciLow`, `pciMedium`, `pciHigh`).
- Map sightings (`on: "map"`) keep their GeoJSON in lon/lat; Polygon and MultiPolygon sightings draw as polygons on the map and draped on the 3D ground.
- The road builder (pipeline `road.build`, `python/src/aio_pipelines/road/`) writes the same files for a road built from raw data: `rasters/ortho/` (kit pyramid, layer `ortho`), `photos/closeups/fNNNN.webp` (layer `closeups`), `road.json`, `road/centreline.geojson`, `road/pci-units.geojson`, and merges its issues (`rd-NNNN`, codes `DNNNN`) into `issues.json` as the importers do (issues people added or edited are kept; `.bak` of `issues.json` and `manifest.json`). `pci.layout` is `grid` (as delivered, square cells of `pci.grid`) or `chainage` (units along the centreline: `cells` empty, `fromKm` and `toKm` set, `pci.grid.cellM` is the unit length; the unit outlines are in `road/pci-units.geojson`). PCI follows ASTM D6433 with the deduct curves in `aio_pipelines/road/pci_curves.json` (see `pci.py` for their source).
- A road project created in the wizard (`type: "road"`) opens the road workspace before it has a `road.json` (setup): a centreline drawn on the map is saved through IPC `project:writeCentreline` as `road/centreline-drawn.geojson` (a LineString in lon/lat) for the road builder.

## 10. Stockpile volumes

Volumetric projects keep their volumes beside the manifest (schemas in `@aio/schema` `volumes.ts`):

```
<project>/
  volumes.json             aio.volumes/1: piles, toe lines, four bases, fill/cut/net, change
  edits/boundaries.json    aio.boundaries/1: toe lines corrected by hand (written by the app)
```

- Rings (`zoneRing`, `epochs.<epoch>.ring`, edit `ring`) are `[x, z]` in the local frame (section 1). `centreEN` is in the project CRS.
- `captures[]` lists the surveys in order with their short `epoch` key (`e1`, `e2`); optional `layers` names the manifest layers that show each survey. When absent, the terrain mesh of a survey is the mesh layer whose tags name the survey's pile nodes, and its ortho the raster layer whose id or name holds the survey date.
- `grids` locates the source grids the app recomputes volumes on: `piles` (10 cm pile grids, `{id}`), `dsm` (0.4 m site DSM, `{epoch}`) and `coarse` (0.4 m pile masks), all in the Volumetric Survey Kit script format (`window.VS_*` JSON with zlib and base64 grids, decoded in `packages/volumetric/src/model/kitdata.ts`). When absent, readers use the kit layout the importer copies unchanged: `legacy/data/piles/{id}.js`, `legacy/data/dsm_{epoch}.js`, `legacy/data/vol.js`.
- A project built in the app from raw surveys (pipeline `volumetric.build`) keeps the kit's grids and job under `volumetric/` (`volumetric/data/piles/{id}.js`, `volumetric/data/dsm_{epoch}.js`, `volumetric/data/vol.js`, `volumetric/data/site.js`, `volumetric/piles.csv`, `volumetric/job.json`), one terrain mesh per survey (`models/terrain-<date>.glb`, pile nodes `<pile>_<epoch>`) and one `kit-pyramid` ortho per survey (`rasters/ortho-<epoch>/tiles.json`), the same layout as the Masafi import. Editing `detect` in `volumetric/job.json` (yard polygon, clip lines, excluded zones) and running the job again with `job: "volumetric/job.json"` rebuilds it; boundary edits are kept.
- The app reads both files through IPC `project:readVolumes` (validated in main). `edits/boundaries.json` is written only through IPC `project:writeBoundaries` (atomic replace with `.bak`). One edit per pile and epoch; an edit's volumes replace the automatic ones in every register, total and export.
- A `.aio` package carries both files; the app reads them from the package and never writes edits into it (section 8).

## 11. Detections and the inspection pipeline

Detections are boxes on photos found by a person, an AI vision pass or a local model. Each pass is one file in the project (schema in `@aio/schema` `detections.ts`, checked again in `python/src/aio_pipelines/inspection/detections.py`):

```
<project>/
  detections/<pass>.json      aio.detections/1, one file per pass: review.json (drawn in the review),
                              ai-<run>.json (one AI run), ONNX or imported passes
  inspection/                 written by the inspection pipeline (inspection.run)
    contact/sheet-NN.jpg      contact sheets, 4 photos across, photo ids burned in
    contact/layout.json       aio.contact-sheets/1: each sheet's cells (photo, x, y, w, h, pw, ph)
    detections.json           the detections that counted in the last run (aio.detections/1, preview space)
    records.json              Asset Inspection Kit records summary and stats (aio.aik-records/1)
    findings.csv              the kit findings CSV
    issues-map.json           aio.inspection-issues/1: the pipeline's issues, their detections and hashes
```

```json
{
  "schema": "aio.detections/1",
  "source": "ai",
  "producer": "anthropic claude vision",
  "createdAt": "2026-10-05T08:00:00Z",
  "layer": "photos",
  "assessed": "all",
  "detections": [
    {
      "id": "a1",
      "photo": "p001",
      "class": "corrosion",
      "severity": 2,
      "bbox": [412, 300, 470, 352],
      "confidence": 0.81,
      "status": "draft",
      "note": "Rust streak below the flange"
    }
  ]
}
```

- `source`: `human`, `ai`, `model` (local ONNX) or `import`; a detection may override it. Issues from `ai` or `model` detections are `source: "agent"`, the rest `import`.
- `status`: absent or `accepted` counts; `draft` (an AI or model result nobody accepted) counts only when the job runs with `includeDrafts`; `rejected` never counts. Nothing from AI counts until a person accepts it.
- `class`: a class id of the project's class catalogue (a label is accepted). `severity`: a level of that class's severity model or `"uncertain"`; default 2 (the kit adapter's default) or the lowest level.
- `bbox`: `[x0, y0, x1, y1]` in `space`: `preview` (default; pixels of the project photo file, the grid of image sightings), `source` (pixels of an original of `width` x `height`), `normalized` (0 to 1) or `sheet` (pixels of the contact sheet `sheet` of the last run; the photo is the one under the box centre).
- `id`: stable per detection, chosen by the producer; without one it is derived from the photo, the class and the rounded box, which also merges duplicates across files.
- `assessed`: the photos the pass looked at (`"all"` by default), for the assessed count in the stats.
- Review fields (all optional; the pipeline reads only `issueId`): `frame` (`{ "layer", "t" }`, a video frame in video seconds, in place of `photo`; boxes in `source` space with the frame's `width` and `height`, or `normalized`; not placed by the pipeline), `geom` (the exact shape: `box`, `rotbox`, `polygon` or `point` in the pixel grid of `space`; `bbox` stays required and is its bounds), `label` (the proposer's word when it matched no class), `uncertain`, `origin` (`author`, or `provider`, `model`, `promptVersion`, `runId`), `issueId`, `reviewedBy`, `reviewedAt`, `createdAt`, `updatedAt`. A file may carry `run` (`id`, `at`, provider, model, prompt version, images, detections, tokens, `costUsd`).
- The review (R1) reads every pass and writes each change back into the pass it came from (atomic, `.bak`): entries it did not change stay byte for byte, changed ones are written in `source` space with `width` and `height` of the photo file, ids are never added to entries that had none. Drawings go to `review.json`, each AI run (R2) to `ai-<run>.json` (with `run` and `assessed`). Contact sheet boxes and photos the review cannot find stay in their files untouched. Other files in `detections/` (kit lists, COCO) are left alone.
- `issueId` on an accepted detection: a person made (or extended) that issue in the review. The pipeline places such detections but never groups them into an issue of its own; it adds the placement (mesh sighting) to that issue when it has none and changes nothing else, and does not make the issue again if it was deleted. The other way round, the review shows detections the pipeline already turned into issues (`inspection/issues-map.json`) as accepted, with the pipeline's issue, and offers nothing to accept twice.
- The kit's own inputs are accepted too: a kit list (`[{ "image", "class", "bbox", "space"?, "normalized"? }]`), COCO, and YOLO folders with `yoloNames`.

The pipeline converts the project into a kit job in its staging folder (kit model frame: X north, Y up, Z east, around the asset axis, which is the centre of the models' footprint), places every box on the models with the kit's back-projection (median hit of a 5 x 5 ray grid in the central half of the box), groups placed detections of the same class within `cluster_m` (default max(0.75 m, 2% of the model height)) into defects numbered from the top down, and writes one issue per defect: a mesh sighting at the group's medoid (local frame) and an image sighting (box) per detection. Photos without a position cannot place detections and are reported; photos without a lens get the kit's 70 degree field of view (`hfovDeg`).

`issues.json` is merged, never replaced: every issue already there stays. The map remembers the issues the pipeline wrote; a later run updates such an issue only while it is exactly as the pipeline left it (same hash), keeps its id, code and creation time, and leaves it alone once a person changed it. Issues no detection backs any more stay for review. The previous file is kept as `issues.json.bak`. When the job finishes, an open project takes the merged issues from disk and keeps edits made in the app meanwhile.

## 12. Generated reports and their text

The house-format project report (`house-pdf`, BLD-8) is printed from `apps/desktop/src/renderer/house.html` in an offscreen window: the page lays out fixed A4 page frames itself (cover, contents, executive summary, scope and method, site and data, statistics, findings register, one page per issue, appendices, back page), then main prints it with no margins. It reads `manifest.json`, `issues.json`, `thumbnail.jpg`, `volumes.json` and `edits/boundaries.json` (volumetric), `road.json` (road) and `report/narrative.json`, all optional except the first two. It carries the person's branding (section 2), never a client brand. `Settings.reportContents` chooses the sections and which issues get a page (`all` graded issues by default; `above-lowest` lists the lowest level in the register only, as the delivered facade reports do; uncertain items are always listed in an appendix).

```
<project>/report/
  narrative.json        aio.narrative/1: every saved version of the report text
  narrative.json.bak    the previous file
```

- `parts.summary`, `parts.method` and `parts.findings` hold `versions`, newest last; the report prints the newest version of each part, or a text filled from the statistics when none was saved. Restoring an old version saves it again as the newest; nothing is deleted (at most 50 versions per part are kept).
- `source` says where a version came from: `ai` (with `provider` and `model`), `template` (cloud AI off: statistics filled in, judgement left as `[bracketed]` prompts the report highlights) or `user`.
- Written only through IPC `report:writeNarrative` (atomic replace with `.bak`); a `.aio` package carries the file and the app reads it in place, read only.
- The AI draft sends the project statistics only (counts, labels, dates, severity scale, volumes and PCI figures; no photos, positions or notes) on the `report` route with `ai:draftText`, after the AI-6 preview of the exact instructions and request.

## 13. Layers of a capture (comparing dates)

The split compares two survey dates (two 3D views, maps or orthos, one capture each) in any project whose manifest lists two or more `captures` with layers of their own. Which layer shows which capture (`@aio/workspace` `captureIndex`, no schema change):

1. Explicit lists first: volumetric projects take `volumes.json` `captures[].layers` (or the survey layers of section 10), keyed by `captureId`.
2. Else a mesh, point cloud, raster, photo, panorama, video or vector layer belongs to the one capture whose id, or whose date, its id or name carries as a whole token (`2020-12-31`, `20201231`, `31 Dec 2020`, `December 31, 2020`, ...), or (meshes) whose survey key ends every tagged node (`P01_e1`).
3. A layer that names no capture, or several, is common to every date (site models, plans, basemaps, legacy viewers).

Layers of different dates whose names differ only by the date are counterparts (`Terrain 31 Dec 2020` and `Terrain 10 Jan 2021`): the view of one date shows its own counterpart where the layer tree shows any of them, a component selected on one date is outlined on the other (`P05_e2` on 10 Jan is `P05_e1` on 31 Dec), and the ortho pane keeps the same raster across dates. Builders that name layers by capture date (as `volumetric.build` does) get the comparison for free.

An explicit `capture` on a layer (M8, `Layer.capture`) wins over rules 1 to 3: the layer belongs to that capture whatever its name says. The builder's import step and the layer menu ("Belongs to date...") set it through `builder:updateLayers` with `{ capture }` (`null` clears it).

## 14. Change sets (comparing dates, M8)

Change between two captures is written as change sets: one file per date pair and producer (schema in `@aio/schema` `change.ts`; the pipeline writer is `python/src/aio_pipelines/change/changeset.py`, which round-trips the shared fixtures in `packages/schema/src/__fixtures__/change/`).

```
<project>/
  change/<id>.json            aio.change/1, e.g. c1-c2-issues.json (in-app), c1-c2-raster.json (change.raster)
  change/<id>.json.bak        the previous file, kept on every write
  change/<id>/                derived files of a pipeline run: heat map pyramid, polygons GeoJSON, COPC, GLB
```

- `from` and `to` are capture ids (earlier, later). `producer` is `issues`, `detections` or `vectors` for the in-app comparisons, or the pipeline name.
- `items[]` is a union by `kind` (`issue`, `detection`, `vector`, `region`, `component`, `frame`). Each kind allows its own verdicts (`CHANGE_VERDICTS`): issues `new`, `resolved`, `not-seen`, `grown`, `shrunk`, `worsened`, `improved`, `unchanged`; regions `added`, `removed`, `changed`, `cut`, `fill`; and so on.
- Item ids are chosen by the producer and stay the same when the pair is computed again (`issue:F01`, `region:0007`), so `review` (`open`, `confirmed`, `dismissed`, `by`, `at`, `note?`, `issueId?`) is carried over by id on a recompute.
- Every item is a proposal. "Resolved" never closes an issue: a person confirms, then the issue gets `status: 'closed'` and `resolvedIn: <to>` (founder decision 3). `not-seen` is used whenever the later date did not look at the place.
- `registration` says how well the dates line up (`shiftPx`, `shiftM`, tolerance). Raster, cloud and mesh comparisons refuse to run beyond the tolerance (default 2 px or 5 cm, `ChangeThresholds`).
- Layers written by a run carry `derived: { kind: 'change', from, to, changeId, runId, source }` and the later date's `capture`; the set lists them in `layers`.
- Packages carry `change/` read-only; player mode never starts a comparison.

## 15. Procedural models (BLD-11, M8)

Models made from drawings, point cloud fits, the agent or by hand (schema in `@aio/schema` `procmodel.ts`):

```
<project>/
  models/<id>.procmodel.json  aio.procmodel/1: parts (extrusion, cylinder, box, pipe, sphere), each draft, accepted or rejected
  models/<id>.glb             built from the accepted parts by the TypeScript mesher, one node per part
  models/draft-<id>.glb       preview of every part, shown as a draft layer (derived.draft), left out of reports
  drawings/<stem>.dxf                    DXF plans copied in by drawing.import (DWG is not supported)
  drawings/<stem>/plan.png               the drawing drawn as a plan raster (layer plan-<stem>)
  drawings/<stem>/parts.procmodel.json   aio.procmodel/1: candidate parts found in the drawing (drafts)
  drawings/<stem>/placement.json         aio.drawingplacement/1: where the drawing lies in the local frame
```

- `placement.json` (`aio.drawingplacement/1`, read by `@aio/modelling` `parsePlacement`): `file` (the DXF), `units` and `unitM` (metres per drawing unit), `matrix` `[a, b, tx, c, d, tz]` so a drawing point `(dx, dy)` lies at `x = a*dx + b*dy + tx`, `z = c*dx + d*dy + tz`, at height `baseY`; optional `rmsM` (control point fit), `control` (the points used) and `provisional` (placed without control points). The Model builder's "Place the drawing" rewrites it; the pipeline writes the first one.
- Layer ids are stable so a second import or build replaces rather than adds: `plan-<stem>` (the plan raster), `drawing-<stem>-<layer>` (one vector layer per DXF layer, its name slugged), `model-<id>` (the built model) and `model-draft-<id>` (the draft preview, `derived.draft`).

- Coordinates are the project local frame in metres (x east, y up, z south); extrusion footprints are `[x, z]` pairs with a `baseY` and a `height`; cylinders stand on their `base` centre with a vertical axis.
- `origin` says where a part came from: `fit` (`residualM`, `inliers`, `inlierShare?`), `drawing` (`file`, `layer`, `entity`), `agent` or `manual`.
- The GLB node of a part is named by its `tag`, else its `name`, else its `id` (`@aio/modelling` `partNodeName`), so issues, tags and part matching across dates (section 13) work on built models.
- The built mesh layer carries `derived: { kind: 'model', source: [<model id>] }` and the model's `capture`.
- The manifest flag `aiCloudDrawings` (default off) is the project policy for sending plan images and drawings to a cloud model from the model builder (founder decision 5).

## 16. Detector models (BLD-10, M8)

Local detection runs ONNX models with onnxruntime-node in an Electron utility process. No detector ships with the app; a person imports one (schema in `@aio/schema` `inference.ts`):

```
<userData>/models/detect/<id>/
  model.onnx                  the network
  model.json                  aio.detector/1 model card: name, version, layout, input, classes, licence (SPDX), source, sha256
<project>/
  detections/model-<run>.json aio.detections/1 pass, source "model", status "draft", origin { model, runId }, run
```

- `layout` is one of `yolo-v8`, `yolo-v5`, `detr`, `ssd`, `generic`; `input` gives the size, tensor order (`nchw` default), colour order and normalisation.
- Import checks the SHA-256, probes the layout with one dummy inference and asks the person to acknowledge the licence. Models without a card or with a licence not allowed in customer builds are refused (no AGPL exports such as Ultralytics weights without an Enterprise licence).
- `Settings.inference.modelsDir` moves the folder; empty means userData.
- Results are drafts in the existing review (section 11): nothing counts until a person accepts it.
- A run writes one pass per photos layer, each with its `layer`: `model-<run>.json` for a run over one layer, `model-<run>-<layer>.json` each for a run over several (photo ids repeat across the dates of a project).

## 17. Journal and audit trail (M9)

Every change to a folder project is an op in a signed, hash-chained, per-device journal (schema in `@aio/schema` `journal.ts` and `identity.ts`; code in `@aio/journal`; the writer is the journal service, `apps/desktop/src/main/journal.ts`; ADR 0005). Older builds ignore every path below; `team.json` exists only for shared projects (section 19).

```
<project>/
  journal/devices/<deviceId>.json          aio.device/1: public key, actor, name, initials, app, certs; self-signed
  journal/ops/<chainId>/000001.jsonl       aio.op/1, one op per line; a new segment at 4 MB or 10,000 ops
  journal/checkpoints/<ms>.<counter>.<chainId>.json   aio.checkpoint/1: heads of every chain, count, Merkle root; signed
<userData>/
  identity.json                            aio.identity/1: actor, name, initials, email?, createdAt, migratedFrom?
  team/projects.json                       aio.team-config/1: per project folder: replica id, sync mode, team project,
                                           hub path, server, fetch policies, peer heads, journal on or off, last sync
  team/servers.json                        aio.team-servers/1: enrolled team servers (section 19)
  journal-cache/<key>/                     one folder per project, shared by the journal, sync and binaries;
                                           rebuildable, never the truth
    meta.json                              aio.journal-cache/1: root, replica id, journal on or off, SHA-256 of each
                                           journaled file as last seen
    snapshot/<path>                        the text of each journaled file as last seen (what a write is diffed against)
    pending.json                           a write in flight: the file, its hash before, the content after, the op ids
    sync.json                              held ops, imported exchange ids, hub heads (section 19)
    blobs.json                             aio.blob-cache/1: hash cache and registered blobs (section 20)
  profiles/<name>/                         the whole userData of a `--profile=<name>` run, same layout
```

- **One writer.** The journal service in main is the only writer of `journal/`. Identity, the review workflow, the Conflicts inbox, sync, exchange files and binaries append through it; ops from other copies go in through its `ingest`, each to its own chain folder (never this device's chain); merged state files are written through it in the same step, so no save falls between an append and a merged write. The renderer and the pipelines never write `journal/`. The renderer reloads its records on the event `journal:changed` (`{ projectId, records }`).
- **Ids.** Actor `a_` plus 26 base32 letters (128 random bits), permanent. Device `d_` plus the base32 SHA-256 of the raw Ed25519 public key (52 letters). Replica `r_` plus 16 letters (80 random bits), one per project folder path, kept in userData `team/projects.json` (`ProjectTeamConfig.replicaId`), so a copied or moved folder starts a new chain instead of forking one. Chain `<deviceId>.<replicaId>`. Base32 is RFC 4648, lower case, no padding (safe as Windows file names). `journal-cache/<key>`: the first 16 hex digits of the SHA-256 of the project root (forward slashes, no trailing slash, lower case on Windows and macOS; `projectCacheKey`).
- **Device key.** One Ed25519 key per profile, made with `node:crypto` on first need. The private key (PKCS#8) lives only in the OS vault: account `device-signing`, service `<appId>`, `<appId>.isolated` for runs with `QUADRION_USER_DATA`, plus `.profile.<name>` for `--profile=<name>`. Automated runs that set `QUADRION_TEST_VAULT=1` on an isolated profile keep it in `TEST-ONLY-vault.json` in their throwaway userData instead. `--profile=<name>` (a letter or digit, then letters, digits, `-` and `_`, up to 40) keeps userData in `<userData>/profiles/<name>`. When the vault fails, the key lasts for that run only and ops are written without `sig`. Renderer code never signs; main stamps every op.
- **Clock.** `hlc` is `<ms 13 digits>.<counter 4 digits>.<deviceId>`; readings compare as strings. A device's clock never goes back; past counter 9999 it moves on by a millisecond. Last-writer decisions use it, never wall time alone. A remote reading more than 5 minutes ahead raises a notice (`sync:notice`); more than 24 hours ahead puts the op in quarantine (section 18).
- **Op fields.** `v` (1), `id`, `chain`, `dev`, `act`, `seq` (from 1), `hlc`, `prev` (id of `seq - 1`, null only for seq 1; the first op of a segment links to the last op of the previous one), `deps?` (heads of the other chains this device had seen), `kind`, `target` (`{ rec, id, in? }`), `base?` (content hash of the record before), `ph`, `payload?`, `via?` (exactly one of `agent`, `pipeline`, `import` or `external`), `label?` (the editor's command label, such as "F01 to reviewed"), `sig?`. `chain` must start with `dev`, and `hlc` must end with it.
- **Hashes.** SHA-256, lower-case hex, over RFC 8785 canonical JSON (JCS). `ph` = hash of the payload. `id` = hash of the op without `id`, `payload` and `sig` (so it covers `ph`). Verification works on the raw parsed JSON of each line, never on a parser's output; op schemas keep unknown keys so a newer op still hashes the same in an older reader.
- **Signatures.** Ed25519 through `node:crypto` over the UTF-8 text `<domain>\n<hash>`, base64url without padding (86 characters); keys are raw 32-byte public keys in base64url (43). Domains: `aio.op/1` (over `id`), `aio.checkpoint/1` (over the checkpoint `id`), `aio.device/1` and `aio.cert/1` (over the hash of the record without `sig`), `aio.idcard/1`, `aio.exchange/1`, `aio.receipt/1`, `aio.request/1`. An op without `sig` is "unsigned": still chained, and Verify says so.
- **Kinds.** Issues `issue.create|patch|delete|restore|sighting.add|sighting.remove|status|merge|recode`; collaboration (section 18); other records `change.review`, `detection.review`, `procmodel.part`, `manifest.entry`, `boundary.edit`, `narrative.version`; `blob.add` (section 20); team `member.add|role|remove|link`, `device.revoke`, `policy.set`, `project.share`; events `package.export`, `exchange.import`, `conflict.resolve`, `record.external`, `checkpoint`; the journal `journal.off|on`, `op.redact`. Readers accept any dotted lower-case kind and record kind: an unknown one is kept, verified and shown as "Unknown change". `OP_PAYLOADS` and `OP_PERMISSION` give each known kind its payload schema and the permission it needs.
- **Targets and payloads.** Issues `{ rec: 'issue', id }`; `issue.create`, `issue.restore`, `boundary.edit` and `narrative.version` carry `{ record }`; `issue.patch`, `change.review`, `detection.review`, `procmodel.part` and `manifest.entry` carry `{ set?, unset?, was? }` per field (`was`: the values before, for History only; merging never reads it); sightings `{ hash, sighting }` with `hash` = `contentHash(sighting)`. Change items `{ rec: 'change-item', id, in: <change set id> }`; detections `{ rec: 'detection', id, in: <pass file> }`, or `{ rec: 'detection-pass', id: <pass file> }` for a pass without ids; model parts `{ rec: 'part', id, in: <model id> }`; layers `{ rec: 'manifest', id: <layer id>, in: 'layers' }`, other manifest fields `{ rec: 'manifest', id: 'project' }`; boundaries `{ rec: 'boundary', id }`; narrative `{ rec: 'narrative', id: <part> }`; blobs `{ rec: 'blob', id: <sha256> }`; members `{ rec: 'member', id: <actor> }`; devices `{ rec: 'device', id }`; the policy `{ rec: 'policy', id: 'team' }`; sharing `{ rec: 'project', id: <teamProjectId> }`; an imported exchange file `{ rec: 'file', id: <exchange id> }`.
- **Writes.** The journaled files are `issues.json`, `change/*.json`, `detections/*.json`, `models/*.procmodel.json`, `edits/boundaries.json`, `report/narrative.json` and `manifest.json`. A write through `project:writeIssues`, `change:write`, `detections:write`, `model:write`, `project:writeBoundaries` or `report:writeNarrative` is diffed against the snapshot; the ops are appended and fsynced (the open segment stays open between appends: one write and one sync each), `pending.json` names them, then the state file is written (`writeJsonAtomic`). `builder:updateLayers` is diffed after its write. A write the handler refuses is undone by new ops labelled "Not saved, change undone": the history is never rewritten. Issue ops carry the editor's labels (`project:writeIssues` `commands`).
- **Crash recovery and outside changes.** On open, a `pending.json` whose ops are all in the journal, and whose file still has the hash from before, is finished: the state file is written. Any other difference from the snapshot (an older build, a hand edit, a pipeline outside a job) becomes ops with `via.external` (`found: 'open'`), shown as "Changed outside Quadrion AI"; a file of unknown shape becomes one `record.external` op (`{ file, before, after, patch? }`). Around a pipeline job the journaled files are compared before and after; the difference becomes ops with `via.pipeline` (`name`, `jobId`, `packVersion`), signed by the device of the person who started the job. The inspection and road pipelines keep unknown top-level keys of `issues.json`. Packages are read-only: their journal is read, never appended.
- **Redaction.** An owner's `op.redact` (`{ op, chain, seq, reason? }`), or `comment.redact` with its `ops`, names the ops whose payload is removed from every copy; `ph` stays, so the chain still verifies, and the audit shows "Redacted by X on date". A payload missing without such an op is a Verify problem.
- **Verify** names each problem with file and line (`VerifyCode`): `parse`, `hash-mismatch` (an edited line), `payload-hash` (an edited payload), `payload-missing`, `chain-gap` (a removed line), `order`, `truncated` (a tail cut off that `deps` or a checkpoint references), `segment-missing`, `fork` (two ops with one chain and seq: a copied folder kept writing), `bad-signature`, `unsigned`, `unknown-device`, `revoked-device`, `checkpoint-mismatch`, `clock-ahead`. The report (`VerifyReport`) also counts signed, unsigned, external, quarantined and redacted entries. The project still opens and works.
- **Checkpoints** every 500 ops of a chain and at every audit export (`checkpointNow`): the heads of every chain, the op count and a Merkle root (leaf SHA-256 of `<chain> <seq> <id>`, heads sorted by chain, node SHA-256 of the two child hex strings concatenated, an odd node carried up). The checkpoint `id` is the hash of the checkpoint without `id` and `sig`; a `checkpoint` op (`{ file, root, count }`) records it in the chain. The file name drops the device from the clock reading to keep deep project paths under Windows limits.
- **Decision 8.** The journal is on for every folder project (`JournalPolicy` defaults); a private project may switch it off with a recorded `journal.off`, a team project may not. The switch is kept in `meta.json` and `ProjectTeamConfig.journal`.
- **Golden fixtures** in `packages/schema/src/__fixtures__/journal/` (`pnpm fixtures:journal`, deterministic): `valid/` (three fictional devices with TEST-ONLY keys in `TEST-ONLY-KEYS.json`), `tampered/<case>/` and `cases.json` (the problem Verify must name for each case). Prettier never touches them.
- **Exports.** `audit-csv` (UTF-8 with BOM, CRLF lines, cells that would start a formula made safe) and `audit-json` (`aio.audit/1`, `AuditFile`: app, project, export time, filter, head, the Verify report, the entries and the text of every file in `journal/`, checked with no app by `tools/audit-verify/verify.mjs`) fall under the package export kind `files`, checked by format (their names would read as issue exports). The house report has an `audit` section, and every generated report prints the audit head in its footer: "Audit head <first 16 hex digits of the root>, N entries, verified".

## 18. Collaboration ops, members and projections (M9)

Assignments, comments, approvals, members and sign-offs exist only as journal ops and their projection (`@aio/schema` `collab.ts` and `identity.ts`, `@aio/collab`, `@aio/journal` `members.ts`, `@aio/merge`). M9 adds no field to `Issue` (an 0.8 build strips unknown keys on save), nor to `ChangeReview`, `Detection`, `BoundaryEdit`, `ProcPart` or `NarrativeFile` (strict: an 0.8 build would refuse the file); a test pins their 0.8 keys. The free-text author fields keep receiving the display name.

- **Targets** (`CollabTarget`, `{ kind, id, in? }`): `issue`, `change-item` (`in`: change set id), `change-set`, `detection-pass`, `part` (`in`: model id), `model`, `report`, `project` (`report` and `project` use the project id). The op's `target` is the same record (`rec` = `kind`).
- **Comments** (`comment.add|edit|delete|redact`): id `cm_` plus 16 base32 letters, markdown-lite text up to 10,000 characters (links shown as text, never fetched; RTL and Arabic allowed), `visibility` `team` (default) or `client`, `mentions` (actor ids, up to 50), optional saved view (camera, time, capture, layer), `replyTo`. Edits are new versions by the author only; a delete is a tombstone, by the author or an owner; `comment.redact` (owner) names the `comment.add` and `comment.edit` ops whose payloads go.
- **Assignment** (`assign.set`): target, assignee (null clears), optional due date and note. Last writer wins; two different concurrent assignees are a conflict.
- **Approvals** (`approval.add|withdraw`): id `ap_` plus 16 letters, `decision` `approve`, `changes-requested` (a comment is required) or `accept` (a client's acceptance: recorded, never a status change), `contentHash` (the SHA-256 of the target's material view when signed), optional `comment`. Withdrawn by the same person only. An approval through the agent (`via.agent`) is refused by main and quarantined on every other copy.
- **Policy** (`policy.set`, owner only; `TeamPolicy`; the payload carries only the fields that change): `approval` (`required` 1 to 5, default 1; `fourEyes` default on; `closeBy` `owner` (default) or `owner-or-reviewer`; `viewersMayComment` default off; `clientAcceptance` `record` (default) or `off`; `materialFields` default class, severity, sightings, measurements, status), `minVerification` (default `self`), `packageHistory` (default `summary`). A project that is not shared has no policy and keeps 0.8's free status stepping; approvals there are refused ("Approvals need a shared project. Use the status buttons instead.").
- **Status.** The material view of an issue holds the `materialFields` (class with severity model, severity, sightings, measurements, and the status by phase: `draft`, or `reviewed`, `approved` and `closed` as one, so approving and closing never void an approval; going back to draft does). `approved` is reached when `required` current approvals exist from distinct owners or reviewers; with four-eyes neither the issue's creator nor the last person who changed it materially counts. The approver's copy writes the `issue.status` op. A material edit after approval makes the approvals out of date and the status returns to `reviewed`, with an op. After a merge, approvals completed on two copies, or voided by a merged edit, set the status (`issue.status` ops in the merge step). Under a team policy the issue editor's **Approve** status button is hidden: approval goes through the approvals. Batch sign-offs use the same approvals on a change set, a detection pass, a model or the report (bound to the hash of the report's inputs).
- **Members and devices** (owner only): `member.add` (`{ actor, name, initials, email?, role, devices: [{ id, key }], cert? }`), `member.role` (`{ actor, role }`), `member.remove` (`{ actor }`), `device.revoke` (`{ device, reason? }`), `member.link` (M10, schema only). Sharing makes the sharer the first owner: `project.share`, then their own signed `member.add` as owner (in a project with no members, that is the only team op accepted). A person joins in file mode from an identity card (`.aioid`, `aio.idcard/1`: actor, name, initials, email?, device id and key, app; self-signed); with **Certify** the owner's device signs a `DeviceCert` (`aio.cert/1`, level `owner`) carried in the payload. The last owner cannot be removed. People a team server grants (`Member.source: 'server'`) are added as members by an owner's copy at sync. `replayTeam` replays the team ops in clock order (ties by op id), so every copy with the same ops has the same members.
- **Initials** (`Initials`: 1 to 3 letters of any script and an optional digit): the first letters of the first and last words of the name (the Arabic article "ال" skipped), two letters of a single name, made unique in a team with a digit 2 to 9. Issue chips and the register show them; tooltips show the name. Badges: `self` "Unverified", `owner` "Owner-certified" ("Certified by you" for your own certificates), `server` "Server-enrolled", `account` (M10).
- **Roles** (`Role`, `PERMISSIONS`, `OP_PERMISSION`, `permissionFor`): owner (everything), reviewer (edit, assign, approve, builder edits except the coordinate system, origin and datum, team and client comments), viewer (read, export and verify the audit; team comments with `viewersMayComment`), client (client-visible comments and acceptance only). The payload refines the kind: a manifest change of `crs`, `origin` or `verticalDatum` needs `builder.georef` (owner); a step between `approved` and `closed` needs `close-approved` (owner, or reviewer with `closeBy: owner-or-reviewer`); a client-visible comment needs `comment.client`; an acceptance needs `accept`; a kind from a newer version needs `edit`. One function, `canApply`, decides for the desktop and the team server.
- **Quarantine.** In a shared project an op is kept but not applied (`QuarantineEntry`, `sync:quarantine`, `RefusalCode`) when it comes from a device that is not in the team, or claims another person; from a removed member; from a revoked device after the revocation's clock reading (earlier ops stay valid); when it was edited, is unsigned or its signature does not match; when it goes beyond its author's role at its clock reading, or the author is below `minVerification`; when it edits another person's comment, deletes one (unless by an owner) or withdraws another person's approval; when it is an approval through the agent; or when its clock is more than 24 hours ahead. An owner can apply one anyway: **Apply anyway** writes `conflict.resolve` with `{ conflict: 'quarantine:<op id>', choice: 'theirs' }`. In exchange and hub mode roles are tamper-evident, not enforced: anyone with write access to the folder can still edit files (seen as "Changed outside Quadrion AI"). The team server refuses the same ops with 403.
- **Merge** (`@aio/merge`, decision 7; pure, run by main on every sync and import). Ops are deduped by id and ordered by clock then id; ops whose `prev` or `deps` are missing are held, never applied. Issue fields: last writer by clock (`classId` and `severityModelId` together; `updatedAt` quietly); sightings: an add-wins set by content hash; delete or merge against a concurrent edit keeps the issue; equal codes: the issue made later takes the next free code (`issue.recode`, with a notice). Change items, detections (per reviewed field, or the whole pass for passes without ids), model parts (per part field) and boundary edits (per pile and date): last writer wins. Narrative versions, comments and approvals grow only. Manifest entries are projected but not yet written back to `manifest.json`. State files are written byte for byte as today's writers make them, with no new field. Any two copies that hold the same ops write the same files.
- **Conflicts** (`Conflict`: `id`, `target`, `field`, `ours` and `theirs` with value, person, clock reading and op, `kind` `value`, `delete-edit`, `status`, `code` or `merge`, and `current`, the side in the files now). A choice is a `conflict.resolve` op (`{ conflict, choice: 'ours' | 'theirs' | 'restore', value? }`), followed by the write that puts the chosen value in place when it is not already there. **Edit** in the inbox is recorded as `restore` with the typed value (`sync:resolve` choice `edit`). The losing value stays in the history.
- **Projection** (`CollabState`, `collab:read`; `members:list`; `sync:conflicts`) is rebuilt from the journal; it is never stored as truth.

## 19. Exchange files and hub folders (M9)

Moving ops and blobs between copies with no server (`@aio/schema` `exchange.ts` and `sync.ts`, `@aio/sync` `exchange` and `hub`, main `sync/`). Transport settings are per machine (drive letters and server addresses differ), so they live in userData `team/projects.json`, never in the project.

```
<project>/team.json                aio.team/1: teamProjectId (t_ + 26 base32), name, createdAt, createdBy (shared projects only)
<name>.aiosync                     a store-mode ZIP under 2 GB, or that ZIP inside an aio.exchange-enc/1 envelope
  aio-exchange.json                aio.exchange/1 header, the first member, signed by the sender's device
  journal/devices/<deviceId>.json  aio.device/1 of the sender and of every device whose ops are carried
  journal/ops/<chainId>/<from>-<to>.jsonl   one run per chain, six-digit seqs, inclusive
  blobs/<aa>/<sha256>              bundles only
<name>.aioid                       aio.idcard/1 identity card, self-signed (section 18)
<hub>/aio-hub.json                 aio.hub/1: hub id (h_ + 16 base32), createdAt, projects (a convenience list)
  projects/<teamProjectId>/team.json                 aio.team/1 copy (HUB_PATHS.team), written once
  projects/<teamProjectId>/devices/<deviceId>.json   aio.device/1, replaced only by that device
  projects/<teamProjectId>/ops/<chainId>/<from>-<to>.jsonl   at most 2,000 ops per file, written once
  projects/<teamProjectId>/blobs/<aa>/<sha256>       written once
  projects/<teamProjectId>/presence/<deviceId>.json  aio.presence/1 heartbeat, replaced by that device
<userData>/team/servers.json       aio.team-servers/1: enrolled servers (address, fingerprint, this device's certificate)
<userData>/journal-cache/<key>/sync.json   held ops, imported exchange ids, hub heads, last reachability (rebuildable)
```

- **Modes** (`SyncMode`): `off`, `exchange`, `hub`, `server`. `HostingModel` defaults: every mode offered, the server as `preview`, no hosted service.
- **Sharing** (`team:share`): a new `team.json`, a `project.share` op and the sharer's `member.add` as owner (section 18), then this device's record in `journal/devices/`. Exchange mode stops there; hub mode makes the folder a hub if it is not one (`aio-hub.json`, the team project's `team.json` copy) and syncs; server mode syncs once and must succeed. A copy without `team.json` joins by importing an exchange file of the team project: the import writes `team.json` from the header and the ops. `team:share` with a `teamProjectId` and a hub path joins a team project the hub already holds. `team:leave` ("Stop syncing this copy") sets the mode to `off`; the data and its history stay.
- **The archive.** A strict store-mode ZIP with classic 32-bit records (never ZIP64; not the `.aio` package writer, no WinZip AES), UTF-8 names, written through `<out>.partial` and renamed when complete. Each blob is hashed on the way and must still have the hash it was registered with. Files over `EXCHANGE_MAX_BYTES` (2 GiB) are refused before anything is written: send a patch and move large files through a hub or a USB copy of the project. The reader trusts nothing and refuses, each with an exact message (`ExchangeError`: `not-exchange`, `damaged`, `hostile`, `too-large`, `needs-passphrase`, `passphrase`, `signature`, `schema`, `wrong-project`): ZIP64 records, several disks, more than 200,000 members, a member name outside the layout above (`isSafeMemberName`: `..`, empty or `.` segments, absolute paths, drive letters, backslashes, NUL), links, duplicates, compressed or encrypted members, a local name that differs from the central one, members that overlap, point outside the file or declare more bytes than it holds.
- **Header** (`ExchangeHeader`, kept with unknown keys): `schema`, `id` (`x_` plus 16 letters; a second import says "Already applied. Nothing in this file is new."), `kind`, `teamProjectId`, `createdAt`, `from` (actor, device, name, app), `to?` (advisory), `since` (`{ heads }`, `{ date }` or `{ all: true }`), `chains` (per chain: `from`, `to`, member), `heads` (the sender's after these ops), `blobs` (sha256 and size), `counts` (ops, devices, blobs, bytes), `package?` (a reply: the package it answers), `encrypted`, `sig`. The signature is Ed25519 with domain `aio.exchange/1` over the hash of the canonical header without `sig`, checked on the raw JSON. A device record counts only when its id is the hash of its key and it is self-signed.
- **Kinds.** `patch` (ops since the heads last sent to that peer, all ops, or since a date), `bundle` (plus the blobs the ops register), `reply` (a client's comments and acceptance from a customer package; the format exists, the free player does not write it yet).
- **Envelope** (decision 9, `aio.exchange-enc/1`): with a passphrase (at least 8 characters) the whole archive is encrypted, so nothing but the size shows from outside. The file starts with one JSON line, at most 1 KB: `{ schema, kdf: 'scrypt', cipher: 'aes-256-gcm', N, r, p, salt, nonce, chunk }` (defaults N 2^17, r 8, p 1, about 128 MB of memory; a 16-byte salt and a 7-byte nonce prefix in base64url; 1 MiB chunks). The key is 32 bytes of scrypt over the passphrase in Unicode NFC. Then each chunk: its AES-256-GCM ciphertext and a 16-byte tag. Chunk nonce: the 7-byte prefix, the chunk number (4 bytes, big endian), then 1 on the last chunk and 0 before (the STREAM construction, so a cut, reordered or extended file is refused). The header line, newline included, is the additional data of every chunk. The plain archive exists only as a temporary `<out>.plain` while exporting.
- **Import** previews first (`exchange:preview`, `ExchangePreview`: the signature `valid`, `invalid`, `unknown-device` or `revoked-device`, the sender and whether they are a member, ops by kind, new and already-held ops, held ops, expected conflicts, blobs and their size, problems), then `exchange:import` applies atomically and idempotently: ops dedupe by id, are appended to their own chains through the journal service and merged (section 18), blobs go to the project, and an `exchange.import` op is recorded. Ops after a gap are held in `sync.json` ("Some changes wait for earlier ones from <device> (up to #N). Import those first."); a fork is refused. A file for another team project is refused. Double-clicking a `.aiosync` opens the import dialog.
- **Hubs** (`createHubTransport`). Each device writes only its own files. Op chunks and blobs never change once written: a temp name (`.<name>.<device>.<random>.tmp`), then a rename, and an existing file is left alone. So no lock is needed, a share that drops mid-write leaves only a temp file nobody reads (the device sweeps its own after an hour), and cloud-drive clients never see two writers of one file; copies they make anyway ("conflicted copy", "(1)") are read like chunks, deduped by op id, and reported. Device records and presence files are replaced only by their own device. `aio-hub.json`'s project list is a convenience: two devices adding at once may drop an entry, and projects are also found by their folders. Every file call has a 20 s timeout; a slower share counts as unreachable, and local work goes on ("Folder offline").
- **Presence** (`aio.presence/1`: device, actor, name, initials, time, clock reading?, the target open?) is a heartbeat, advisory only, ignored after 2 minutes (`PRESENCE_TTL_MS`); `TeamStatus.online` lists the people seen.
- **When it syncs.** **Sync now**; once when a hub or server mode starts; then, with automatic sync on (`Settings.team.autoSync`, the share dialog's "Sync automatically every 15 minutes"), every `Settings.team.intervalMin` minutes (default 15) and when the window gets focus (at most once a minute). Hub sync makes no network connection beyond the file share.
- **Packages.** `PackageHeader.reply?` (`{ teamProjectId, ownerKey, comments, acceptance }`) and `journal?` (`full` or `summary`) are in the contract; an 0.8 player strips both. Customer packages with the signed audit summary, "Include full history" and replies are not written yet.
- **Folders opened in place** (any project, shared or not; `apps/desktop/src/main/fsutil.ts`): compare-before-write. The record writers (issues, change sets, detections, models, boundaries, narrative) remember the size, modification time and SHA-256 of what this process last read or wrote (`SeenFiles`) and check before they rename: a different size is a change, the same size and exact time is none, anything else is decided by the hash (FAT and some shares keep whole seconds). A changed file refuses the write and nothing is written: "issues.json was changed by someone else since you opened it. Reload to see their changes; your edit was not saved." The renderer shows **Not saved** with **Reload**. It is a check, then a rename: there is no lease file and no merge on the spot, and a tiny window between the two remains. The `.bak` is copied to a temp file and renamed, so a crash leaves either the old or the new `.bak`.
- **Team server** (`aio.sync/1`, preview; `apps/team-server`, `@aio/sync/http`, main `teamServer.ts`; admin guide `docs/server/README.md`): the same ops and blobs over HTTPS (`SYNC_ROUTES`: `GET /v1/health`, `POST /v1/enrol`, `GET /v1/projects/:id/heads`, `POST` and `GET /v1/projects/:id/ops`, `GET /v1/projects/:id/members`, `HEAD`, `GET` with Range and `PUT` on `/v1/blobs/:sha256`). Every request is signed by the device key (RFC 9421, `ed25519`, covering `@method`, `@target-uri`, `content-digest`, `x-aio-device`, `x-aio-nonce`; domain `aio.request/1`); there are no bearer tokens. Enrolment takes a one-time invite code (7 days by default) and the device record, and returns the server's id, name, version, certificate fingerprint (pinned) and a `DeviceCert` (level `server`). The server checks chain, signature and role on every op, refuses with 403 and the refusal per op (`PushResult.refused`), stores, and countersigns accepted ops with receipts (`aio.receipt/1`, a hash chain of its own). It never merges. TLS is required except on loopback; the app never contacts a server with the offline-only setting on. Settings, Data folder, Team server enrols (`server:enrol`, `server:list`, `server:forget`, `server:check`).

## 20. Binaries by content (M9)

Large files are known by their SHA-256 so a copy can open before they arrive (`@aio/schema` `blobs.ts`, `@aio/sync/blobs`, main `blobs.ts`).

- **Registration.** Every file a layer reads (sources, posters, flight logs, photos and panoramas; basemaps and legacy viewers are left out) is registered once by a `blob.add` op: target `{ rec: 'blob', id: <sha256> }`, payload `{ sha256, size, path, role: source | derived, layer? }`. `path` stays the project-relative path layers use; an `AssetRef` `{ hash }` lives at `assets/sha256/<hash>`. Indexing (`blobs:index`) runs when a project is shared and on request, hashing in the background at up to 100 MB/s so playback stays smooth; hashes are cached by path, size, modification time and inode in `journal-cache/<key>/blobs.json` (`aio.blob-cache/1`). A project that is never shared is never hashed unless asked, and nothing in it is moved or renamed.
- **Fetch policy per layer and machine** (`FetchPolicy`). `always` copies on open and at every sync, `on-open` when the project opens, `on-demand` only on **Download**, `stream` never copies (it reads from the hub folder through `aio://`). Defaults (`defaultFetchPolicy`): any file over 200 MB `on-demand`; raster, vector and basemap layers `always`; photos and panoramas `on-open`; other kinds `on-demand` over 50 MB, else `always`. A person's choice per layer is kept in userData `blobs/policies.json` (by project cache key) and wins over `ProjectTeamConfig.fetch`.
- **Missing is a normal state** (`BlobState`: `present`, `missing`, `partial`, `stale`, `streaming`). For a project file that is not in the folder, `aio://` serves the downloaded copy, a stream from the hub when the policy is `stream`, or a 404 with the header `x-aio-blob: missing <sha256> <size>` (exposed to the page through `Access-Control-Expose-Headers`). The layer shows "Not on this computer (12.4 GB)" with **Download**.
- **Where blobs live.** `blobs/<aa>/<sha256>` (`blobPath`) in a hub (`projects/<teamProjectId>/blobs/`), an exchange bundle and a server store. On this computer, in userData `blobs/`: `<aa>/<sha256>` (verified copies), `partial/<sha256>.part` (kept to resume), `quarantine/<sha256>.<time>` (files that failed their hash), `verified.json` (verification stamps) and `policies.json`. Equal files of several layers or projects are stored once. The cache cap is `Settings.team.blobCacheGb` (default 50 GB). Nothing is deleted on its own: freeing space removes only blobs the hub or server also holds and that no open project uses.
- **Transfers.** Resumable from the byte offset of a partial download; verified by hash on arrival; a mismatch is moved to quarantine and fetched again; a file changed since it was verified shows "Changed since it was shared". Hub: copy under a temp name, rename, verify. Server: HTTP Range in 8 MB parts (`BLOB_PART_BYTES`). Bundle import copies the registered blobs the archive holds. Whole-file hashing only in M9.

## 21. Photogrammetry runs, ground control and accuracy (M10)

A folder of drone photos becomes ordinary layers through three pipeline jobs (`photo.align`, `photo.georef`, `photo.products`; `@aio/schema` `photogrammetry.ts`). Nothing in the manifest changes shape: outputs are `mesh` (GLB), `pointcloud` (`copc`) and `raster` (`kit-pyramid`, `role` `ortho` or `dsm`) layers with a `capture`, and their provenance lives in the run folder, which 0.9 and older never read.

```
<project>/photogrammetry/<run>/
  run.json               aio.photo-run/1: photos, camera groups, CRS, heights, preset, stages, outputs, accuracy summary, versions, hardware
  gcp.json               aio.gcp/1: control and check points with their marks (written by the app, .bak on every write)
  report/accuracy.json   aio.photo-accuracy/1: residuals per point, RMSE per role, camera residuals, warnings
  report/align.json      aio.photo-align/1: registered and rejected photos (with reasons), reprojection error, pairs, calibration
  report/products.json   aio.photo-products/1: GSD, coverage, density, engines, timings, memory peak and budget, disk
  cameras-sfm.json       aio.photo-cameras/1: refined poses in the local frame for **Use refined poses**
  sparse/                the sparse model: COLMAP text (cameras.txt, images.txt, points3D.txt) in the run's grid frame
  sparse/frame.json      aio.photo-frame/1: the grid frame (crs, origin), the local ENU frame, heights, georeferenced
  sparse/photos.json     aio.photo-list/1: imageRoot, and per photo key its name below it, size and GNSS prior
  mesh/full.glb          the full-resolution mesh handed to tiles.mesh (tileset <run>-mesh)
  work/                  intermediates; the only part **Delete run's work files** removes (to the recycle bin)
  dsm.tif, dtm.tif, ortho.tif   COG copies of the surfaces and the orthomosaic
```

- **The sparse model** (written by `photo.align`, `photo.georef` and `opf.import`; read by `photo.georef`, `photo.products` and `opf.export`) is in the run's **grid frame**: the run's projected CRS minus `frame.json` `origin`, x east, y north, z up, metres (the manifest origin when the project has one). Model coordinates plus `origin` are project CRS coordinates; there is no other offset. COLMAP conventions otherwise: `x_cam = R X + t`, pixel (0, 0) at the top-left corner of the image. A `sparse/` without `frame.json` (an older import, or a model made by hand) is read in the project CRS itself.
- **Photo keys** name the photos everywhere in a run (the model's image names, `photos.json`, `cameras-sfm.json` `photo`, `gcp.json` marks): a photos layer run uses the layer's photo ids; a folder run the path below the chosen folder (the folder's own name first when the run has several). Keys and folder names may hold spaces and any letters. In `images.txt` the percent sign and white space are percent-encoded as UTF-8 (a percent sign `%25`, a space `%20`; COLMAP text splits at spaces); every reader decodes them. `photos.json` `imageRoot` is the folder COLMAP read the photos from (the deepest folder common to all of them) and `name` the path below it; `photo.products` and `opf.export` find a photo there, or through the photos layer for a layer run.
- **`cameras-sfm.json`**: `run`, `crs` (`{ epsg }` or `{ wkt }`), `origin` (the manifest origin the local frame is measured from), `frame`, `calibration[]` (`id`, COLMAP `model`, `width`, `height`, `params`) and `cameras[]` (`photo` key, `pos` in the local frame of section 1, `q` as three.js `[x, y, z, w]`, `lens` `{ model, hfovDeg, aspect }`, `camera` = a calibration id).
- **Tiles of a run**: `photo.products` hands `mesh/full.glb` to `tiles.mesh` (`src`, `id` `<run>-mesh`, `run`), which returns `{ tileset: <id> }`, writes `tiles/<run>-mesh/` and its `tilesets.json` entry (section 22) and lists the id in the run's `outputs.tilesets`. When tiling fails the products stay, the run gets a warning and a failed `tiles` stage.
- **Memory**: `AIO_PHOTO_MEMORY_MB`, set by the app, is the one memory cap of the photo jobs: `photo.products` plans within it (else 40 % of the physical memory) and `photo.align` stops a COLMAP stage above it (else 75 % of the memory and 90 % of what is free when the stage starts).

- **Run ids** are file-name safe (`PhotoRunId`, for example `20261007-0915`), the folder name under `photogrammetry/`. A run lists every layer, tileset and file it made in `outputs`, so **Re-run products** and package export know what belongs to it. Every path in a run file is project-relative (`ProjectPath`: no `..`, no drive letter).
- **Photos are read, never written.** EXIF and XMP are read in place; a folder run references the photos where they are. **Use refined poses** writes the photos layer's `cameras.json` from the run's `cameras-sfm.json` (same camera format), keeping the old one as `.bak`, after a preview of how far each camera moves.
- **Heights** (`PhotoHeights`): where the run's heights came from (`ellipsoidal`, `orthometric`, `relative` or `gcp`), the PROJ geoid grid used (`egm96`, `egm2008`) and the manifest's `verticalDatum.absAltOffsetM` when applied. Every run states it.
- **Ground control** (`gcp.json`): points with `role` `control` or `check`, `xyz` in the file's `crs`, a stated accuracy (1 sigma, metres) and marks per photo (`px` in original image pixels, x right and y down; `by` `person`, `detector` or `import`; `state` `draft`, `confirmed` or `skipped`). A detector's or a prediction's mark is a draft until a person confirms it. `predicted` holds where the current cameras put the point in each photo with a search radius. A disabled point is kept, never deleted.
- **Accuracy is honest:** checkpoints are measured, never used in the adjustment; `checkpointsInAdjustment` is always `false` and the report lists every residual. Each listed point says `usedInAdjustment`: true for a control point that constrained the adjustment, false for checkpoints, control points left out as outliers and every point of a GNSS-only alignment (disabled points are not measured).
- **Forward compatibility:** these files keep keys a later 1.x build adds (`looseObject`), so a save by 0.10 never drops them. Each family is in `versions.ts` (`since: '0.10'`).
- **Packages** (integration follow-up X1) carry `run.json`, `gcp.json` and `report/`, never `work/`.

## 22. Tilesets (M10)

Large meshes and clouds stream as standard 3D Tiles 1.1 (glTF content) in `<project>/tiles/<id>/`, listed in `<project>/tilesets.json` (`aio.tilesets/1`, `@aio/schema` `tilesets.ts`), which older builds ignore. No layer kind is added.

```json
{
  "schema": "aio.tilesets/1",
  "entries": [
    {
      "id": "mesh-full",
      "name": "Processed mesh",
      "kind": "mesh",
      "src": "tiles/mesh-full/tileset.json",
      "from": "run1-mesh",
      "run": "20261007-0915",
      "capture": "c2",
      "visible": true
    }
  ]
}
```

- `kind`: `mesh` (`tiles.mesh`), `points` (`tiles.cloud`), `terrain`, or `imported` (3D Tiles from other software, placed by the person, `confirmedAt` and an optional `attribution`).
- Our tilesets are written in ECEF with a root transform computed per vertex through the project CRS in float64 (never a UTM-as-metres shortcut), so the site view and the Globe agree within 2 cm. `transform` (column-major 4x4) is an extra placement into the project frame for imported tilesets.
- Written by the app with `tilesets:write` (atomic, `.bak`, refused for packages). Ids are unique and file-name safe; `src` stays inside the project.

## 23. Imagery and terrain packs (M10)

Raster packs share one format across MapLibre, the site view (3DTilesRendererJS) and the Globe (CesiumJS), and live in their own folders of the data folder, which the street-map pack manager and older builds never scan:

```
<dataRoot>/packs/imagery/<id>.pmtiles   raster tiles, WebP (or PNG, JPEG), 256 or 512 px, Web Mercator
<dataRoot>/packs/imagery/<id>.json      aio.raster-pack/1 metadata
<dataRoot>/packs/terrain/<id>.pmtiles   Terrarium-encoded heights, lossless WebP or PNG
<dataRoot>/packs/terrain/<id>.json      aio.raster-pack/1 metadata
```

- **Metadata** (`RasterPackMeta`): `id`, `kind` (`imagery` or `terrain`), `label`, `bbox`, `minZoom`, `maxZoom`, `tileSize`, `format`, `licence` (SPDX id, `public-domain` or the customer's words), `attribution`, `provenance` (the data source), `customerLicence`, `builtAt`. Terrain packs also name `encoding: 'terrarium'` and `verticalDatum` (`egm2008` for Copernicus GLO-30, `egm96` for NASADEM, or `ellipsoid`); the Globe adds the geoid separation to get ellipsoidal heights. The street-map `MapPackInfo` is unchanged; `RasterPackInfo` is the list item of `imageryPacks:list` and `terrainPacks:list` (with `source`, how the pack arrived, in the same words as street packs).
- **Licences** (decision 4): only sources whose licence allows offline redistribution are packed by us (Natural Earth, NASA Blue Marble, Landsat, Copernicus Sentinel-2 Global Mosaics, ESA WorldCover 2020 and 2021, Copernicus DEM, NASADEM). Never Cesium ion, Bing, Google, Esri, Mapbox or EOX cloudless 2018 to 2025. The attribution shows in the Globe, the map and every export that contains the data.
- **Customer imagery** (decision 12): **Import imagery** marks the pack `customerLicence: true`, "customer licence, not for redistribution"; it never travels in a `.aio` package unless the person ticks it.
- **Globe preferences** are their own userData file, `globe.json` (`aio.globe-settings/1`: imagery and terrain choice, terrain exaggeration, issue pins, terrain and imagery around the site), not a `Settings` field, so settings saved by 0.10 stay exactly what 0.9 reads.

## 24. Hand-set camera directions (`orientation.json`, PROPOSAL)

`<project>/orientation.json`, `aio.orientation/1` (`packages/schema/src/orientation.ts`), written by "Align camera to map" and "Align photo to map". Under review at merge (owner: integration lead).

```json
{
  "schema": "aio.orientation/1",
  "updatedAt": "2026-10-07T12:00:00Z",
  "clips": {
    "<video layer id>": {
      "keys": [{ "t": 2000, "yaw": 30, "pitch": -30, "roll": 0, "fill": "smooth" }]
    }
  },
  "photos": {
    "<photo set id>": {
      "<photo id>": { "yawDeg": -4.5, "pitchDeg": 1, "rollDeg": 0, "offsetM": [0, -2, 0] }
    }
  }
}
```

- **Clips.** Direction keyframes in time order, one per millisecond. `t` is **clip time** (ms of video), so a keyframe stays on its frame when the layer's `offsetMs` changes. `yaw` clockwise from grid north, `pitch` up positive, `roll` dropping the image's right side, degrees in the grid frame (as `cameraQuatFromGimbal`). `fill` says how the camera turns to the next keyframe: `smooth` (shortest-arc slerp), `track` (keep the keyframe's heading offset from the smoothed track heading, the offset interpolated to the next keyframe's, pitch and roll eased), `lookAt` (aim at `target`, local frame, from the calibrated position, roll 0, blending in and out over 0.5 s or half the segment). Before the first and after the last keyframe that keyframe's fill holds. `fill` is text: a fill a build does not know turns smoothly. Section 3 has the pose rule.
- **Photos.** One correction per photo against the pose it was imported with (the photo record's `pos` and `q`, from GPS and EXIF/XMP gimbal angles): degrees added to its heading, pitch and roll in the grid frame and metres added to its position. Every view draws a photo through `correctedPhoto(photo, photoCorrection(file, setId, photoId))`. "The same correction for the rest of the flight" goes to the photos of the set taken without a gap over 20 minutes (`sameFlightPhotos`).
- **Never changed by it:** the manifest, the video layers, the photo records, the flight files, the images and their EXIF. Entries for layers or photos the project no longer has are kept and ignored.
- **Writes.** `orientation:write` (whole file, atomic, `.bak` of the previous one). It is a journalled writer: each save is recorded before the write as a `record.external` op on `orientation.json` (a dedicated op kind needs the journal schema owner). A newer file (`aio.orientation/2`) is refused on read and never written over; a package's file is read in place and never written. Older builds (0.8, 0.9) do not read the file at all.

## 25. Site settings, units, coordinates and calibration (M11)

Surveying (M11, plan `docs/plans/2026-10-07-m11-surveying.md`) keeps all of its state in side files under `<project>/survey/` and in userData, which 0.10 and older never read: no layer kind, raster `role`, `ProjectType`, `LayerDerived.kind` or `Settings` field is added (`@aio/schema` `survey.ts`, `designs.ts`, `geodesy.ts`; every family in `versions.ts` with `since: '0.11'`). Survey tools work in every project type.

```
<project>/survey/
  settings.json                aio.survey-settings/1: how the site is shown and exported (this section)
  calibration.json             aio.site-calibration/1: the local site calibration (this section)
  calibration/                 controller files a calibration was imported from, kept as they were
  geodesy/site-transform.json  aio.site-transform/1 and its float64 grids (this section)
  surfaces/<id>/tiles.json     aio.height-tiles/1: prepared height tiles (section 26)
  measurements.json            aio.measurements/1 (section 27)
  templates.json               aio.survey-templates/1 (section 27)
  designs.json                 aio.designs/1; designs/<id>/ the original file and its normalised layers (section 28)
  overlays.json                aio.survey-overlays/1; overlays/<id>/ the overlay files (section 29)
  cleanups.json                aio.terrain-edits/1 (section 29)
  qa/<capture>.json            aio.survey-qa/1 (section 29)
  hydro/<run>/, haul/<run>/    hydrology and haul-road runs (section 30)
<userData>/survey-defaults.json    aio.survey-defaults/1: defaults for new sites
<userData>/survey-templates.json   aio.survey-templates/1: the person's template library (section 27)
<dataRoot>/packs/geoid/<id>.tif    a geoid grid, with <id>.json (aio.geoid-pack/1)
```

- **SI inside, units at the edges.** Every stored value is metres, square metres, cubic metres, kilograms or tonnes per cubic metre, float64 in JSON and Python. Coordinates are (E, N, Z) in the project CRS (manifest `crs`), metres, never the local render frame of section 1. Units are a display and export choice only.
- **Every file is `looseObject`** (keys a later 1.x build adds are kept on save) and is written atomically with a `.bak` of the previous one, through the journal (section 17; `JOURNALED_DIRS` gains `survey`). Packages are read-only: player mode reads `survey/`, never writes it and never starts a survey pipeline.
- **File-name-safe ids** (`SurveyId`, `DesignId`, `GeoidPackId`): letters, digits, dot, dash or underscore, starting with a letter or digit, at most 80 characters.

**Site settings** (`survey/settings.json`, `SurveySettings`, `aio.survey-settings/1`). The manifest `crs` stays what the data is stored in; the site settings say how it is shown and exported. A site without the file uses `defaultSurveySettings()` (`survey:readSettings` answers `exists: false` with them).

- `crs`: the display and export CRS (`{ epsg }` or `{ wkt }`); absent means the manifest `crs`.
- `verticalDatum` (`SiteVerticalDatum`): `{ kind: 'project' }` (the project's own heights, `verticalDatum.absAltOffsetM` of the manifest, as in 0.10), `{ kind: 'ellipsoidal' }` (heights above the ellipsoid as stored), `{ kind: 'geoid', geoid, epsg? }` (orthometric heights through a geoid pack, `epsg` the vertical CRS, for example 5773 EGM96 height or 3855 EGM2008 height) or `{ kind: 'calibration' }` (the site calibration's vertical adjustment).
- `calibration`: the id of the applied calibration (`survey/calibration.json`); absent means none.
- `distances`: `grid` (default) or `ground` (grid distances scaled by the combined factor). Readouts label which one they show; a scale factor of 0.9996 is 40 cm per kilometre.
- `units` (`SurveyUnits`), `order` (`NEZ` or `ENZ`), `precision` (`SurveyPrecision`: decimal places, 0 to 6, for `coordinate`, `distance`, `area`, `volume`, `grade`), `locale` (`metric`: space-grouped thousands; `imperial`: comma-grouped; absent: from the unit system).
- `templateSets`: the industry sets in use (`construction`, `mining`, `landfill`; section 27). `materials`: the site materials (section 27). `qa`: `{ level, rmseM? }` (section 29). `heatmap`: `{ stops, stepped, inverted? }`, 2 to 16 ascending `{ value, color }` stops, default -1, -0.1, 0.1, 1 m. `deadbandM`: the default deadband for new comparisons.
- Written with `survey:writeSettings` (journaled `survey.settings`, a `PatchPayload`; permission `builder.edit`). **Changing the CRS, datum, geoid or calibration never silently changes a reported number:** every result records what it was computed with (section 26, fingerprint) and shows **Stale, recompute** when that changes.
- userData `survey-defaults.json` (`SurveyDefaults`, `aio.survey-defaults/1`: `units?`, `order?`, `precision?`, `templateSets?`) holds the person's defaults for new sites. A new site's units otherwise come from its CRS's own unit (a US state plane zone in US survey feet gets US survey feet, a metric grid metres; decision 12).

**Units** (`survey.ts`; conversions in `packages/geo/src/units.ts`, G1):

| Quantity | Units (stored values are always the first SI unit)                                   |
| -------- | ------------------------------------------------------------------------------------ |
| Distance | `m`, `mm`, `cm`, `km`, `ft`, `us-ft`, `in`, `yd`, `mi`, `us-mi`                      |
| Area     | `m2`, `ha`, `km2`, `ft2`, `us-ft2`, `yd2`, `acre`, `mi2`                             |
| Volume   | `m3`, `L`, `ft3`, `yd3`, `us-gal`, `acre-ft`                                         |
| Density  | `t/m3`, `kg/m3`, `lb/ft3`, `lb/yd3`, `ston/yd3` (short tons per cubic yard)          |
| Mass     | `kg`, `t`, `ston` (short ton), `lb`                                                  |
| Grade    | `percent`, `degrees`, `ratio-1-n` (1:n, rise to run), `ratio-n-1` (n:1, run to rise) |

- `ft` is the **international foot** (exactly 0.3048 m), labelled "ft (international)" where both are offered; `us-ft` is the **US survey foot** (exactly 1200/3937 m), labelled "US ft". They are distinct units with distinct labels and never both "ft"; `us-ft2` and `us-mi` derive from the US survey foot. The two differ by 2 ppm, 2 cm over 10 km.
- One formatter (`formatQuantity(value, quantity, units, precision)`) formats every readout, label and export header. A measurement may override any of the site units (section 27).

**EPSG catalogue.** `tools/geo/build-crs-catalogue.mjs` (calling `python -m aio_pipelines --crs-catalogue`) reads PROJ's `proj.db` and writes `packages/geo/src/catalogue/epsg.json.gz`: one `CrsCatalogueEntry` per CRS (`code`, `name`, `kind` `projected`, `geographic`, `vertical` or `compound`, `area` and `bbox` of use, `unit`, `datum`, `deprecated`, and `proj4` only when proj4js represents it exactly, checked against PROJ at build time). `geodesy:searchCrs` searches it by code, name and area (`near` ranks CRSs whose area of use holds a longitude and latitude). Under 1.5 MB compressed, loaded lazily.

**PROJ is the one truth** (ADR 0010). Every number a person reads or exports comes from PROJ in the pipeline pack, with the site's horizontal CRS, vertical datum, geoid and calibration applied in one pipeline (`python/src/aio_pipelines/geodesy/site.py`). `PROJ_NETWORK=OFF` in the pack's environment; a missing grid is an exact refusal that names the pack it needs, never a fallback to the ellipsoid and never a download.

**Site transform tables** (`survey/geodesy/site-transform.json`, `SiteTransform`, `aio.site-transform/1`), written by `survey.prepare` (G1's part) for the renderer, which never re-implements a datum:

- `from` (the data CRS, manifest `crs`), `to` (the display CRS of the site settings), `operation` (PROJ's chosen operation, shown in **Site settings, Details**), `calibration` and `geoid` ids, a `fingerprint` of every input (CRS, calibration, geoid pack) and `writtenAt`.
- `proj4`: set only when the display CRS is a pure projection proj4js represents exactly (checked against PROJ at 25 points over the site when written); the renderer then uses proj4js for horizontal readouts.
- `grid` (`F64Grid`, two bands, E and N): otherwise, and for every calibrated site, the mapping from the project CRS to the site grid at 1 m spacing. `geoidGrid` (`F64Grid`, one band): the effective height correction `N_eff` over the site extent, the value subtracted from a stored height to give the displayed one. It is the geoid undulation cut from the geoid pack by PROJ, with the calibration's vertical plane folded in when heights follow the calibration. Both are interpolated bilinearly. Tables are 1 m apart up to 1 M cells; a larger site doubles the spacing until it fits (`spacingM` says which).
- **`F64Grid`**: `file` (relative to `survey/geodesy/`), `originX`, `originY` (the lower-left cell centre in the project CRS, metres), `spacingM`, `cols`, `rows`, `bands`. The file is little-endian float64, row-major from the lower-left cell (rows run north, columns east), `bands` values per cell, nodata NaN.
- **Parity:** renderer readouts equal pyproj within 1 mm horizontally and vertically at 1,000 random points of each synthetic site, in CI for every fixture CRS and calibration.

**Geoid packs** (`<dataRoot>/packs/geoid/<id>.tif` and `<id>.json`, `GeoidPackMeta`, `aio.geoid-pack/1`; a folder older builds and the other pack managers never scan):

- `id`, `name`, `bbox` (west, south, east, north, degrees), `horizontalEpsg`, `verticalEpsg`, `projFile` (the PROJ-data file name, for example `au_ga_AUSGeoid2020_20180201.tif`), `licence`, `attribution`, `provenance`, `sha256`, `bytes`, and `imported: true` for a grid a person imported.
- EGM96 and EGM2008 ship in the pipeline pack, as in M10. Regional packs are built from PROJ-data with their licences and attributions (`tools/maps/build-packs.mjs --geoid`). **Import geoid grid** (`geoidPacks:import`: a GeoTIFF or GTX with the `name`, `licence`, `attribution` and `verticalEpsg?` the person states) covers models PROJ-data does not have, such as GCC national geoids. `geoidPacks:list` lists the folder plus the global grids of the pack; `geoidPacks:remove` removes one. Downloading a pack is an explicit online action, refused on an offline-only workstation. The pack's PROJ search path includes the folder.
- The geoid is named on every height readout (tooltip), result, report and export; each pack's attribution shows wherever its heights do.

**Site calibration** (`survey/calibration.json`, `SiteCalibration`, `aio.site-calibration/1`). Applied in the controller's order:

1. **Base projection** (`projection`): geographic coordinates to a projected CRS, often a transverse Mercator at the site with its own scale factor.
2. **Horizontal similarity** (`horizontal`, `HorizontalAdjustment`, Helmert 2D) about an origin: `local = origin' + scale * R(rotation) * (grid - origin)`, where `origin` is (`originE`, `originN`) in the base projection, `origin'` is the origin moved by (`shiftE`, `shiftN`), `R` rotates by `rotationRad` (counter-clockwise positive) and `scale` is dimensionless.
3. **Vertical adjustment** (`vertical`, `VerticalAdjustment`): `dz = shiftM + slopeN * (N - originN) + slopeE * (E - originE)`, a constant shift plus an inclined plane, with slopes in metres per metre, on geoid heights when `geoid` names a geoid pack and on ellipsoidal heights when it is absent.

- `source`: `format` (`jobxml`, `dc`, `12d`, `cal` or `pairs`), the imported `file` (kept as it was in `survey/calibration/`) and its `sha256`; absent file for typed pairs.
- `pairs` (`CalibrationPair`, at most 500): `name`; `local` as the controller lists it, **(N, E, Z)**; a global position as `wgs84` (latitude and longitude in degrees, ellipsoidal height in metres) or `grid` (N, E, Z in the base projection); `useH`, `useV`; our `residualH` (horizontal, never negative) and `residualV` (signed) in metres; and `controllerResidualH`, `controllerResidualV` when the file reports its own, shown side by side. `rmsH` and `rmsV` are the root mean square of the used residuals. Note the axis order: pairs follow the controller (N, E, Z); everything else in `survey/` is (E, N, Z).
- **Import** (`geo.calibration`, `GeoCalibrationParams`: a `src` file with an optional `format`, or `pairs` to solve by least squares, not both; `crs` the base projection; `verticalDatum?`; `geoid?`): Trimble JobXML (`.jxl`) and `.dc`, 12d transforms, Trimble `.cal` only if found documented (decision 8), and **Compute from point pairs**, which solves the same model and covers every vendor. Topcon `.gc3` is out.
- **A person applies it.** An imported or computed calibration is a draft (`appliedAt` absent) until a person confirms it on the residual table: `geodesy:applyCalibration` (`apply: true`, or `false` to remove it), journaled as `survey.calibration` (a `RecordPayload`; permission `builder.edit`), sets `appliedAt` and `appliedBy` and the site settings' `calibration`, and marks every dependent result stale. It then applies everywhere: readouts, measurement coordinates, design import (`useCalibration`), exports ("site grid" means calibrated) and reports, each stating "Site calibration X, residuals H n mm, V n mm".

**Exports** (`survey.export`, `SurveyExportParams`): `what` (`surface`, `ortho`, `cloud`, `contours`, `measurements`, `section`), `format` (`geotiff`, `laz`, `dxf`, `landxml`, `12da`, `csv`, `kml`, `shp`, `geojson`), `crs` (`site`, the site grid, calibrated when a calibration applies; `wgs84`; or `{ epsg }`), `units?`, `decimate?` (the share of points or faces kept, 1 is full), the source (`surface`, `layer`, `overlay` or `measurements`), and `out`, the absolute file or folder main chose. Every export states its CRS, vertical datum, geoid, calibration and units in its metadata and in a file name suffix (for example `_site-grid_usft`).

## 26. Surfaces and the comparison specification (M11)

This section is the single written specification of a surface comparison (ADR 0009). Two executors implement it: the Python reference core (`python/src/aio_pipelines/survey/compare.py` with `grid.py`, `bases.py`, `tin.py`; the `survey.compare` pipeline; results `engine: 'py'`) and the TypeScript executor in a renderer worker (`packages/survey/src/engine/`; results `engine: 'ts'`). They run the shared fixtures in `packages/schema/src/__fixtures__/survey/` and agree to 1e-6 relative; a difference is a bug in one of them, never a tolerance to widen. A change to the formula is a change to this section first.

**Prepared surfaces** (`survey/surfaces/<id>/tiles.json`, `HeightTiles`, `aio.height-tiles/1`), written by `survey.prepare` (`SurveyPrepareParams`: `surfaces[]` of `{ id, name, source, capture? }`, `cellM?`, `geodesy?` (also write the site transform tables of section 25, default true)):

- `source` (`PreparedSurfaceSource`): `{ kind: 'dsm', layer }`, `{ kind: 'dtm', layer }`, `{ kind: 'cloud', layer }` (gridded through PDAL), `{ kind: 'design', design, layer }` (a design TIN, section 28) or `{ kind: 'derived', of, edits }` (a cleanup or crop of another prepared surface, section 29).
- Tiles of 256 by 256 cells (`tileSize: 256`) at `cellM`, as `<level>/<col>_<row>.bin` (deflate): float32 heights relative to a float64 base per tile, and a nodata bit mask per tile. `originE`, `originN` is the lower-left corner of tile (0, 0) at level 0 in the project CRS; `cols`, `rows`, `levels` (a display pyramid above level 0); `bounds` (min E, min N, min Z, max E, max N, max Z); `tiles` lists the level-0 tiles that exist as `col_row`, and an absent tile is all nodata. A `.bin` is a zlib stream (RFC 1950, what `DecompressionStream('deflate')` reads) of, little-endian: `AHT1`, uint32 flags (0), the float64 base, 65,536 float32 heights relative to it (row-major, row 0 the southernmost, column 0 the westernmost; 0 where there is no data) and an 8,192-byte mask (bit `k & 7` of byte `k >> 3` set where cell `k` has data). Level `L` has cells of `cellM * 2^L` from the same origin, each the mean of the valid 2 by 2 cells below it.
- A grid surface holds heights at its cell centres (posts) and is sampled bilinearly between them; a post is needed only when its weight is above zero, a needed post without data makes the sample nodata, and a position within 1e-9 cell of a post snaps to it (so a comparison grid aligned with the surface reads its posts exactly).
- Heights relative to a float64 base per tile keep 0.06 mm at a 1,000 m range. A surface is prepared again only when its `fingerprint` (the source's hash, `sourceSha256`, and the preparation parameters) changes. Delivered DSMs, clouds and orthos are read, never written.
- `survey:surfaces` lists the prepared surfaces for the From and To pickers.

**A comparison item** (`ComparisonItem`): `{ id, label?, from, to, deadbandM?, useDeadband, cellM? }`; a polygon measurement holds up to 20 of them (section 27). Each side is a `SurfaceRef`:

| Kind                  | Meaning                                                                                                                                                                                                                                            | Contract                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `survey`              | A capture's DSM, DTM, gridded cloud or a cleaned derived surface                                                                                                                                                                                   | `{ kind: 'survey', surface, capture? }`, a prepared surface            |
| `current`, `previous` | The survey the measurement is viewed on, and the one before it, resolved through `captureIndex()` (`packages/workspace/src/captures.ts`) at compute time; the result records which captures it used                                                | `{ kind: 'current' }`, `{ kind: 'previous' }`                          |
| `design`              | A design surface layer with its vertical offset added (`DesignLayer.verticalOffsetM`)                                                                                                                                                              | `{ kind: 'design', design, layer }`, the layer's `aio.tin/1`           |
| `reference`           | A flat level: a typed elevation (`level`, `levelM` in the site's vertical datum), or the highest or lowest height of the surface side along the polygon perimeter (`perimeter-max`, `perimeter-min`) or inside it (`interior-max`, `interior-min`) | `{ kind: 'reference', mode, levelM? }` (`levelM` required for `level`) |
| `smart`               | A Delaunay TIN of the perimeter densified at the cell size and sampled on the surface side (the kit's `tin`)                                                                                                                                       | `{ kind: 'smart' }`                                                    |
| `fit-plane`           | The least-squares plane through the perimeter samples (the kit's `plane`)                                                                                                                                                                          | `{ kind: 'fit-plane' }`                                                |
| `perimeter-mean`      | A flat level at the mean perimeter height (the kit's `avg`)                                                                                                                                                                                        | `{ kind: 'perimeter-mean' }`                                           |
| `custom`              | A TIN of the polygon's vertices with heights a person edits: per vertex an absolute `z` or an `offsetM` from the surface side at that vertex, never both                                                                                           | `{ kind: 'custom', vertices: [{ e, n, z?, offsetM? }] }`, 3 to 10,000  |

- The last five are **bases** (`BaseSpec`). A base that needs samples (`reference` other than `level`, `smart`, `fit-plane`, `perimeter-mean`, a `custom` vertex with `offsetM`) takes them from the **surface side** of the item: the other side, which must then be a `survey`, `current`, `previous` or `design` surface. (The plan and `survey.ts` call that side "the From surface"; for the usual base-to-survey item the base is From and the survey is To.) Perimeter samples are taken along the polygon's edges densified at the cell size (on the TIN to TIN path at the item's `cellM`, else 0.1 m); samples without data are left out, and a level needs one valid sample, a plane or a TIN three, else the item is refused with the reason. `fit-plane` is the least-squares plane by the normal equations (Gauss-Jordan, the kit's arithmetic); `perimeter-mean` the sum in sample order over the count; `smart` and `custom` the Delaunay triangulation both executors compute the same way (a sweep-hull with exact orientation signs, so cocircular points give the same TIN). A cell at the polygon's edge whose centre lies just outside a `smart` or `custom` TIN takes the height of the nearest point of the TIN's hull.
- **The kit's bases** map to `smart` (`tin`), `fit-plane` (`plane`), `perimeter-mean` (`avg`) and `reference` `perimeter-min` (`low`). A volumetric project still shows them under their old names and its `volumes.json` (section 10) is unchanged; the kit's numbers stay identical (exact on the same grid, 0.1% otherwise).

**Sign convention.** `dz = To - From`. Fill where `dz > 0`, cut where `dz < 0`; `net = fill - cut`; `total = fill + cut`. Cut and fill are never negative.

**Volume formula (grid path).** On a grid of cell size `c` aligned to the prepared tiles (`cellM` of the item, default the finer prepared surface's cell):

- Each cell `i` gets a **coverage weight** `w_i`: the exact area of the intersection of the polygon and the cell, divided by `c²`, computed by clipping (never a cell-centre in-or-out test).
- `dz_i = To(i) - From(i)`, each side sampled bilinearly at the cell centre (TIN surfaces and TIN bases barycentrically; flat and planar bases exactly).
- `Fill = c² Σ w_i max(dz_i, 0)` and `Cut = c² Σ w_i max(-dz_i, 0)`, summed over the covered cells, and, when the deadband is used, only over cells with `|dz_i| >= deadbandM`.
- Areas: `areaFillM2 = c² Σ w_i` over cells counted as fill, `areaCutM2` likewise for cut, `areaUnchangedM2` over covered cells that count as neither (inside the deadband, or `dz_i = 0`), `uncoveredM2` over cells where either side has no data, and `areaM2` the polygon's horizontal area (their sum).

**Deadband.** Cells with `|dz_i| < deadbandM` contribute nothing **only when `useDeadband` is on** (**Use deadband in calculations** is an explicit opt-in); with it off the deadband only shapes the heat map. The result records `deadbandM` and `usedDeadband`, and every report and export that shows the volume says whether a deadband was used. A surface with noise below the deadband gives exactly zero cut and fill with the deadband on.

**Uncovered area.** A cell where either surface has no data (a nodata height needed by its sample, or outside the survey) is counted in `uncoveredM2` and never treated as zero height or zero `dz`. With `share = uncoveredM2 / areaM2`: up to 2% the item is `ok`; above 2% it is `partial` with the reason "n% outside the survey" and the volumes of the covered part; above 20% it is `refused` with that reason and no volumes are shown.

**TIN to TIN, exact.** When both sides are triangulated or planar (design to design, design to a reference level or a custom base with absolute heights), the item is computed exactly by intersecting the two triangulations over the polygon (prismoidal), with no grid: `cellM` is `0` in the result and coverage is exact. Within 1e-6 relative of the analytic volume. With the deadband used, the parts of each piece where `|dz| < deadbandM` count as unchanged and the rest keeps its whole `dz` (the continuous form of the grid rule); a piece where `dz` is zero everywhere is unchanged. Without a grid side, an item whose surface side is a design is on this path whatever its base (levels, planes and TIN bases are all exact).

**Outputs and fingerprint** (`ComparisonResult`, one per item, stored on the measurement):

- `item` (the item id), `status` (`ok`, `partial`, `refused` or `stale`) and `reason`; `cutM3`, `fillM3`, `netM3`, `totalM3`; `areaM2`, `areaCutM2`, `areaFillM2`, `areaUnchangedM2`, `uncoveredM2`; `fromLabel` and `toLabel` (what each side was, in words); `fromCapture` and `toCapture` (the captures `current` and `previous` resolved to); `deadbandM`, `usedDeadband`; `cellM`; `engine` (`ts` or `py`); `computedAt`.
- `fingerprint`: a hash of every input: the surfaces' fingerprints and file hashes, the design's vertical offset, the base parameters (including custom vertices), the deadband and whether it is used, the cell, the polygon, the resolved captures, and the calibration and geoid ids. Both executors write `sha256:` and the SHA-256 of the same canonical JSON (keys sorted, no spaces, integers below 2^53 as integers, other numbers as `Number.prototype.toExponential()`) of the engine version, the polygon, each side (`ref`, the surface's fingerprint, its capture, a design's `offsetM`), `deadbandM`, `useDeadband`, `cellM` and the site (`verticalDatum`, `calibration`), so a result from either is current for the other. The uncovered share in a reason is rounded half up to a whole percent. A result whose fingerprint no longer matches its inputs is **never shown as current**: it shows **Stale, recompute** (`status: 'stale'` once marked).
- Calculators (shrink and swell, density, weight; section 27) are applied at display time from the material and never change the stored volume.

**Whole site and bulk** (`survey.compare`, `SurveyCompareParams`): either `items[]` (`{ measurement, ring, item, capture? }`, up to 5,000: reports, bulk recompute after a calibration change) or `site` (`{ from, to, deadbandM?, cellM?, ring? }`, a whole-site comparison over the overlap of both surfaces or a boundary), never both; `out?` a project path. Whole-site mode writes the difference grid, its heat map pyramid and contours of the difference; its regions are drafts a person accepts as measurements. `change.surface` keeps its contract (`aio.change/1`, section 14) and calls the core for its volumes and `areas`.

**Items results file** (`SurveyCompareFile`, `aio.survey-compare/1`): `survey.compare` in items mode writes `survey/compare/<job>.json` (or `out`) with `pipeline` (`survey.compare`), `jobId`, `computedAt` and `results[]` of `{ measurement, result }` (`ComparisonResult`). It is a draft: the app copies each result onto its measurement; nothing else reads it.

## 27. Measurements, templates and materials (M11)

**Saved measurements** (`survey/measurements.json`, `MeasurementsFile`, `aio.measurements/1`): `measurements[]` (`SurveyMeasurement`, at most 20,000, ids unique). The annotation `Measurement` (`annotation.ts`) is unchanged; survey measurements are a separate family.

- `id`, `family` (`point`, `line`, `polygon`, `markup`) and `tool`: point `elevation`, `elevation-difference`, `elevation-history`, `annotation`; line `distance`, `grade`, `vertex-table`, `berm-check`, `section`; polygon `area`, `volume`; markup `freehand`.
- `template?`, `label`, `folder?`, `scope` (`{ kind: 'site' }`, or `{ kind: 'survey', capture }` for one survey; promote and demote switch it).
- `points`: vertices (E, N, Z) in the project CRS, float64, 1 to 100,000; a polygon is closed implicitly (the last point does not repeat the first).
- `style?` (`MeasurementStyle`: `color`, `fill`, `fillOpacity`, `borderWidth`, `labelSize`, `labelOnlyWhenSelected`, `showPropertyName`), `units?` (`UnitsOverride`: any subset of the site units of section 25), `description?`, `fields?` (custom field values by field id, text or number), `material?` (a site material id).
- `items` (up to 20 `ComparisonItem`s) and `results` (up to 20 `ComparisonResult`s), section 26.
- `createdAt`, `createdBy?`, `updatedAt?`.
- `survey:readMeasurements` returns the file (an empty list when there is none) and `readOnly` (a package). `survey:writeMeasurements` writes it atomically with `.bak`, refused for packages, journaled per measurement as `measurement.create` (`RecordPayload`), `measurement.patch` (`PatchPayload`) or `measurement.delete` (`{}`), record kind `measurement`, permission `edit`. 0.9 and 0.10 read these ops as `unknown-kind` (`packages/journal/src/query.ts`), never refuse them. Sync merges measurements by id.

**Cross-sections** (G5): `SectionSpec` (`line` of 2 to 10,000 (E, N) points; `surfaces` of 1 to 20 `survey`, `current`, `previous` or `design` refs; `stepM?`, default half the finest cell; `exaggeration?` 1 to 20) gives one `SectionProfile` per surface (`surface`, `label`, `chainage[]`, `z[]` with `null` where the surface has no data). The worker samples them as section 26 samples heights. `survey.section` (`SurveySectionParams`: `line`, `surfaces`, `format` `dxf-2d-xy`, `dxf-2d-xz`, `dxf-2d-yz`, `dxf-3d-zup`, `dxf-3d-yup` or `csv`, `capture?`, `out`) writes a section file, one DXF layer per surface.

**Templates** (`survey/templates.json` for the project and userData `survey-templates.json` for the person's library, both `SurveyTemplatesFile`, `aio.survey-templates/1`, at most 1,000 templates):

- `SurveyTemplate`: `id`, `name`, `family`, `tool`, `description?`, `items` (result rows in display order, such as `cut`, `fill`, `net`, `total`, `area`, `length`), `fields` (`CustomField`: `id`, `name`, `type` `text`, `number` or `dropdown`, `options` for a dropdown), `comparisons` (up to 10 `ComparisonPreset`s: an item without its id, which is made when the template is used), `style?`, `bookmarked?` (shown on the toolbar), `set?` (the industry set it came from).
- `survey:readTemplates` returns `project` (null without a project or file) and `user`; `survey:writeTemplates` writes one of them (`scope` `project` or `user`). A measurement's template can be changed after it is made.
- **Industry template sets** (`IndustrySet`: `construction`, `mining`, `landfill`; content in `packages/survey/src/templates/{construction,mining,landfill}.json`, G9). A site enables one or more in its settings (`templateSets`) and the toolbar shows their templates.

**Site materials** (in `survey/settings.json` `materials`, `SiteMaterial`, at most 500): `id`, `name`, `code?`, `densityTPerM3?` (tonnes per cubic metre) and `swell?` (`{ loose, compacted }`, volume factors relative to bank, in-situ, volume). CSV import and export. A measurement picks a material.

**Calculators** (G4) work on a stored volume at display time and never change it:

- **Shrink and swell:** loose volume = bank volume times `swell.loose`; compacted volume = bank volume times `swell.compacted`.
- **Density:** tonnes = volume times `densityTPerM3`.
- **Weight:** achieved density = tonnage divided by volume (the landfill compaction figure: 63,000 t over 70,104 m³ is 0.899 t/m³).

## 28. Designs and alignments (M11)

Imported design files (`design.import`, G6) keep their original byte for byte and are normalised into layers; no layer kind is added. The list is `survey/designs.json` (`DesignsFile`, `aio.designs/1`), written by the app with `survey:writeDesigns` (journaled `design.add` (`RecordPayload`), `design.patch` and `design.archive` (`PatchPayload`), record kind `design` per design id; the file's own keys such as `activeAlignment` are a `design.patch` on `{ rec: 'survey', id: 'designs' }`; permission `builder.edit`; refused for packages) and read with `survey:readDesigns` (an empty list when there is none).

```
<project>/survey/designs/<id>/
  <original file>                byte for byte, never rewritten (DesignEntry.src)
  <layer>.tin                    aio.tin/1 surface
  <layer>.geojson                linework, GeoJSON in the project CRS with Z and a top-level crs
  <layer>.alignment.json         aio.alignment/1 horizontal alignment
  <layer>.points.json            points, GeoJSON points (id, code) in the project CRS with Z
  <layer>.glb                    display mesh of a surface for the site view (DesignLayer.glb)
```

- **`DesignEntry`**: `id` (the folder name), `name`, `folder?`, `src` (the original's file name), `sha256`, `bytes`, `format` (`landxml`, `dxf`, `12da`, `csv`, or `ttm` only with a published specification or a Trimble agreement, decision 2), `units` (the file's length unit, `m`, `mm`, `cm`, `ft`, `us-ft` or `in`, from `INSUNITS` or LandXML `Units`; stored values are always metres), `crs?` (the CRS of the file's coordinates; absent when placed through the site calibration), `calibrated`, `importedAt`, `importedBy?`, `layers[]`. Design ids are unique; `activeAlignment` (`<design>/<layer>`) is the alignment whose station and offset the cursor shows.
- **`DesignLayer`**: `id`, `name`, `kind` (`surface`, `linework`, `points`, `alignment`), `file` (the normalised file in the design folder), `glb?`, `counts` (entity counts by type: `triangles`, `vertices`, `lines`, `points`, ...), `visible`, `archived`, `verticalOffsetM` (subgrade or pavement depth, applied when the layer is used, never written into the file), `clamp?` (linework draped on the terrain), `intervalM?` (alignment layers only, a loose key: the station label interval a person set, overriding the alignment file's `intervalM`; the file is never rewritten).
- **Linework and points**: `<layer>.geojson` is a GeoJSON `FeatureCollection` of `LineString` features with Z and a top-level `crs` (the project CRS record). `<layer>.points.json` is a GeoJSON `FeatureCollection` of `Point` features `[E, N, Z]` in the project CRS, each with the properties `id` (the point's name or number) and `code` (its feature code, left out when it has none), and a top-level `crs`.
- **Limits** (`DESIGN_LIMITS`): 2,000,000 triangles per surface layer and 500 MB per file; above them, an exact refusal. Hostile files (XML with a DTD or external entities, binary DXF, broken 12da records, mixed CSV separators) are refused with a reason that names the line or entity, never a crash of main and never an unbounded allocation.
- **`design.import`** (`DesignImportParams`): `src` (absolute; copied into the design folder), `format?` (default from the extension and content), `id?`, `name?`, `crs?`, `useCalibration?` (place local coordinates through the site calibration of section 25), `units?` (default from the file), `layers?` (source layer names, default all).

**`aio.tin/1` files** (`<layer>.tin`, header `TinHeader`): a little-endian uint32 header length; the UTF-8 JSON header; padding to a multiple of 8 bytes; `vertexCount * 3` float64 (E, N, Z in the project CRS, metres, **design offset not applied**); then `triangleCount * 3` uint32 vertex indices; then, when the header has `chainsAt`, `breaklines` chains, each a uint32 `kind` (0 breakline, 1 outer boundary, 2 void, 3 other boundary), a uint32 `count` and `count` uint32 vertex indices. The header holds `schema`, `crs`, `bounds` (min E, min N, min Z, max E, max N, max Z), `vertexCount`, `triangleCount` (at most 2,000,000), `verticesAt` and `trianglesAt` (byte offsets from the file start), `breaklines?` (the number of breakline and boundary chains carried with the surface) and `chainsAt?` (the byte offset of the first chain, after the triangles; additive, so a reader that ignores it still reads the surface).

**Alignments** (`<layer>.alignment.json`, `Alignment`, `aio.alignment/1`): horizontal only in M11 (no vertical alignments).

- `name`, `crs`, `startStation`, `elements[]` (1 to 10,000), `equations[]` (up to 100), `intervalM?` (the station label interval, **Edit station intervals**).
- Elements (`AlignmentElement`), points (E, N) in the project CRS: `line` (`start`, `end`, `length`); `arc` (`start`, `end`, `center`, `radius`, `rot` `cw` or `ccw` seen from above, `length`); `spiral` (clothoid only: `start`, `end`, `radiusStart` and `radiusEnd` with `null` for an infinite radius at the tangent end, `rot`, `length`, `dirStart` the bearing at the start in radians clockwise from grid north).
- **Stationing** starts at `startStation` and runs along the elements; a station equation `{ back, ahead }` means that at station `back` on the incoming chainage, stations continue from `ahead`. Station and offset match the alignment's own start station and equations.

## 29. Overlays, cleanups and QA (M11)

**Terrain overlays** (`survey/overlays.json`, `SurveyOverlaysFile`, `aio.survey-overlays/1`, at most 500; files in `survey/overlays/<id>/`), registered there and not in the manifest:

- `SurveyOverlay`: `id`, `name`, `kind` (`contours`, `slope`, `elevation`, `relief`), `source` (`{ surface }`, a prepared surface, or `{ comparison: { from, to } }`, the difference of a comparison), `options` (by kind: contours `minorM`, `majorM`; slope `style`, `stops`; elevation `stops`, `stepped`; relief `azimuth`, `altitude`, `intensity`), `dir` (the overlay's folder), `visible`, `fingerprint`, `createdAt`.
- Rasters (slope, elevation ramp, relief) are `kit-pyramid` tiles shown by the existing raster and map machinery; contours are GeoJSON with Z and an index for labels, the major interval a multiple of the minor. Default slope stops 0, 57.74, 100 and 173.21 percent (0, 30, 45 and 60 degrees).
- Made by `survey.overlay` (`SurveyOverlayParams`: `id?`, a `surface` or a `comparison`, not both, `kind`, `options?`).

**Terrain cleanups and crops** (`survey/cleanups.json`, `TerrainEditsFile`, `aio.terrain-edits/1`, at most 2,000 edits):

- `TerrainEdit`: `id`, `kind` (`cleanup`: the surface inside the ring is replaced by an interpolation from the ring's boundary, `method` `tin` or `thin-plate`; `crop`: the surface is cut to the ring), `surface` (the prepared surface it applies to), `ring` (3 to 100,000 (E, N) points), `enabled`, `label?`, `createdAt`.
- `survey.cleanup` (`SurveyCleanupParams`: a `surface` with `edits` applied in order, or a `dtmFilter` `{ layer, preset }` with presets `equipment`, `equipment-vegetation`, `structures`, `everything` as PDAL `filters.smrf` and `filters.csf` parameter sets; `out?`, default `<capture>-clean`) writes a **new derived surface** `survey/surfaces/<capture>-clean/` (source `{ kind: 'derived', of, edits }`, section 26) that comparisons can pick. The delivered DSM, cloud and ortho are never changed and nothing is deleted.

**Survey QA** (`survey/qa/<capture>.json`, `SurveyQa`, `aio.survey-qa/1`):

- `capture`, `level` (`strict`, `moderate`, `lenient`, `off`), `status` (`pass`, `fail`, `hold`, `released`, `unchecked`), `checkedAt`.
- `checkpoints?`: `count`, `rmseM`, `meanM`, `maxAbsM` and `points[]` (`name`, `dz` = surface minus surveyed height, metres, `null` where the surface has no data). RMSE thresholds by level: 0.05, 0.10 and 0.20 m, overridable in the site settings (`qa.rmseM`).
- `previous?` (the compare-to-previous check on the M8 registration check): `capture`, `thresholdM`, `changedShare` (0 to 1). It fails when Strict: more than 50% of the area beyond 0.10 m; Moderate: more than 60% beyond 0.20 m; Lenient: more than 60% beyond 0.40 m.
- `hold?` (`at`, `reason`) and `release?` (`at`, `by?`, `note`). A failed check puts the survey on hold (a banner; measurements on it are marked "survey on hold"); only a person releases it, with a note. Both are journaled as `survey.hold` (`{ capture, action: 'hold' | 'release', note? }`, permission `edit`).
- Made by `survey.qa` (`SurveyQaParams`: `capture`, `surface`, `level`, `checkpoints?` from a CSV (absolute) or `{ gcp }`, the M10 GCP file of a run, `previous?` `{ capture, surface }`). Processed surveys also use the M10 accuracy report (section 21).

## 30. Hydrology and haul-road runs (M11, later phases)

Hydrology (G10) and haul-road compliance (G11) are pipeline jobs over a prepared surface (section 26). Each run writes a folder of its own under `survey/hydro/<run>/` or `survey/haul/<run>/` (`run`, a `SurveyId`, optional in the params) with a `run.json` describing the inputs, outputs and fingerprint; that file's family and its `versions.ts` row are added by G10 and G11 when they land (not in G0). A run's `work/` folder holds intermediates and never travels in a package. Runs read surfaces and never change them. Plan gates: `survey.hydro` and `survey.haul` (entitlements, all allowed in M11).

- **Flood to level** (`hydro.flood`, `HydroFloodParams`): `surface`, `levelM` (metres in the site's vertical datum), `mode` (`connected`: only water connected to `seed`; `all-below`: every cell below the level), `seed?` (E, N), `region?` (a ring), `run?`. Outputs: the outline, a depth raster and the stored volume below the level; the outline as DXF.
- **Runoff and catchments** (`hydro.flow`, `HydroFlowParams`): `surface`, `mode` (`runoff`, `catchment`, `streams`), `drop?` (the drop point for runoff), `outlets?` (up to 100 pour points), `method?` (`d8` or `dinf`), `depressions?` (`fill` or `breach`), `streamAreaM2?` (the contributing area that starts a stream), `region?`, `run?`.
- **Direct rainfall** (`hydro.rainfall`, `HydroRainfallParams`): `surface`, `hyetograph` (an absolute CSV path: time in minutes, intensity in mm/h), `manningN`, `infiltrationMmPerH` (constant), `cellM` (0.5, 1 or 2), `durationMin?` (up to 7 days), `region?`, `run?`. Water depth over time; a simplified local-inertial model, shipped as preview if it misses its targets.
- **Hydrology run file** (`HydroRun`, `aio.hydro-run/1`, `survey/hydro/<run>/run.json`, G10; `versions.ts` since 0.11): `id` (the run, default the job id), `pipeline` (`hydro.flood`, `hydro.flow` or `hydro.rainfall`, which also picks the shape of `results`), `jobId`, `computedAt`, `surface` (`{ id, name, fingerprint }` of the prepared surface read), `params` (as run), `cellM` (the cell computed on), `results`, `files` (paths relative to the run folder: `outline` GeoJSON and `dxf` for a flood, `depth` or `maxDepth` grids as `aio.grid/1` with a colour `view` `{ file, bounds }` (west, south, east, north), `path`, `catchments` and `streams` GeoJSON for flow, `hydrograph` CSV for rainfall), `fingerprint` (`sha256:` of the canonical JSON of the hydrology version, the pipeline, the parameters without `run`, the surface's fingerprint and the rainfall file's hash) and optional `preview` (a model below its quality target) and `notes`. Geometry is in the project CRS (E, N, Z metres, as design linework), never lon/lat. A run with the same id replaces the folder. Results: flood `levelM`, `mode`, `seed?`, `areaM2` (wet cells times the cell area), `volumeM3` (depth below the level summed over wet cells times the cell area), `maxDepthM`, `wetCells`, `outlineAreaM2?`, `outlineRings?`; flow `mode`, `method`, `depressions`, `path?` (`start`, `end`, `lengthM`, `fallM`, `cells`, `leavesSurface`), `outlets?` (`pourPoint`, `outlet?`, `areaM2`, `cells`, `contributingAreaM2?`), `streamAreaM2?`, `streamLinks?`, `streamLengthM?`; rainfall `durationMin`, `frameMin`, `frames[]` (`tMin`, `file`, `view`, `maxDepthM`, `wetAreaM2`), the volumes `rainM3`, `infiltratedM3`, `outflowM3`, `storedM3`, `massErrorPct`, and `peakOutflowM3s`, `peakAtMin`, `finalOutflowM3s`, `maxDepthM`, `steps`, `areaM2`. Read by `survey:readHydroRuns` (`{ projectId }` to `{ runs }`, newest first; packages read in place).
- **Hydrology algorithms and limits** (G10, decision 3; code in `python/src/aio_pipelines/hydro/`, written from the papers, never from GPL code): depressions by Priority-Flood+epsilon (Barnes, Lehman and Mulla 2014), filled or breached along the flood's spill path; D8 and D-infinity (Tarboton 1997); off-grid and nodata neighbours take the local plane's height, so water leaves the surface where the slope carries it; catchments are delineated on D8 receivers (each cell to the first outlet downstream; an outlet snaps to the largest accumulation within 5 m); the default stream threshold is 1% of the area, between 100 m² and 1 ha. Direct rainfall is a local-inertial model (Bates, Horritt and Fewtrell 2010) with the q-centred weighting of de Almeida et al. (2012), a Froude cap of 0.8 at faces (the scheme is for subcritical flow: depth on steep, smooth slopes is overestimated), free outfall at the area's edges and exact mass bookkeeping. Cell limits per run: flood 25 M, flow 4 M (about 1 GB at the limit; routing takes a few seconds per million cells), rainfall 4 M model cells (time grows with cells times steps); a larger area needs a region. WhiteboxTools is not used as a CI oracle (not available offline); the analytic truths of `python/tests/test_hydro.py` are the gate.
- **Haul-road compliance** (`haul.analyse`, `HaulAnalyseParams`): `surface`, `centreline` (drawn (E, N) points, or `{ design, layer }` for a design alignment or polyline layer), `intervalM` (sections every so many metres), `limits` (`minWidthM?`, `maxGradePct?`, `crossFallMinPct?`, `crossFallMaxPct?`, `minBermHeightM?`), `run?`. Per section: running surface edges, width, gradient along, cross fall, superelevation and berm height and width, each against the limits; a results table, map colouring by pass or fail, and a section in the house PDF report.
