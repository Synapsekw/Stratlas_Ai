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
pnpm import:ebsm     # Asset Inspection Kit offline build, EBSM flare stack (EPSG 32639)
pnpm import:damac    # Asset Inspection Kit offline build, DAMAC tower facade (EPSG 32640)
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
