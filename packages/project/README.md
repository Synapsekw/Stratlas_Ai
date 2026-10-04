# @aio/project

Project packages: read, write, importers for kit formats, exports.

See `docs/architecture/SPEC.md` section 2 for ownership and dependencies. Public API: `src/index.ts`
(renderer safe) and `src/import/index.ts` (Node only: file system, ffmpeg).

## Importers (stream S10)

Convert staged source folders into native packages laid out per `docs/architecture/data-conventions.md`.

```bash
cd packages/project
pnpm import:hcl      # E:\Stratlas Data\sources\hcl    -> E:\Stratlas Data\projects\hcl
pnpm import:alzour   # E:\Stratlas Data\sources\alzour -> E:\Stratlas Data\projects\alzour
pnpm import:ringroad # E:\Stratlas Data\sources\ringroad -> E:\Stratlas Data\projects\ringroad
# options: --src <folder> --out <folder>; STRATLAS_DATA overrides the data root
```

Requirements: `ffmpeg` and `ffprobe` on `PATH` (or `FFMPEG` / `FFPROBE`) for posters, review copies
and, only when a codec does not play in Chromium, H.264 transcodes.

Re-runs are incremental: copies keep the source mtime and are skipped when unchanged, generated
files are skipped when byte-identical, derived files when newer than their sources. Each package
gets an `IMPORT-REPORT.md` with counts, sizes, the frame check and warnings.

### Formats written

- `kit-packed` cloud: N x (int16 x, y, z) little-endian millimetres in the local frame, then
  N x uint8 intensity (planar, as the Asset Inspection Kit and the design fixture `cloud.bin`).
- `png-packed` cloud index (`aio.pngcloud/1`): each chunk PNG (RGB) holds a byte stream of 9 planes
  of n bytes: x lo, x hi, y lo, y hi, z lo, z hi, r, g, b. Position in the local frame
  `= quant.offset + quant.scale * u` (the Al-Zour viewer rule `o + q * u`); chunk `bounds` is the
  tight box, `lod` 0 the overview (see `packages/pointcloud/README.md`).
- Flight files: `aio.flight/1`, optional top-level `name`. Clips cut from one drone flight share
  one file (same `src` and `startUtcMs`) and differ by `offsetMs`, so the app groups them.
- `kit-pyramid` rasters (`aio.tiles/1`): every level spans the same `corners`, tiles are square
  and edge tiles are padded (top-left anchored) so all tiles of a level have one ground size.

### Al-Zour (plant twin artifact)

Source: the staged artifact (`INVENTORY.md`, `blob-map.json`, published files plus asset-store blobs
under `_blob/`, `plant.glb` decoded from `model_glb_zip.b64.txt`). `src/import/alzour.ts`:

- Frame: rigid plant grid to UTM-39 fit from the GLB node extras (`plant.ts`, `fit.ts`), origin at
  plant E 1300 / N 450, height 100 on the plant datum (local `y = EL - 100`). The GLB is copied and
  the turn baked into the mesh `transform`; tags from the asset register with the area group label.
- Ortho: `kit-pyramid` of the 32 cm (z0) and 8 cm (z2) tiles; missing fine tiles are cut from z0.
  No-data keeps alpha 0 with the sea colour under it (the 3D raster adapter draws tiles opaque).
- Plot plans: overall plan as a two-level pyramid on the viewer's tile corners (the report gives the
  worst corner offset), area plans as `image` rasters, both as PNG line art with alpha
  (`lineArtToAlpha`: own alpha, or a black or white ground made transparent; monochrome lines take
  the viewer's red), drawn just above the ortho. Street map: the Mapbox mosaics placed on one canvas
  (`image` raster). Raster files an earlier run wrote and this one does not are pruned.
- Point cloud: every `pc.json` chunk turned into the local frame and re-quantised (`pngcloud.ts`).
- Clips: one `aio.flight/1` per drone flight; lens pinhole 83 deg (16:9 clips narrower).
- Photos and panoramas with poses; wide panorama coverage in `panoramas/panoramas.json`.
- Checks in `IMPORT-REPORT.md`: frame fit residuals, pose round trip, view-axis ground hits and
  assets in frame for every clip, LNG tanks in frame for the two design clips, and a comparison
  with the design clip paths when `docs/design/assets/alzour` is present.

### 1st Ring Road (road review)

Source: the Leaflet road review (`1st Ring Road Review.html`, `data/defects.js`, `data/grid.js`,
`_build/crops.json`, `ortho/` tile bundles, `closeups/`, `lib/`). `src/import/ringroad.ts`:

- Frame: EPSG 32638 (UTM 38N), origin at the corridor centre, ground at `y = 0`.
- Ortho: the review's Web Mercator tiles (`ortho/b13`, `ortho/b18`: `RRT("z/x/y",{...base64
WebP})` script bundles, z13 to z22) resampled into a `kit-pyramid` aligned to UTM: 8 levels of
  1024 px WebP tiles, 3.25 cm at level 7 (`ringroad-tiles.ts`, `ringroad-ortho.ts`). One affine
  for the whole Mercator grid would miss by about 0.3 m, so each output tile has its own affine
  (exact to 0.01 px) and is resampled bilinearly on premultiplied colour. Re-runs keep the tiles
  while the bundles are unchanged (`rasters/ortho/source.json`).
- Issues: one per defect polygon, code `D` + FID, class = defect type, severity model "Road
  distress (ASTM D6433)" with stage Few, Intermediate, Extensive as Low, Medium, High; a map
  sighting (GeoJSON polygon, lon/lat) and the viewer outline on the close-up (photos layer
  `closeups`).
- `road.json` (`aio.road/1`): centreline in the local frame with chainage, network, section and
  sample unit PCI (Low, Medium, High) with deducts on the 15 m UTM grid, density grids; plus
  `road/centreline.geojson` and `road/pci-units.geojson` for map overlays.
- Legacy layer (`viewer: 'road'`): the review page under `legacy/` with its data, close-ups and an
  `ortho-hd/` folder rebuilt from the bundles (the page's own tile format), so it runs unchanged.
- Checks in `IMPORT-REPORT.md`: issue count, lon/lat to UTM round trip of the viewer centroids,
  close-up outlines against the polygons, and the ortho against the close-ups (cut from the 1.25 cm
  GeoTIFF) by normalised cross correlation.
