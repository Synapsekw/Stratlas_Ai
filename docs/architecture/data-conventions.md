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

## 8. Stockpile volumes

Volumetric projects keep their volumes beside the manifest (schemas in `@aio/schema` `volumes.ts`):

```
<project>/
  volumes.json             aio.volumes/1: piles, toe lines, four bases, fill/cut/net, change
  edits/boundaries.json    aio.boundaries/1: toe lines corrected by hand (written by the app)
```

- Rings (`zoneRing`, `epochs.<epoch>.ring`, edit `ring`) are `[x, z]` in the local frame (section 1). `centreEN` is in the project CRS.
- `captures[]` lists the surveys in order with their short `epoch` key (`e1`, `e2`); optional `layers` names the manifest layers that show each survey. When absent, the terrain mesh of a survey is the mesh layer whose tags name the survey's pile nodes, and its ortho the raster layer whose id or name holds the survey date.
- `grids` locates the source grids the app recomputes volumes on: `piles` (10 cm pile grids, `{id}`), `dsm` (0.4 m site DSM, `{epoch}`) and `coarse` (0.4 m pile masks), all in the Volumetric Survey Kit script format (`window.VS_*` JSON with zlib and base64 grids, decoded in `packages/volumetric/src/model/kitdata.ts`). When absent, readers use the kit layout the importer copies unchanged: `legacy/data/piles/{id}.js`, `legacy/data/dsm_{epoch}.js`, `legacy/data/vol.js`.
- The app reads both files through IPC `project:readVolumes` (validated in main). `edits/boundaries.json` is written only through IPC `project:writeBoundaries` (atomic replace with `.bak`). One edit per pile and epoch; an edit's volumes replace the automatic ones in every register, total and export.
