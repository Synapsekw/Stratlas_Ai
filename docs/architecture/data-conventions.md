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
```

`<dataRoot>` defaults to `E:\Stratlas Data` on the development machine (`STRATLAS_DATA` env var overrides; Settings `dataRoot` in the app). Map packs live in `<dataRoot>/packs/<id>.pmtiles` with `<id>.json` (`MapPackInfo`).

`aio://project/<project-id>/<relative path>` serves any file under the project folder with HTTP range support; `aio://packs/<id>.pmtiles` serves map packs.

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
