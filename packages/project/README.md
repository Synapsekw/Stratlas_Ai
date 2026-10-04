# @aio/project

Project packages: read, write, importers for kit formats, exports.

See `docs/architecture/SPEC.md` section 2 for ownership and dependencies. Public API: `src/index.ts`
(renderer safe) and `src/import/index.ts` (Node only: file system, ffmpeg).

## Packages (`@aio/project/package`, stream N4)

A `.aio` package is one file holding a whole project for delivery (BLD-9) and the read-only
player (APP-5). Node only.

- **Format:** ZIP with ZIP64 records, **store mode only** (no compression), so every member's
  bytes sit verbatim in the file and the app serves them by offset with HTTP ranges (video
  seeking, COPC, tiles) without unpacking. Member names are the project's relative paths
  (UTF-8). Order: `aio-package.json`, `manifest.json`, `issues.json`, `thumbnail.jpg`, then the
  rest by path.
- **Header:** `aio-package.json` (`aio.package/1`, `PackageHeader` in `@aio/schema`): `readOnly`
  (default true), `aiPolicy` (default `forbid`), allowed `exports`, `excludedLayers`, optional
  `welcome` text and tips. A package without a header opens as a read-only customer package.
- **Encryption (optional):** WinZip AES-256, AE-2 (method 99, extra `0x9901`): per-member salt,
  PBKDF2-HMAC-SHA1 (1000 rounds) keys, AES-CTR with a little-endian counter (any byte range
  decrypts on its own) and a 10-byte HMAC-SHA1 auth code. 7-Zip and libarchive open it with the
  passphrase. File names stay readable in the directory; contents do not. Whole-member reads
  (header, manifest, issues) verify the auth code; ranged reads cannot and do not.
- **Layers:** `planPackage` maps files to layers (sources, posters, flight files, photo
  thumbnails, and the folder beside an index for tile pyramids, PNG clouds and legacy viewers).
  A file shared by several layers stays while any of them stays; files no layer owns (issues,
  masks, report, thumbnail) always go. Backups, temp files, `IMPORT-REPORT.md` and other `.aio`
  files never do. The plan reports bytes per layer for the size report.
- **Writer:** `writeZip` streams 4 MB chunks to `<out>.partial` with positional writes, patches
  each CRC in place, reports progress, honours an `AbortSignal`, and renames on success; a
  cancelled or failed export leaves nothing behind. `exportPackage` checks free space first.
- **Reader:** `openZip` indexes the central directory (ZIP64 aware), rejects compressed or
  foreign-encrypted members and unsafe names; `openPackage` unlocks, validates the header and
  manifest, and names any layer file that is missing.

Legacy layers that the importer hard-linked into `legacy/` take real space in a package (the
size report shows it); leave the legacy layer out for a smaller delivery. Map packs are not
packaged.

## Exports (stream N3)

`src/export/index.ts` (`@aio/project/export`, pure, renderer safe) builds every issue export from
a manifest and its issues; `src/export/node.ts` (`@aio/project/export/node`) adds PNG masks and a
streaming store-mode ZIP. The desktop app runs them in an export utility process
(`apps/desktop/src/main/exports/`) behind `export:run`, so large registers never block the UI.

| Format       | Content                                                                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Issues CSV   | `CSV_COLUMNS` (stable, append only), UTF-8 with BOM, CRLF; severity and class labels from the models, sightings count, zone, position in the project CRS and WGS84                                            |
| GeoJSON      | RFC 7946, one feature per map, mesh or point-cloud sighting in WGS84 (heights in metres); properties carry code, labels, severity colour and project CRS easting and northing                                 |
| COCO         | Categories from the class catalogue (ids from 1), images are the review copies (size read from the file header), boxes, rotated boxes and polygons as segmentation, points as 1 px boxes; masks go to the ZIP |
| Kit JSON     | Asset Inspection Kit `assessment.json` shape (`photos` status, `findings` with corner boxes, `group` = issue code) plus an `issues` list with positions                                                       |
| Masks ZIP    | Kit masks and overlays where the import brought them, else a class-index mask and RGBA overlay drawn from the boxes, polygons and points; `masks.json` indexes photos, files and issues                       |
| Report model | `reportModel`: counts by severity, class (catalogue) and zone (`issueZone` reads the note), register rows worst first with best photo and 3D position; no em or en dashes (`noDashes`)                        |

## Importers (stream S10)

Convert staged source folders into native packages laid out per `docs/architecture/data-conventions.md`.

```bash
cd packages/project
pnpm import:hcl      # E:\Stratlas Data\sources\hcl    -> E:\Stratlas Data\projects\hcl
pnpm import:alzour   # E:\Stratlas Data\sources\alzour -> E:\Stratlas Data\projects\alzour
pnpm import:ebsm     # Asset Inspection Kit offline build, EBSM flare stack (EPSG 32639)
pnpm import:damac    # Asset Inspection Kit offline build, DAMAC tower facade (EPSG 32640)

pnpm import:masafi   # E:\Stratlas Data\sources\masafi -> E:\Stratlas Data\projects\masafi

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

### Asset Inspection Kit offline builds (EBSM, DAMAC and later jobs)

`src/import/aik.ts` (I/O) and `aik-model.ts` (pure, tested) read any kit offline build: the
`window.KIT` document in `OPEN ... Review.html`, the `data/*.js` chunk scripts
(`__kitData("key","base64")`, gzip when the kit marks `gz`) and, when present, `_rebuild/job/`
(`cameras.json` for the photo kind, `surface.json` patches, `assessment.json` ids, `job.yaml` cover).

- Frame: kit (X north, Y up, Z east, origin at the asset base) to local by
  `Ry(90 deg + theta)`, where theta is fitted from every photo's kit position against its GPS in
  the project UTM zone (grid convergence and kit yaw). The origin is where the kit origin lands;
  H is the median of GPS altitude minus kit height. Baked into the mesh `transform`.
- Mesh: `downloads/*.glb` as delivered (the viewer's `data/model.js` is the same GLB, gzip-wrapped).
- Photos: kit 2560 px review copies with poses (position, target, up; pinhole kit hfov) and 480 px
  thumbnails; H20T thermal frames (`kind: "T"`) in a second photo layer. `photos: 'reviewed'` keeps
  photos with a finding or uncertain area plus the report cover.
- Masks: `photos/masks/<id>_mask.png` (class index), `_overlay.png`, `_uncertain_mask.png` and
  `_uncertain_overlay.png`, cut from the viewer's mask sprites.
- Severity model and class catalogue from the kit profile. Issues: one per finding (photo unit,
  F codes) or per defect (region unit, D codes, worst severity) with boxes, masks and mesh
  sightings (`spatch` to `models/patches/<fid>.json` decals in the local frame, or `spoint` pins);
  one `uncertain` issue per uncertain-only photo (U codes).
- `legacy/`: the whole offline viewer as hard links (no extra space on the same volume), layer
  `legacy` with `viewer: 'aik'`. `IMPORT-REPORT.md` compares every count with the kit stats.

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

### Masafi (Volumetric Survey Kit stockpile review)

Source: the kit's offline build (`job.json`, `data/*.js` with `window.VS_*` grids, `work/dsm_<epoch>.npy`,
`tiles/<epoch>/<z>/<x>_<y>.webp`, the offline viewer HTML, PDF and register CSV). `src/import/masafi.ts`:

- Frame: origin at the centre of the job grid, height the lowest DSM value floored; everything hangs
  off the grid's top-left corner as in the kit.
- Terrain per date: GLB (`glb.ts`) from the 0.1 m DSM block-averaged to a 0.5 m lattice
  (`terrain.ts`): ground at 1 m, one node per pile (`Pxx_<epoch>`, zone plus a buffer) at 0.5 m with
  the toe line as a line primitive; fine and coarse cells meet without cracks. Textured with the kit's
  site texture. Pile nodes are mesh tags (ID, default-base volume) and show as callouts.
- Ortho per date: `kit-pyramid` of the finest four kit levels, every level on one whole-tile window.
- `volumes.json` (`aio.volumes/1`): every pile, date and base (tin, plane, avg, low) recomputed from
  the 10 cm pile grids (`vsdata.ts`, the viewer's maths) and checked against `site.js`; change
  between dates; totals, yard polygon and excluded zones. Kept for a future native volumetric panel.
- Legacy layer (`viewer: "volumetric"`): the offline viewer with its data under `legacy/`.
- No issues; severity model "Stockpile" (1 to 3) and classes spillage, unsafe slope, encroachment.

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
