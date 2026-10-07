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
```

`<dataRoot>` defaults to `E:\Stratlas Data` on the development machine (`STRATLAS_DATA` env var overrides; Settings `dataRoot` in the app). Map packs live in `<dataRoot>/packs/<id>.pmtiles` with `<id>.json` (`MapPackInfo`).

`aio://project/<project-id>/<relative path>` serves any file under the project folder with HTTP range support; `aio://packs/<id>.pmtiles` serves map packs.

Photo files (review copies and their `thumbs/`) store their pixels the way the camera saw them: the original's EXIF Orientation applied, no Orientation tag left, so image +Y is the pose's up (section 3) for every reader (browser, PIL, the pipelines). Importers turn delivered copies that dropped the tag (the HCl kit's Elios 3 thumbnails, Orientation 3) and every image sighting on them (`@aio/project` `orientation.ts`); `pnpm reorient:photos` (packages/project) repairs an existing project against its camera originals, with a backup.

`aio://thumb/<project-id>/<relative path>` serves a small thumbnail of an image for grids (Media): the project's own `<dir>/thumbs/<name>.jpg` beside the image (`photos/thumbs/p001.jpg` for `photos/p001.jpg`), else one cached in the app profile (userData `cache/thumbs/`, keyed by project location, path, size and date), else 404. On a 404 the renderer makes a 320 px thumbnail in a worker and stores it with IPC `thumbs:put`. Thumbnails are never written into a project folder.

Reports Stratlas generates (issue register PDF) carry the person's own branding from Settings, Report branding (`Settings.reportBranding`; the logo is copied to userData `branding/` and served as `aio://branding/<file>`), or none. A manifest's `brand` (a client brand from an import or an older wizard) is kept but never used for reports. Delivered PDFs under `report/` are shown as delivered.

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

Every change to a folder project is an op in a signed, hash-chained, per-device journal (schema in `@aio/schema` `journal.ts` and `identity.ts`; code in `@aio/journal`; ADR 0005). Older builds ignore every path below; `team.json` exists only for shared projects (section 19).

```
<project>/
  journal/devices/<deviceId>.json          aio.device/1: public key, actor, name, initials, app, certs; self-signed
  journal/ops/<chainId>/000001.jsonl       aio.op/1, one op per line; a new segment at 4 MB or 10,000 ops
  journal/checkpoints/<ms>.<counter>.<chainId>.json   aio.checkpoint/1: heads of every chain, count, Merkle root; signed
<userData>/
  identity.json                            aio.identity/1: actor, name, initials, email?
  team/projects.json                       aio.team-config/1: per project folder path, replica id, sync mode, hub path, server, fetch policies, peer heads, journal on or off
  journal-cache/<key>/                     projection snapshot, clocks, blob index, conflicts (rebuildable, never the truth)
```

- **Ids.** Actor `a_` plus 26 base32 letters (128 random bits), permanent. Device `d_` plus the base32 SHA-256 of the raw Ed25519 public key (52 letters). Replica `r_` plus 16 letters, one per project folder path in userData, so a copied or moved folder starts a new chain. Chain `<deviceId>.<replicaId>`. Base32 is RFC 4648, lower case, no padding (safe as Windows file names).
- **Clock.** `hlc` is `<ms 13 digits>.<counter 4 digits>.<deviceId>`; readings compare as strings. Last-writer decisions use it, never wall time alone. A remote reading 5 minutes ahead raises a notice; 24 hours ahead holds the op in the inbox.
- **Op fields.** `v` (1), `id`, `chain`, `dev`, `act`, `seq` (from 1), `hlc`, `prev` (id of `seq - 1`, null for seq 1; the first op of a segment links to the last op of the previous one), `deps?` (heads of the other chains this device had seen), `kind`, `target` (`{ rec, id, in? }`), `base?` (content hash of the record before), `ph`, `payload?`, `via?` (`agent`, `pipeline`, `import` or `external`), `label?` (the editor's command label), `sig?`.
- **Hashes.** SHA-256, lower-case hex, over RFC 8785 canonical JSON (JCS). `ph` = hash of the payload. `id` = hash of the op without `id`, `payload` and `sig` (so it covers `ph`). Verification works on the raw parsed JSON of each line, never on a parser's output; op schemas keep unknown keys so a newer op still hashes the same in an older reader.
- **Signatures.** Ed25519 through `node:crypto` over the UTF-8 text `<domain>\n<hash>`, base64url without padding (86 characters); keys are raw 32-byte public keys in base64url (43). Domains: `aio.op/1` (over `id`), `aio.checkpoint/1`, `aio.device/1` and `aio.cert/1` (over the hash of the record without `sig`), `aio.idcard/1`, `aio.exchange/1`, `aio.receipt/1`, `aio.request/1`. An op without `sig` is "unsigned" (the vault failed): still chained, and Verify says so.
- **Kinds.** Issues `issue.create|patch|delete|restore|sighting.add|sighting.remove|status|merge|recode`; collaboration (section 18); other records `change.review`, `detection.review`, `procmodel.part`, `manifest.entry`, `boundary.edit`, `narrative.version`; `blob.add` (section 20); team `member.add|role|remove|link`, `device.revoke`, `policy.set`, `project.share`; events `package.export`, `exchange.import`, `conflict.resolve`, `record.external`, `checkpoint`; the journal `journal.off|on`, `op.redact`. Readers accept any dotted lower-case kind and record kind: an unknown one is kept, verified and shown as "unknown change". `OP_PAYLOADS` and `OP_PERMISSION` give each known kind its payload schema and the permission it needs.
- **Writes.** Main appends the op and fsyncs, then writes the state file atomically (`writeJsonAtomic`, `.bak`). On open, a state file whose hash equals the `base` of the last op gets that op re-applied (crash recovery); any other difference becomes `record.external` ("changed outside Stratlas"). Pipelines: content hashes before and after a job give ops with `via.pipeline`, signed by the device of the person who started it. Packages are read-only: their journal is read and verified, never appended.
- **Redaction.** An owner's `op.redact` (or `comment.redact` with its `ops`) names the ops whose payload is removed from every copy; `ph` stays, so the chain still verifies, and the audit shows "redacted by X on date". A payload missing without such an op is a Verify problem.
- **Verify** names each problem with file and line (`VerifyCode`): `parse`, `hash-mismatch` (an edited line), `payload-hash` (an edited payload), `payload-missing`, `chain-gap` (a removed line), `order`, `truncated` (a tail cut off that `deps` or a checkpoint references), `segment-missing`, `fork` (two ops with one chain and seq: a copied folder kept writing), `bad-signature`, `unsigned`, `unknown-device`, `revoked-device`, `checkpoint-mismatch`, `clock-ahead`. The project still opens and works.
- **Checkpoints** every 500 ops and at every exchange or sync: the heads of every chain, the op count and a Merkle root (leaf SHA-256 of `<chain> <seq> <id>`, heads sorted by chain, node SHA-256 of the two child hex strings, an odd node carried up). The file name drops the device from the clock reading to keep deep project paths under Windows limits.
- **Decision 8.** The journal is on for every folder project (`JournalPolicy` defaults); a private project may switch it off with a recorded `journal.off`, a team project may not.
- **Golden fixtures** in `packages/schema/src/__fixtures__/journal/` (`pnpm fixtures:journal`, deterministic): `valid/` (three fictional devices with TEST-ONLY keys in `TEST-ONLY-KEYS.json`), `tampered/<case>/` and `cases.json` (the problem Verify must name for each case). Prettier never touches them.
- **Exports.** `audit-csv` (UTF-8 with BOM) and `audit-json` (signed, with every device key and the checkpoints, checked by `tools/audit-verify/verify.mjs`) fall under the package export kind `files`, checked by format (their names would read as issue exports). Reports print the audit head (root, count, verified) in the footer.

## 18. Collaboration ops and projections (M9)

Assignments, comments, approvals, members and sign-offs exist only as journal ops and their projection (`@aio/schema` `collab.ts`, `@aio/collab`). M9 adds no field to `Issue` (an 0.8 build strips unknown keys on save), nor to `ChangeReview`, `Detection`, `BoundaryEdit`, `ProcPart` or `NarrativeFile` (strict: an 0.8 build would refuse the file); a test pins their 0.8 keys. The free-text author fields keep receiving the display name.

- **Targets** `{ kind, id, in? }`: `issue`, `change-item` (`in`: change set id), `change-set`, `detection-pass`, `part` (`in`: model id), `model`, `report`, `project`.
- **Comments** (`comment.add|edit|delete|redact`): id `cm_` plus 16 base32 letters, markdown-lite text up to 10,000 characters (links shown as text, never fetched; RTL and Arabic allowed), `visibility` `team` (default) or `client`, `mentions` (actor ids), optional saved view (camera, time, capture, layer), `replyTo`. Edits are versions by the author; deletes are tombstones; redaction by an owner.
- **Assignment** (`assign.set`): target, assignee (null clears), optional due date and note. Last writer wins; two different concurrent assignees are a conflict.
- **Approvals** (`approval.add|withdraw`): id `ap_` plus 16 letters, `decision` `approve`, `changes-requested` (a comment is required) or `accept` (a client's acceptance: recorded, never a status change), and `contentHash`, the target's material content when signed. An approval counts only while that hash still matches.
- **Policy** (`policy.set`, owner only; `TeamPolicy`): `approval` (`required` 1 to 5, default 1; `fourEyes` default on; `closeBy` default `owner`; `viewersMayComment` default off; `clientAcceptance` default `record`; `materialFields` default class, severity, sightings, measurements, status), `minVerification` (default `self`), `packageHistory` (default `summary`). A project without a policy keeps 0.8's free status stepping.
- **Status.** `approved` is reached when `required` distinct eligible approvals exist (owner or reviewer; with four-eyes, not the issue's creator); the approver whose approval completed it writes the status op. A material edit after approval voids the approvals and returns the status to `reviewed`, with an op. Batch sign-offs use the same approvals on a change set, a detection pass, a model or the report (bound to the content hash of the report's inputs).
- **Roles** (`Role`, `PERMISSIONS`, `OP_PERMISSION`): owner, reviewer, viewer, client. In file and hub mode an op beyond the actor's role at its clock reading is quarantined on import (kept, not applied, listed); the server refuses it with 403. The agent may comment and list work, never approve.
- **Projection** (`CollabState`, `collab:read`) is rebuilt from the journal; it is never stored as truth.

## 19. Exchange files and hub folders (M9)

Moving ops and blobs between copies with no server (`@aio/schema` `exchange.ts` and `sync.ts`, `@aio/sync`). Transport settings are per machine (drive letters and server addresses differ), so they live in userData `team/projects.json`, never in the project.

```
<project>/team.json             aio.team/1: teamProjectId (t_ + 26 base32), name, createdAt, createdBy (shared projects only)
<name>.aiosync                  ZIP64, store mode, optional AES-256 (passphrase)
  aio-exchange.json             aio.exchange/1 header, signed by the sender's device
  journal/devices/<deviceId>.json
  journal/ops/<chainId>/<from>-<to>.jsonl    six-digit seqs, inclusive
  blobs/<aa>/<sha256>           bundles only
<hub>/aio-hub.json              aio.hub/1 (brand-neutral name, like aio-package.json)
  projects/<teamProjectId>/devices/<deviceId>.json
  projects/<teamProjectId>/ops/<chainId>/<from>-<to>.jsonl
  projects/<teamProjectId>/blobs/<aa>/<sha256>
  projects/<teamProjectId>/presence/<deviceId>.json   aio.presence/1, a heartbeat; ignored after 2 minutes
<name>.aioid                    aio.idcard/1 identity card (section 17), self-signed
```

- **Kinds.** `patch` (ops since the recipient's known heads, remembered per peer, or since a date), `bundle` (plus the blobs the recipient lacks), `reply` (from a customer package in the free player: comment and acceptance ops only, signed by a client device key made on the spot, valid only when the package header's `reply` allows it).
- **Header** (`ExchangeHeader`): `id` (`x_` plus 16 letters; a second import says "already applied"), `kind`, `teamProjectId`, `createdAt`, `from` (actor, device, name, app), `to?`, `since` (heads, a date, or all), `chains` (range and member per chain), `heads`, `blobs`, `counts`, `package?` (a reply: the package it answers), `encrypted`, `sig`.
- **Import** previews first (`ExchangePreview`: signature, sender, ops by kind, new and already-held ops, expected conflicts, blobs and size), then applies atomically and idempotently (ops dedupe by id). Ops after a gap are held ("needs changes from <device> up to #N"). Member names outside the layout above (`..`, absolute paths, drive letters, backslashes, links, duplicates, declared sizes beyond the file) are refused with an exact error (`@aio/sync` `isSafeMemberName`).
- **Hubs.** Each device writes only its own files that never change (temp name, then rename), so no lock is needed and cloud-drive clients never make conflicted copies of them; any found are ingested and reported. Auto-sync runs on open, after saves (10 s debounce), every `Settings.team.intervalMin` minutes when `autoSync` is on, and on focus. An unreachable hub never stops local work.
- **Packages.** `PackageHeader.reply?` (`{ teamProjectId, ownerKey, comments, acceptance }`) and `journal?` (`full` or `summary`); an 0.8 player strips both. Customer packages carry the signed audit summary by default (decision 8). Extract to edit keeps `teamProjectId` and starts a new replica.
- **Folders opened in place on a share** (any project, shared or not): writers compare the hash they last read before writing, merge through the rules when the file changed ("F03 was changed by <name>; merged"), and hold a lease file (`<file>.lock`, exclusive create, heartbeat, taken over after 2 minutes of silence).
- **Team server** (`aio.sync/1`, preview): the same ops and blobs over HTTPS (`SYNC_ROUTES`), every request signed by the device key (RFC 9421, no bearer tokens), the certificate fingerprint pinned at enrolment, receipts (`aio.receipt/1`) countersigning accepted ops.

## 20. Binaries by content (M9)

Large files are known by their SHA-256 so a copy can open before they arrive (`@aio/schema` `blobs.ts`, `@aio/sync/blobs`).

- **Registration.** Every binary a writer produces (import, build, pipeline) is a `blob.add` op: `{ sha256, size, path, role: source | derived, layer? }`; `path` stays the project-relative path layers use (`AssetRef` already allows `{ hash }`). An existing project is indexed once when first shared, by a resumable job in the data process, cached by path, size and mtime.
- **Fetch policy per layer and machine** (`FetchPolicy`): `always` (posters, small rasters, vectors), `on-open` (photo review copies), `on-demand` (any file over 200 MB: video, COPC, PMTiles, GLB), `stream` (read from the hub path on a LAN through `aio://`, no copy). Defaults: `@aio/sync` `defaultFetchPolicy`.
- **Missing is a normal state** (`BlobState`: present, missing, partial, stale, streaming). `aio://` answers a 404 with the header `x-aio-blob: missing <sha256> <size>`; the layer shows "Not on this computer (12.4 GB). Download", and no adapter throws.
- **Where blobs live**: `blobs/<aa>/<sha256>` in a hub, a server store and a bundle; downloaded copies for a working copy in userData `blobs/` (size cap `Settings.team.blobCacheGb`; only blobs also held by the hub or server are evicted).
- **Transfers.** Hub: copy to a temp name, rename, verify the hash. Server: HTTP Range in 8 MB parts, resumable, verified. Equal hashes are stored once per hub or server. Whole-file hashing only in M9.
