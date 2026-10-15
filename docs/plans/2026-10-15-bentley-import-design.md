# Bentley import: design

Date: 15 Oct 2026. Branch `feat/bentley-import`. Status: written after brainstorming, waiting for founder review.

## Goal

Read what a Bentley iTwin Capture Modeler (formerly ContextCapture) job delivers, so that an inspection job aligned elsewhere can be inspected in Quadrion without running ODM:

- a `.zpc` export (a ZIP of LAZ tiles) becomes one point cloud layer;
- a BlocksExchange AT export (`.xml`) plus the folder of original photos becomes a photos layer, each photo placed by its calibrated pose.

Success means:

1. A `.zpc` added through Add data shows as one point cloud, in the right place, whatever its size.
2. An AT `.xml` added through Add data asks for the photo folder, matches photos by file name and places each photo where Bentley put it; clicking a camera opens its photo, as with ODM photos.
3. Cloud and photos from the same job line up, so findings-on-model can place findings from those photos onto that cloud (posed photos and a model in the same project frame, `Layer.capture` set on both).

Reference job: a telecom tower orbit flight, 560 DJI M4E photos (5280 x 3956), AT in WGS 84 / UTM 40N (EPSG:32640), a 1.04 GB `.zpc` of 4 LAZ tiles. Client data, never committed.

## Decisions (founder, 15 Oct)

| Question      | Decision                                                                                                                                                                           |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Purpose       | Inspection: cloud plus photos at their real camera positions. Running our products from Bentley's AT is later.                                                                     |
| Add data flow | Separate imports: `.zpc` on its own, `.xml` on its own (asks for the photo folder), ortho `.tif` as today.                                                                         |
| Lens detail   | Bentley's principal point and distortion are kept as optional fields on `PhotoRef.lens` (agreed with the findings-on-model and engineering-model sessions). Nobody reads them yet. |

## What exists today

- Point clouds: Add data accepts `las, laz, e57`; job `pointcloud.to_copc` runs PDAL on a single `src` and writes `clouds/<name>.copc.laz`. Writing COPC through PDAL is slow above about 10 M points per run; `tools/pointcloud/merge-copc.mjs` merges COPC files cell by cell (dev tooling only).
- Imported alignment: `opf.import` (`python/src/aio_pipelines/opf/`) writes a processing run under `photogrammetry/<run>/` as if we had aligned (`run.json`, COLMAP text `sparse/` in the grid frame, `frame.json`, `photos.json`) and a photos layer placed by pose (`pos`, `q`, `lens`). `opf/safety.py` guards paths. Data conventions section 21.
- Camera model: `photo/model.py` (OPENCV family), `photo/scene.py` (sparse model read/write), `photo/crs.py` and geodesy for CRS to grid and the project frame.

## Design

### 1. `.zpc` to one cloud (`pointcloud.to_copc` extended)

- `.zpc` joins the Add data filter and the Python `CLOUD_EXTENSIONS`.
- The job recognises a `.zpc` by extension and by its ZIP signature. It opens it with `zipfile`, keeps only `.las`/`.laz` members, and refuses unsafe names (absolute paths, `..`, as `opf/safety.py` does). It extracts the members into the job's temp folder and never writes beside the source.
- Each tile is read and reprojected to the project CRS as a single LAZ is today, then the tiles are merged into one COPC layer. To stay fast at hundreds of millions of points, the per-tile COPC conversion and the cell-wise merge from `merge-copc.mjs` move into the Python pipeline (`pointcloud.merge`). The point budget, timing and memory are measured on the reference job and recorded in the plan.
- One layer, named after the `.zpc` file. `Layer.capture` is taken from the LAS header date when present; otherwise it is left for the person to set, as for any cloud.
- Progress is reported per tile. A corrupt tile fails the job with the tile's name and no partial layer.

No new job name or parameter: `src` may now be a `.zpc`. The job's input validation accepts it.

### 2. AT XML to a photos layer (`bentley.import`, new job)

Parser (`python/src/aio_pipelines/bentley/`):

- Reads BlocksExchange 3.x: the SRS list, then for each photogroup its image size, focal length (mm) with sensor size (mm) or focal in pixels, principal point, distortion (K1, K2, K3, P1, P2), and camera orientation (`XRightYDown` only; anything else is refused with a clear message). For each photo it reads `ImagePath`, the pose rotation matrix and centre, and `ExifData/DateTimeOriginal`.
- Photos without a pose (not aligned) are skipped and counted.
- Poses are in the block's SRS (projected, EPSG code). They are moved to the project frame with the existing CRS and geodesy code, the same path `opf.import` takes. A block in a local or unknown SRS is refused.
- The rotation is world to camera, as in BlocksExchange. It is converted to our `q` in the project frame and checked by a round trip test on the reference block.

Photo matching:

- The person picks the photo folder. Photos are matched by file name (case-insensitive), searching the folder and its subfolders, because the `ImagePath` drive (for example `R:/...`) will not exist here. Duplicate names are matched on the last two path segments; anything still ambiguous counts as missing.
- The result reports matched, missing and unaligned counts. The job goes ahead when at least one photo matches. Missing photos are left out of the layer and listed in the job log.

Output, following `opf.import`:

- A run `photogrammetry/<run>/` with `run.json` (source `bentley`), `sparse/` (cameras as OPENCV with the Bentley intrinsics), `frame.json` and `photos.json`.
- A photos layer placed by pose: `PhotoRef.pos`, `q` and `lens` (pinhole from focal and image size, as today), plus the new optional lens fields below. `Layer.capture` is the earliest `DateTimeOriginal` of the matched photos.
- Photos are referenced where they are, not copied, as for every photo import.

Add data: `.xml` joins the filter. When an `.xml` is picked, the app sniffs for `<BlocksExchange`. If it is a BlocksExchange file, it asks for the photo folder and runs `bentley.import`. Any other XML gets a "not a supported XML file" message.

### 3. Contract (`@aio/schema`)

- `PhotoRef.lens` gains optional fields: `cx`, `cy` (principal point, pixels from the top-left), `k1`, `k2`, `k3`, `p1`, `p2` (OpenCV convention, normalised coordinates). The Bentley values are converted to that convention, and a test on the reference block checks that a projected tie point matches the opencv projection. All fields are optional, so old files stay valid and nothing reads them yet.
- New job name `bentley.import` with params `{ xml, photos, name? }` in `jobs.ts` (name list, catalogue, params map), the renderer job map and `main/builderJobs.ts`.
- One row in `docs/architecture/contract-changes.md`, and a new data conventions section for the Bentley run and the `.zpc` input.

### 4. Pairing the cloud with the photos

Nothing links the two layers: they line up because both come from the same AT and are placed in the project frame. The findings-on-model picker lists layers of the same date first, so both get `Layer.capture`. A `.zpc` imported on its own stays an ordinary cloud source. Storing it inside the Bentley run (so it reads as a reconstruction) is left out: the jobs are separate and nothing needs it yet.

## Out of scope

Running ODM products from Bentley's AT, Bentley meshes (3MX, 3SM, OBJ exports), tie points and control points from the XML (the reference export has none), principal point and distortion in any projection, a combined "Bentley export" dialog, and non-BlocksExchange XML.

## Known limits

- Photos are matched only by file name; renamed photos do not match.
- Only `XRightYDown` cameras and projected SRSs with an EPSG code are supported.
- The merged cloud keeps the LAS dimensions PDAL carries through (XYZ, RGB, intensity, classification).

## Testing

- Python unit: BlocksExchange parser on a small synthetic block (SRS, photogroup, 3 photos, one without a pose); pose conversion round trip and a known-point projection; the lens convention conversion; photo matching (subfolders, case, duplicates, missing); `.zpc` handling with a 2-tile synthetic ZIP (merge count equals the sum, bounds), with zip-slip names refused and a corrupt tile failing cleanly.
- TS unit: schema round trip with and without the new lens fields; Add data routing of `.zpc` and `.xml` (BlocksExchange and other XML).
- E2E: new `apps/desktop/e2e/bentley-import.spec.ts` on small synthetic fixtures (a tiny `.zpc` and an AT XML with 3 generated photos): import both, the cloud layer appears, the photos layer shows 3 cameras, and clicking one opens the photo. Run the way CI runs it.
- Manual: the reference job on this PC (not in CI). Record the cloud import time, the point count, matched photos 560 of 560, and that cameras sit around the cloud.
