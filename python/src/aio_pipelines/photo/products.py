"""photo.products: dense cloud (COPC), DSM and DTM, orthomosaic and textured mesh, as new layers.

Parameters as ``PhotoProductsParams`` in ``@aio/schema`` ``jobs.ts``. From an aligned run
(``photogrammetry/<run>/``: ``run.json`` and the sparse model of ``photo.align``,
``photo.georef`` or ``opf.import``: ``sparse/`` in the grid frame with ``frame.json`` and
``photos.json``, read by ``scene.load_run``), one job step per stage, each resumable (the runtime
skips finished steps) and cancellable, with progress per stage:

| Step      | Makes                                                                        |
| --------- | ---------------------------------------------------------------------------- |
| prepare   | settings (cell sizes, matching size), disk and tool checks                   |
| dense     | a depth map per photo (``dense.py``, semi-global matching on the CPU)        |
| fuse      | the dense cloud: consistent points, voxel-averaged, in ground tiles          |
| cloud     | ``clouds/<run>.copc.laz`` through PDAL (ground classified by ``filters.smrf``) |
| dsm       | ``dsm.tif`` (COG), a shaded ``kit-pyramid`` layer and its ``aio.grid/1`` heights |
| dtm       | ``dtm.tif`` likewise (PDAL's SMRF, else the same filter on the grid)          |
| ortho     | ``ortho.tif`` (COG) and a ``kit-pyramid`` ortho layer                          |
| mesh      | Poisson or 2.5D mesh (``mesh.py``)                                            |
| texture   | the textured site-view GLB layer and the full mesh for 3D Tiles               |
| commit    | files into the project, layers into the manifest, ``run.json``, the report    |
| tiles     | the full mesh to 3D Tiles through ``tiles.mesh`` (stream G7)                  |

Existing layer kinds only (``mesh``, ``pointcloud`` ``copc``, ``raster`` ``kit-pyramid``); their
provenance is the run's ``outputs`` (data-conventions section 21). Intermediates live in
``photogrammetry/<run>/work/products/<key>/`` (``key`` from the settings that change them), so a
second job with other products reuses the depth maps and the cloud. Nothing a person delivered is
replaced: a layer with one of this run's ids that the run did not make is refused.

The report is ``report/products.json`` (``aio.photo-products/1``). Memory: the stages plan their
clusters within ``AIO_PHOTO_MEMORY_MB`` when the app sets it (the one cap of the photo jobs),
else 40 % of the physical memory (``native.memory_budget``). The ``tiles`` step hands
``photogrammetry/<run>/mesh/full.glb`` to ``tiles.mesh`` as tileset ``<run>-mesh``; when that
fails the products stay and the run says why (a warning, a failed ``tiles`` stage).
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any

import numpy as np

from .. import __version__
from ..params import known_keys
from ..runtime import (
    AtomicPath,
    Cancelled,
    Job,
    JobError,
    Step,
    StepContext,
    atomic_write_bytes,
    atomic_write_json,
    commit_files,
    now_iso,
    safe_project_path,
)
from . import native

PRODUCTS_SCHEMA = "aio.photo-products/1"
PRODUCTS = ("cloud", "dsm", "dtm", "ortho", "mesh", "tiles")
PRESETS = ("fast", "standard", "high")
RUN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
#: matching size per preset (fraction of the photo); Fast skips dense matching
SCALE = {"fast": 0.0, "standard": 0.5, "high": 1.0}
DEFAULT_TRIANGLES = 2_000_000
IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
STAGES = ("dense", "fuse", "cloud", "dsm", "dtm", "ortho", "mesh", "texture", "commit", "tiles")
CUDA_MISSING = (
    "The GPU accelerator is not in this pipeline pack (decision 5: M10.1 at the earliest); "
    "use dense: auto or cpu."
)
PDAL_FOR_CLOUD = (
    "The point cloud needs PDAL, which this pipeline pack does not have. Install the full "
    "pipeline pack, or leave the point cloud out."
)


# ------------------------------------------------------------------------------------ helpers


def _hash(obj: Any) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True).encode()).hexdigest()[:12]


def _region_poly(region: list[list[float]] | None, epsg: int | None):
    if not region:
        return None
    if not epsg:
        raise JobError("A processing region needs the project CRS (an EPSG code).")
    from rasterio.warp import transform
    from shapely.geometry import Polygon

    lon = [float(p[0]) for p in region]
    lat = [float(p[1]) for p in region]
    xs, ys = transform("EPSG:4326", f"EPSG:{epsg}", lon, lat)
    poly = Polygon(zip(xs, ys, strict=True))
    if not poly.is_valid or poly.area <= 0:
        raise JobError("The processing region is not a valid polygon.")
    return poly


def _timed(fn):
    """Wrap a step: its outputs carry the stage's time and the process's peak memory so far."""

    def run(ctx: StepContext) -> dict[str, Any]:
        started = now_iso()
        t0 = time.monotonic()
        out = fn(ctx) or {}
        out["_stage"] = {
            "startedAt": started,
            "finishedAt": now_iso(),
            "seconds": round(time.monotonic() - t0, 2),
            "memoryPeakBytes": native.peak_memory(),
        }
        return out

    return run


class _Images:
    """Grey photos at the matching size, a few at a time."""

    def __init__(self, scale: float, capacity: int = 8):
        self.scale = scale
        self.cache: OrderedDict[int, np.ndarray] = OrderedDict()
        self.capacity = capacity

    def __call__(self, view) -> np.ndarray:
        from .scene import load_image

        if view.id in self.cache:
            self.cache.move_to_end(view.id)
            return self.cache[view.id]
        img = load_image(view.path, self.scale, gray=True).astype(np.float32)
        self.cache[view.id] = img
        while len(self.cache) > self.capacity:
            self.cache.popitem(last=False)
        return img


def pyramid_index(
    plan, origin: np.ndarray, epsg: int | None, rel_dir: str, y: float, extra: dict
) -> dict[str, Any]:
    """``aio.tiles/1`` for a pyramid built by ``road/ortho.build_pyramid`` (data-conventions 5)."""
    from ..road.ortho import TILE

    x0 = round(plan.left - origin[0], 6)
    z0 = round(-(plan.top - origin[1]), 6)
    yy = round(float(y), 3)
    levels = []
    for z in range(plan.levels):
        cols, rows = plan.level_size(z)
        levels.append(
            {
                "z": z,
                "tileSize": TILE,
                "cols": cols,
                "rows": rows,
                "pattern": f"{rel_dir}/{z}/{{x}}_{{y}}.webp",
            }
        )
    return {
        "schema": "aio.tiles/1",
        "levels": levels,
        "corners": {
            "tl": [x0, yy, z0],
            "tr": [round(x0 + plan.width, 6), yy, z0],
            "bl": [x0, yy, round(z0 + plan.height, 6)],
        },
        **({"crs": {"epsg": epsg}} if epsg else {}),
        "topLeft": [plan.left, plan.top],
        "metresPerPx": [round(plan.level_res(z), 6) for z in range(plan.levels)],
        **extra,
    }


def _pyramid(
    ctx: StepContext, tif: Path, rel_dir: str, origin: np.ndarray, epsg, y: float, res: float, extra: dict
) -> dict:
    """A kit pyramid of an RGB(A) GeoTIFF into staging ``rel_dir`` with its ``tiles.json``."""
    from rasterio.crs import CRS

    from ..road.ortho import build_pyramid, open_sources, plan_pyramid

    crs = CRS.from_epsg(epsg) if epsg else None
    srcs = open_sources([str(tif)], crs) if crs else None
    if srcs is None:
        import rasterio

        raw = rasterio.open(tif)
        from ..road.ortho import Source

        srcs = [Source(str(tif), raw, raw, [1, 2, 3], raw.count >= 4)]
    try:
        plan = plan_pyramid(srcs, res)
        res_info = build_pyramid(
            srcs,
            plan,
            ctx.stage(rel_dir),
            ctx.check,
            lambda f, m=None: ctx.progress(0.5 + 0.5 * f, m),
            ctx.log,
        )
    finally:
        for s in srcs:
            s.close()
    atomic_write_json(
        ctx.stage(f"{rel_dir}/tiles.json"), pyramid_index(plan, origin, epsg, rel_dir, y, extra)
    )
    return {"levels": plan.levels, "tiles": res_info["tiles"]}


# ------------------------------------------------------------------------------------ pipeline


class PhotoProducts:
    name = "photo.products"
    title = "Create products from photos"
    description = "Dense cloud, DSM and DTM, orthomosaic and textured mesh from an aligned run."

    # parameters ----------------------------------------------------------------------------------
    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(
            params,
            {"run", "products", "preset", "dense", "gsdCm", "region", "capture", "meshTriangles"},
            self.name,
        )
        run = params.get("run")
        if not isinstance(run, str) or not RUN_ID.match(run):
            raise JobError("run must be a run id (letters, digits, dot, dash or _).")
        products = params.get("products")
        if not isinstance(products, list) or not products or any(p not in PRODUCTS for p in products):
            raise JobError(f"products must be one of: {', '.join(PRODUCTS)} (one or more).")
        out: dict[str, Any] = {"run": run, "products": [p for p in PRODUCTS if p in products]}
        preset = params.get("preset")
        if preset is not None:
            if preset not in PRESETS:
                raise JobError(f"preset must be one of: {', '.join(PRESETS)}.")
            out["preset"] = preset
        dense = params.get("dense")
        if dense is not None:
            if dense not in ("auto", "cpu", "cuda"):
                raise JobError("dense must be one of: auto, cpu, cuda.")
            if dense == "cuda":
                raise JobError(CUDA_MISSING)
            out["dense"] = dense
        gsd = params.get("gsdCm")
        if gsd is not None:
            if isinstance(gsd, bool) or not isinstance(gsd, int | float) or not 0.1 <= gsd <= 1000:
                raise JobError("gsdCm must be between 0.1 and 1000.")
            out["gsdCm"] = float(gsd)
        region = params.get("region")
        if region is not None:
            ok = isinstance(region, list) and len(region) >= 3
            ok = ok and all(
                isinstance(p, list)
                and len(p) == 2
                and all(isinstance(v, int | float) and not isinstance(v, bool) for v in p)
                for p in region
            )
            if not ok:
                raise JobError("region must be a ring of at least three [longitude, latitude] points.")
            out["region"] = region
        capture = params.get("capture")
        if capture is not None:
            if not isinstance(capture, str) or not 1 <= len(capture) <= 128:
                raise JobError("capture must be a capture id.")
            out["capture"] = capture
        tri = params.get("meshTriangles")
        if tri is not None:
            if isinstance(tri, bool) or not isinstance(tri, int) or not 10_000 <= tri <= 50_000_000:
                raise JobError("meshTriangles must be a whole number from 10000 to 50000000.")
            out["meshTriangles"] = tri
        return out

    def inputs(self, params: dict[str, Any]) -> list[str]:
        """The run's sparse model: a resume refuses when alignment or georeferencing changed it.
        (Not ``run.json``, which this job itself updates when it commits; the photos are found
        by name again in ``prepare``.)"""
        return [f"photogrammetry/{params['run']}/sparse"]

    # plan ------------------------------------------------------------------------------------------
    def plan(self, params: dict[str, Any]) -> list[Step]:
        want = set(params["products"])
        need_mesh = bool(want & {"mesh", "tiles"})
        need_dsm = bool(want & {"dsm", "dtm", "ortho"}) or need_mesh
        steps = [Step("prepare", "Check the run and plan the products", _timed(self._prepare), 0.5)]
        steps.append(Step("dense", "Dense matching (depth maps)", _timed(self._dense), 10))
        steps.append(Step("fuse", "Fuse the depth maps into a cloud", _timed(self._fuse), 3))
        if "cloud" in want:
            steps.append(Step("cloud", "Point cloud to COPC", _timed(self._cloud), 2))
        if need_dsm:
            steps.append(Step("dsm", "Surface model (DSM)", _timed(self._dsm), 2))
        if "dtm" in want:
            steps.append(Step("dtm", "Terrain model (DTM)", _timed(self._dtm), 1))
        if "ortho" in want:
            steps.append(Step("ortho", "Orthomosaic", _timed(self._ortho), 6))
        if need_mesh:
            steps.append(Step("mesh", "Mesh", _timed(self._mesh), 4))
            steps.append(Step("texture", "Texture the mesh", _timed(self._texture), 3))
        steps.append(Step("commit", "Add the products to the project", _timed(self._commit), 0.5))
        if "tiles" in want:
            steps.append(Step("tiles", "Mesh to 3D Tiles", _timed(self._tiles), 2))
        return steps

    # shared state ------------------------------------------------------------------------------------
    def _run(self, ctx: StepContext):
        cached = getattr(ctx.job, "_photo_run", None)
        if cached is None:
            from .scene import load_run

            cached = load_run(ctx.project, ctx.params["run"])
            ctx.job._photo_run = cached  # type: ignore[attr-defined]
        return cached

    def _settings(self, ctx: StepContext) -> dict[str, Any]:
        return ctx.outputs("prepare")

    def _work(self, ctx: StepContext) -> Path:
        s = self._settings(ctx)
        return safe_project_path(ctx.project, s["work"])

    def _tiles_store(self, ctx: StepContext):
        from .fuse import PointTiles

        s = self._settings(ctx)
        return PointTiles(self._work(ctx) / "cloud", s["tileM"])

    # steps ---------------------------------------------------------------------------------------------
    def _prepare(self, ctx: StepContext) -> dict[str, Any]:
        from .dense import visible_points
        from .mesh import nadir_share

        p = ctx.params
        run = self._run(ctx)
        model = run.model
        preset = p.get("preset") or run.doc.get("preset") or "standard"
        if preset not in PRESETS:
            preset = "standard"
        # photo GSD: height above the sparse ground over the focal length, median over the photos
        gsds = []
        for v in model.views:
            idx = visible_points(model, v)
            if len(idx):
                depth = float(np.median(v.to_cam(model.points[idx])[:, 2]))
                gsds.append(depth / v.camera.fx)
        if not gsds:
            raise JobError("The sparse model has no points the photos see; align the photos again.")
        gsd = float(np.median(gsds))
        ortho_res = p["gsdCm"] / 100 if p.get("gsdCm") else gsd
        dsm_res = 2 * ortho_res
        scale = SCALE[preset]
        n = len(model.views)
        cam = model.views[0].camera
        px = cam.width * cam.height
        # disk: depth maps and their points (float32), the cloud tiles, rasters, pyramids, mesh
        lo, hi = model.points.min(0), model.points.max(0)
        area = max(1.0, float((hi[0] - lo[0]) * (hi[1] - lo[1])))
        dense_points = area / (gsd / max(scale, 0.25)) ** 2 if scale else len(model.points)
        need = (
            n * px * scale**2 * 4 * 3
            + dense_points * 48 * 2
            + area / ortho_res**2 * 4 * 3
            + area / dsm_res**2 * 4 * 6
        )
        need = int(need * 1.3 + 64 * 1024**2)
        free = native.check_disk(ctx.project, need)
        pdal = None
        if "cloud" in p["products"]:
            from ..pointcloud import find_pdal

            pdal = find_pdal()
            if pdal is None:
                raise JobError(PDAL_FOR_CLOUD)
        key = _hash({"scale": scale, "dense": p.get("dense", "auto"), "region": p.get("region"), "v": 1})
        work = f"photogrammetry/{run.id}/work/products/{key}"
        nadir = nadir_share(model.views)
        ctx.log(
            f"{n} photos, GSD {gsd * 100:.1f} cm; ortho {ortho_res * 100:.1f} cm, DSM {dsm_res * 100:.1f} cm; "
            f"preset {preset}{' (no dense matching)' if not scale else f', matching at {scale:.0%} size'}."
        )
        tile_m = max(16.0, 2048 * dsm_res)
        return {
            "preset": preset,
            "gsd": gsd,
            "orthoRes": ortho_res,
            "dsmRes": dsm_res,
            "scale": scale,
            "work": work,
            "tileM": tile_m,
            "photos": n,
            "nadirShare": round(nadir, 3),
            "groundZ": float(np.median(model.points[:, 2])) if len(model.points) else 0.0,
            "disk": {"neededBytes": need, "freeBytes": int(free)},
            "memoryBudgetBytes": native.memory_budget(),
        }

    def _dense(self, ctx: StepContext) -> dict[str, Any]:
        from .dense import DenseSettings, depth_map, make_matcher, select_pairs

        s = self._settings(ctx)
        if not s["scale"]:
            ctx.log("Fast preset: no dense matching; the surface comes from the sparse points.")
            return {"engine": "sparse", "maps": 0}
        run = self._run(ctx)
        settings = DenseSettings(scale=s["scale"])
        matcher = make_matcher(settings, native.memory_budget(), "auto")
        ctx.log(f"Dense matching with {matcher.name} at {s['scale']:.0%} of the photo size.")
        pairs = select_pairs(run.model, settings.neighbours)
        out = self._work(ctx) / "depth"
        out.mkdir(parents=True, exist_ok=True)
        images = _Images(s["scale"])
        views = run.model.views
        done = matched = 0
        for i, v in enumerate(views):
            ctx.check()
            dst = out / f"{v.id}.npy"
            if dst.exists():
                done += 1
                continue
            partners = [run.model.view(j) for j in pairs.get(v.id, [])]
            if not partners:
                ctx.log(f"{v.name}: no photo overlaps it enough for matching.", "warn")
                d = np.full(
                    (round(v.camera.height * s["scale"]), round(v.camera.width * s["scale"])),
                    np.nan,
                    np.float32,
                )
            else:
                d, info = depth_map(v, partners, images, run.model, matcher, settings, ctx.check)
                matched += sum(p["matched"] for p in info["pairs"])
            tmp = out / f".{v.id}.tmp.npy"
            np.save(tmp, d)
            tmp.replace(dst)
            ctx.progress((i + 1) / len(views), f"Depth map {i + 1} of {len(views)}")
        return {
            "engine": matcher.name,
            "maps": len(views),
            "resumed": done,
            "pairs": sum(len(x) for x in pairs.values()),
        }

    def _fuse(self, ctx: StepContext) -> dict[str, Any]:
        from .fuse import FuseSettings, consistent, normals_of

        s = self._settings(ctx)
        run = self._run(ctx)
        store = self._tiles_store(ctx)
        poly = _region_poly(ctx.params.get("region"), run.epsg)

        def keep(xyz: np.ndarray) -> np.ndarray:
            if poly is None:
                return np.ones(len(xyz), bool)
            import shapely

            return shapely.contains_xy(poly, xyz[:, 0] + run.offset[0], xyz[:, 1] + run.offset[1])

        if not s["scale"]:
            pts = run.model.points
            nrm = np.tile(np.array([0, 0, 1], np.float32), (len(pts), 1))
            store.add("sparse", pts, run.model.colours, nrm)
            info = store.merge(s["gsd"], keep, ctx.check)
            return {"points": info["points"], "source": "sparse"}
        from .dense import select_pairs

        settings = FuseSettings()
        views = run.model.views
        depth_dir = self._work(ctx) / "depth"
        marks = store.root / "chunks" / ".done"
        marks.mkdir(parents=True, exist_ok=True)
        near = select_pairs(run.model, settings.neighbours)
        cams = {v.id: v.camera.scaled(s["scale"]) for v in views}
        from .scene import load_image

        for i, v in enumerate(views):
            ctx.check()
            if (marks / str(v.id)).exists():
                continue
            d = np.load(depth_dir / f"{v.id}.npy")
            others = [
                (run.model.view(j), cams[j], np.load(depth_dir / f"{j}.npy")) for j in near.get(v.id, [])
            ]
            pts, agree = consistent(v, cams[v.id], d, others, settings)
            good = np.isfinite(d) & (agree >= settings.min_agree)
            if good.any():
                nrm = normals_of(pts, v.centre)
                img = load_image(v.path, s["scale"])
                h, w = d.shape
                rgb = img[:h, :w][good]
                ok = np.isfinite(nrm[good]).all(1)
                store.add(f"v{v.id}", pts[good][ok], rgb[ok], nrm[good][ok].astype(np.float32))
            (marks / str(v.id)).write_text("", "utf-8")
            ctx.progress(0.7 * (i + 1) / len(views), f"Fusing photo {i + 1} of {len(views)}")
        voxel = s["gsd"] / s["scale"]
        info = store.merge(voxel, keep, ctx.check, lambda f: ctx.progress(0.7 + 0.3 * f, "Merging the cloud"))
        if not info["points"]:
            raise JobError("Dense matching found no consistent points; the photos may not overlap enough.")
        ctx.log(f"Dense cloud: {info['points']:,} points at {voxel * 100:.1f} cm spacing.")
        return {"points": info["points"], "voxel": voxel, "bounds": info["bounds"], "source": "dense"}

    def _cloud(self, ctx: StepContext) -> dict[str, Any]:
        from ..pointcloud import _run as pdal_run
        from ..pointcloud import find_pdal
        from .fuse import write_las_tiles

        run = self._run(ctx)
        pdal = find_pdal()
        if pdal is None:
            raise JobError(PDAL_FOR_CLOUD)
        store = self._tiles_store(ctx)
        work = self._work(ctx)
        las = work / "cloud.las"
        if not las.exists():
            write_las_tiles(las, store, run.offset)
        staged = ctx.stage(f"clouds/{run.id}.copc.laz")
        epsg = run.epsg
        pipe = {
            "pipeline": [
                {
                    "type": "readers.las",
                    "filename": str(las),
                    **({"override_srs": f"EPSG:{epsg}"} if epsg else {}),
                },
                {"type": "filters.smrf", "slope": 0.15, "window": 18.0, "threshold": 0.5, "scalar": 1.25},
                {
                    "type": "writers.copc",
                    "filename": str(staged),
                    **({"a_srs": f"EPSG:{epsg}"} if epsg else {}),
                },
            ]
        }
        pj = work / "copc-pipeline.json"
        atomic_write_json(pj, pipe)
        pdal_run(ctx, [pdal, "pipeline", str(pj)], "Write the COPC point cloud")
        if not staged.is_file():
            raise JobError("PDAL finished without writing the COPC file.")
        n = store.info().get("points", 0)
        return {"points": int(n), "path": f"clouds/{run.id}.copc.laz", "bytes": staged.stat().st_size}

    def _dsm(self, ctx: StepContext) -> dict[str, Any]:
        from .surface import GridSpec, grid_points, push_pull, read_grid, write_tif

        s = self._settings(ctx)
        run = self._run(ctx)
        store = self._tiles_store(ctx)
        info = store.info()
        if not info.get("bounds"):
            raise JobError("There is no cloud to grid; run the dense stage again.")
        lo, hi = info["bounds"]
        res = s["dsmRes"]
        spec = GridSpec.around(
            (lo[0] + run.offset[0], lo[1] + run.offset[1]),
            (hi[0] + run.offset[0], hi[1] + run.offset[1]),
            res,
        )
        work = self._work(ctx)
        raw, zmin = work / "dsm-raw.tif", work / "zmin-raw.tif"

        # the grid works in project CRS coordinates: shift the tiles' model coordinates by the offset
        class Shifted:
            def fused_in(_self, x0, y0, x1, y1):
                o = run.offset
                d = store.fused_in(x0 - o[0], y0 - o[1], x1 - o[0], y1 - o[1])
                d["xyz"] = d["xyz"] + o
                return d

        if not raw.exists():
            fill = 4 * res if s["scale"] else 0
            g = grid_points(
                Shifted(),
                spec,
                raw.with_suffix(".tmp.tif"),
                run.epsg,
                fill,
                ctx.check,
                lambda f, m=None: ctx.progress(0.5 * f, m),
                zmin.with_suffix(".tmp.tif"),
            )
            if not s["scale"]:
                # sparse points: a smooth surface between them, within 5 m of a point
                from scipy import ndimage

                z = read_grid(raw.with_suffix(".tmp.tif"))
                dist = ndimage.distance_transform_edt(~np.isfinite(z)) * res
                filled = push_pull(z)
                filled[dist > max(5.0, 10 * res)] = np.nan
                from rasterio.windows import Window

                for src in (raw.with_suffix(".tmp.tif"), zmin.with_suffix(".tmp.tif")):
                    with write_tif(src.with_suffix(".fill.tif"), spec, run.epsg, 1, "float32", -9999.0) as ds:
                        ds.write(
                            np.where(np.isfinite(filled), filled, -9999.0).astype(np.float32),
                            1,
                            window=Window(0, 0, spec.width, spec.height),
                        )
                    src.with_suffix(".fill.tif").replace(src)
            zmin.with_suffix(".tmp.tif").replace(zmin)
            raw.with_suffix(".tmp.tif").replace(raw)
        else:
            g = {}
        out: dict[str, Any] = {"spec": spec.__dict__, **g}
        if "dsm" in ctx.params["products"]:
            out.update(self._surface_layer(ctx, raw, spec, "dsm"))
        return out

    def _surface_layer(self, ctx: StepContext, raw: Path, spec, which: str) -> dict[str, Any]:
        from .surface import shaded_tif, to_cog, write_height_grid

        run = self._run(ctx)
        s = self._settings(ctx)
        work = self._work(ctx)
        to_cog(raw, ctx.stage(f"photogrammetry/{run.id}/{which}.tif"), "average")
        shaded = work / f"{which}-shaded.tif"
        legend = shaded_tif(raw, shaded, spec, run.epsg, ctx.check)
        ctx.progress(0.4, "Shaded relief")
        lid = f"{run.id}-{which}"
        y = s["groundZ"] + run.offset[2] - run.origin[2]
        pyr = _pyramid(
            ctx,
            shaded,
            f"rasters/{lid}",
            run.origin,
            run.epsg,
            y,
            spec.res,
            {"legend": legend["legend"], "source": f"{which}.tif"},
        )
        grid_dir = ctx.stage(f"sources/{lid}.json").parent
        write_height_grid(raw, grid_dir, lid, spec, run.epsg, "dsm")
        return {"layer": lid, "pyramid": pyr, "legend": legend["legend"]}

    def _dtm(self, ctx: StepContext) -> dict[str, Any]:
        from ..pointcloud import _run as pdal_run
        from ..pointcloud import find_pdal
        from .surface import GridSpec, dtm_coarse, dtm_grid, pdal_dtm_pipeline

        run = self._run(ctx)
        spec = GridSpec(**ctx.outputs("dsm")["spec"])
        work = self._work(ctx)
        raw = work / "dtm-raw.tif"
        engine = {}
        if not raw.exists():
            pdal = find_pdal()
            las = work / "cloud.las"
            tmp = raw.with_suffix(".tmp.tif")
            budget = native.memory_budget()
            ground = None
            if pdal and las.exists():
                ground = work / "ground-pdal.tif"
                pj = work / "dtm-pipeline.json"
                atomic_write_json(pj, pdal_dtm_pipeline(las, ground, dtm_coarse(spec, budget), run.epsg))
                pdal_run(ctx, [pdal, "pipeline", str(pj)], "Classify the ground with PDAL")
            engine = dtm_grid(
                work / "dsm-raw.tif", work / "zmin-raw.tif", spec, tmp, run.epsg, budget, ctx.check, ground
            )
            tmp.replace(raw)
            ctx.log(f"DTM: ground found by {engine['engine']}.")
        out = {"engine": engine.get("engine", "reused"), **engine}
        out.update(self._surface_layer(ctx, raw, spec, "dtm"))
        return out

    def _ortho(self, ctx: StepContext) -> dict[str, Any]:
        from .ortho import Mosaic, OrthoSettings, orthomosaic
        from .surface import GridSpec, to_cog

        s = self._settings(ctx)
        run = self._run(ctx)
        dspec = GridSpec(**ctx.outputs("dsm")["spec"])
        work = self._work(ctx)
        res = s["orthoRes"]
        x0, y0, x1, y1 = dspec.bounds
        spec = GridSpec.around((x0, y0), (x1, y1), res)
        # the views in project CRS coordinates
        from .scene import View

        views = [View(v.id, v.name, v.camera, v.r, v.t - v.r @ run.offset, v.path) for v in run.model.views]
        raw = work / "ortho-raw.tif"
        info: dict[str, Any] = {}
        if not raw.exists():
            mosaic = Mosaic(views, work / "dsm-raw.tif", dspec, OrthoSettings(), native.memory_budget())
            gains = mosaic.compensate(spec, ctx.check)
            atomic_write_json(work / "gains.json", gains)
            tmp = raw.with_suffix(".tmp.tif")
            info = orthomosaic(
                mosaic, spec, tmp, run.epsg, ctx.check, lambda f, m=None: ctx.progress(0.7 * f, m)
            )
            tmp.replace(raw)
        to_cog(raw, ctx.stage(f"photogrammetry/{run.id}/ortho.tif"), "average")
        lid = f"{run.id}-ortho"
        y = s["groundZ"] + run.offset[2] - run.origin[2]
        pyr = _pyramid(ctx, raw, f"rasters/{lid}", run.origin, run.epsg, y, res, {"source": "ortho.tif"})
        return {"spec": spec.__dict__, "layer": lid, "pyramid": pyr, **info}

    def _mesh(self, ctx: StepContext) -> dict[str, Any]:
        from .mesh import cluster, mesh_25d, poisson_fft, poisson_tool, write_ply_chunks
        from .native import find_tool
        from .surface import GridSpec

        s = self._settings(ctx)
        run = self._run(ctx)
        work = self._work(ctx)
        dst = work / "mesh-full.npz"
        if dst.exists():
            with np.load(dst) as z:
                return {"engine": str(z["engine"]), "triangles": len(z["faces"])}
        origin = run.origin
        budget_tri = int(ctx.params.get("meshTriangles") or DEFAULT_TRIANGLES)
        full_tri = max(budget_tri, 4 * budget_tri)
        dspec = GridSpec(**ctx.outputs("dsm")["spec"])
        nadir = s["nadirShare"] >= 0.8
        tool = find_tool("PoissonRecon")
        if not s["scale"] or (nadir and tool is None):
            engine = "grid-25d"
            mesh = mesh_25d(work / "dsm-raw.tif", dspec, origin, full_tri)
        else:
            store = self._tiles_store(ctx)
            count = int(store.info().get("points") or 0)
            shift = run.offset - origin
            # a sample of the cloud in memory (the FFT solver's grid holds no more detail anyway)
            stride = max(1, count // 5_000_000)
            parts = [
                (p["xyz"][::stride] + shift, p["normal"][::stride].astype(np.float64))
                for _, p in store.fused()
            ]
            pts = np.concatenate([a for a, _ in parts])
            nrm = np.concatenate([b for _, b in parts])
            del parts
            if tool is not None:
                engine = "poissonrecon"
                depth = 11 if s["preset"] == "standard" else 12
                src = work / "poisson" / "dense.ply"
                write_ply_chunks(
                    src, ((p["xyz"] + shift, p["normal"], p["rgb"]) for _, p in store.fused()), count
                )
                mesh = poisson_tool(ctx, work / "poisson", pts, nrm, depth, None, src, count)
            else:
                engine = "poisson-fft"
                mesh = poisson_fft(pts, nrm, native.memory_budget() // 2, check=ctx.check)
            if mesh.triangles > full_tri:
                mesh = cluster(mesh, full_tri)
        if not mesh.triangles:
            raise JobError("The mesh came out empty; the cloud may be too sparse.")
        tmp = dst.with_name(".mesh-full.tmp.npz")
        np.savez(tmp, vertices=mesh.vertices, faces=mesh.faces, engine=np.array(engine))
        tmp.replace(dst)
        ctx.log(f"Mesh ({engine}): {mesh.triangles:,} triangles.")
        return {"engine": engine, "triangles": mesh.triangles}

    def _texture(self, ctx: StepContext) -> dict[str, Any]:
        from .mesh import Mesh, cluster
        from .native import find_tool
        from .scene import View
        from .texture import drape_ortho, texture_texrecon, texture_views

        run = self._run(ctx)
        work = self._work(ctx)
        with np.load(work / "mesh-full.npz") as z:
            full = Mesh(z["vertices"], z["faces"])
            engine_mesh = str(z["engine"])
        origin = run.origin
        views = [View(v.id, v.name, v.camera, v.r, v.t - v.r @ run.offset, v.path) for v in run.model.views]
        budget_tri = int(ctx.params.get("meshTriangles") or DEFAULT_TRIANGLES)
        site = cluster(full, budget_tri) if full.triangles > budget_tri else full
        ortho_cog = ctx.stage(f"photogrammetry/{run.id}/ortho.tif")
        if not ortho_cog.exists():
            ortho_cog = ctx.out(f"photogrammetry/{run.id}/ortho.tif")
        gains_file = work / "gains.json"
        gains = (
            {int(k): np.asarray(v) for k, v in json.loads(gains_file.read_text("utf-8")).items()}
            if gains_file.exists()
            else None
        )
        tex_tool = find_tool("texrecon")

        def make(mesh: Mesh, tag: str) -> tuple[bytes, str, dict]:
            if engine_mesh == "grid-25d" and ortho_cog.exists():
                return drape_ortho(mesh, origin, ortho_cog), "ortho-drape", {}
            if tex_tool is not None:
                data, info = texture_texrecon(ctx, work / f"texrecon-{tag}", mesh, views, origin)
                return data, "texrecon", info
            data, info = texture_views(mesh, views, origin, gains, check=ctx.check)
            return data, "views", info

        want = ctx.params["products"]
        glb = b""
        out: dict[str, Any] = {"fullTriangles": full.triangles}
        if "mesh" in want:
            glb, engine, info = make(site, "site")
            atomic_write_bytes(ctx.stage(f"models/{run.id}-mesh.glb"), glb)
            ctx.progress(0.6, "Site-view mesh written")
            out.update({"engine": engine, "triangles": site.triangles, **info})
        if "tiles" in want:
            # the full mesh for tiles.mesh (the site-view one when it is already whole)
            if not (glb and site is full):
                glb, engine, _ = make(full, "full")
                out.setdefault("engine", engine)
            atomic_write_bytes(ctx.stage(f"photogrammetry/{run.id}/mesh/full.glb"), glb)
        return out

    def _commit(self, ctx: StepContext) -> dict[str, Any]:
        run = self._run(ctx)
        p = ctx.params
        want = set(p["products"])
        rdir = f"photogrammetry/{run.id}"
        mpath = safe_project_path(ctx.project, "manifest.json")
        manifest = json.loads(mpath.read_text("utf-8-sig"))
        doc = json.loads((run.dir / "run.json").read_text("utf-8-sig"))
        ours = set(((doc.get("outputs") or {}).get("layers")) or [])
        layers: list[dict[str, Any]] = []
        files: list[str] = []
        cap = {"capture": p["capture"]} if p.get("capture") else {}
        label = run.id

        def raster(which: str, role: str, title: str) -> None:
            lid = f"{run.id}-{which}"
            layers.append(
                {
                    "kind": "raster",
                    "id": lid,
                    "name": f"{title} {label}",
                    "visible": True,
                    "src": {"path": f"rasters/{lid}/tiles.json"},
                    "role": role,
                    "format": "kit-pyramid",
                    **cap,
                }
            )
            files.append(f"{rdir}/{which}.tif")

        if "ortho" in want:
            raster("ortho", "ortho", "Ortho")
        if "dsm" in want:
            raster("dsm", "dsm", "DSM")
        if "dtm" in want:
            raster("dtm", "dsm", "DTM")
        if "cloud" in want:
            n = int(ctx.outputs("cloud").get("points") or 0)
            layers.append(
                {
                    "kind": "pointcloud",
                    "id": f"{run.id}-cloud",
                    "name": f"Point cloud {label}",
                    "visible": True,
                    "src": {"path": f"clouds/{run.id}.copc.laz"},
                    "format": "copc",
                    **({"pointCount": n} if n else {}),
                    **cap,
                }
            )
        if "mesh" in want:
            layers.append(
                {
                    "kind": "mesh",
                    "id": f"{run.id}-mesh",
                    "name": f"Mesh {label}",
                    "visible": True,
                    "src": {"path": f"models/{run.id}-mesh.glb"},
                    "transform": IDENTITY,
                    **cap,
                }
            )
        if "tiles" in want:
            files.append(f"{rdir}/mesh/full.glb")
        existing = {x.get("id"): x for x in manifest.get("layers") or [] if isinstance(x, dict)}
        for lay in layers:
            if lay["id"] in existing and lay["id"] not in ours:
                raise JobError(
                    f'The project already has a layer "{lay["id"]}" this run did not make; rename it first.'
                )
        # files: rasters and pyramids, sources, cloud, models, run files; run.json and manifest last
        staged = ctx.staging
        moves = []
        for path in sorted(q for q in staged.rglob("*") if q.is_file() and not q.name.startswith(".")):
            rel = path.relative_to(staged).as_posix()
            if rel.startswith(("rasters/", "sources/", "clouds/", "models/", f"{rdir}/")):
                moves.append((rel, rel))
        marker = ctx.job.dir / "steps" / ".committing"
        if not marker.exists():
            for which in ("ortho", "dsm", "dtm"):
                old = ctx.out(f"rasters/{run.id}-{which}")
                if which in want and old.exists():
                    shutil.rmtree(old)  # an earlier products run's pyramid: replaced whole
            marker.parent.mkdir(parents=True, exist_ok=True)
            marker.write_text("", "utf-8")
        commit_files(ctx, moves, announce=False)
        for lay in layers:
            ctx.artifact(lay["src"]["path"])
        # manifest: replace this run's layers, keep what the person set on them
        kept = []
        for x in manifest.get("layers") or []:
            if isinstance(x, dict) and any(x.get("id") == lay["id"] for lay in layers):
                continue
            kept.append(x)
        for lay in layers:
            old = existing.get(lay["id"])
            if old is not None:
                lay["visible"] = old.get("visible", True)
                if "capture" in old and "capture" not in lay:
                    lay["capture"] = old["capture"]
            kept.append(lay)
        manifest["layers"] = kept
        shutil.copyfile(mpath, mpath.with_name("manifest.json.bak"))
        atomic_write_json(mpath, manifest, indent=2)
        # run.json: status, stages, outputs, versions, warnings; then the products report
        report = self._report(ctx, layers)
        atomic_write_json(ctx.out(f"{rdir}/report/products.json"), report)
        doc = json.loads((run.dir / "run.json").read_text("utf-8-sig"))
        outputs = doc.setdefault("outputs", {"layers": [], "tilesets": [], "files": []})
        outputs["layers"] = sorted(set(outputs.get("layers") or []) | {x["id"] for x in layers})
        outputs.setdefault("tilesets", [])
        outputs["files"] = sorted(
            set(outputs.get("files") or []) | set(files) | {f"{rdir}/report/products.json"}
        )
        stages = [x for x in doc.get("stages") or [] if isinstance(x, dict) and x.get("name") not in STAGES]
        stages += report["stages"]
        doc["stages"] = stages
        doc["status"] = "done"
        doc["updatedAt"] = now_iso()
        doc["settings"] = {**(doc.get("settings") or {}), "products": dict(p)}
        if p.get("capture"):
            doc["capture"] = p["capture"]
        if p.get("region"):
            doc["region"] = p["region"]
        doc.setdefault("versions", {})
        doc["versions"]["pack"] = __version__
        if report["engines"].get("dense") == "sgm-opencv":
            import cv2

            doc["versions"]["opencv"] = str(cv2.__version__)
        warnings = list(doc.get("warnings") or [])
        warnings += [w for w in report["warnings"] if w not in warnings]
        if warnings:
            doc["warnings"] = warnings[-1000:]
        atomic_write_json(run.dir / "run.json", doc)
        ctx.artifact(f"{rdir}/run.json")
        return {"layers": [x["id"] for x in layers], "files": len(moves)}

    def _report(self, ctx: StepContext, layers: list[dict[str, Any]]) -> dict[str, Any]:
        s = self._settings(ctx)
        run = self._run(ctx)
        stages: list[dict[str, Any]] = []
        peak = 0
        for name in STAGES:
            o = ctx.outputs(name).get("_stage") if name != "commit" else None
            if not o:
                continue
            peak = max(peak, int(o.get("memoryPeakBytes") or 0))
            stages.append(
                {
                    "name": name,
                    "state": "done",
                    **{k: o[k] for k in ("startedAt", "finishedAt", "seconds", "memoryPeakBytes")},
                }
            )
        stages.append({"name": "commit", "state": "done", "finishedAt": now_iso()})
        engines = {
            "dense": ctx.outputs("dense").get("engine"),
            "ground": ctx.outputs("dtm").get("engine"),
            "mesh": ctx.outputs("mesh").get("engine"),
            "texture": ctx.outputs("texture").get("engine"),
        }
        fuse = ctx.outputs("fuse")
        dsm = ctx.outputs("dsm")
        ortho = ctx.outputs("ortho")
        warnings = []
        if engines["dense"] == "sgm-numpy":
            warnings.append(
                "Dense matching ran on the pure-Python matcher (slower); the pack's OpenCV build is faster."
            )
        if engines["mesh"] == "poisson-fft":
            warnings.append(
                "The mesh was made by the built-in Poisson solver on a coarse grid; PoissonRecon is not in this pack."
            )
        return {
            "schema": PRODUCTS_SCHEMA,
            "run": run.id,
            "createdAt": now_iso(),
            "preset": s["preset"],
            "products": ctx.params["products"],
            "layers": [x["id"] for x in layers],
            "gsdCm": {
                "photos": round(s["gsd"] * 100, 2),
                "ortho": round(s["orthoRes"] * 100, 2),
                "dsm": round(s["dsmRes"] * 100, 2),
            },
            "engines": {k: v for k, v in engines.items() if v},
            "cloud": {
                "points": int(fuse.get("points") or 0),
                "spacingM": round(float(fuse.get("voxel") or s["gsd"]), 4),
                "source": fuse.get("source"),
            },
            "coverage": {
                k: v
                for k, v in (("dsm", dsm.get("coverage")), ("ortho", ortho.get("coverage")))
                if v is not None
            },
            "mesh": {
                k: ctx.outputs("texture").get(k)
                for k in ("triangles", "fullTriangles")
                if ctx.outputs("texture").get(k)
            },
            "stages": stages,
            "memoryPeakBytes": peak,
            "memoryBudgetBytes": s["memoryBudgetBytes"],
            "disk": s["disk"],
            "warnings": warnings,
        }

    def _tiles(self, ctx: StepContext) -> dict[str, Any]:
        """The full mesh to 3D Tiles through G7's ``tiles.mesh``, as a job inside this one."""
        from ..tiles.mesh import TilesMesh

        run = self._run(ctx)
        tid = f"{run.id}-mesh"[:80]
        params = {
            "src": f"photogrammetry/{run.id}/mesh/full.glb",
            "run": run.id,
            "id": tid,
            "name": f"Mesh {run.id}",
        }
        pipeline = TilesMesh()

        def emit(method: str, msg: dict[str, Any]) -> None:
            if method == "progress" and "fraction" in msg:
                ctx.progress(float(msg["fraction"]), msg.get("message"))
            elif method == "log":
                ctx.log(str(msg.get("message", "")), str(msg.get("level", "info")))
            elif method == "artifact" and msg.get("path"):
                ctx.artifact(str(msg["path"]), str(msg.get("kind", "file")))

        job_id = f"{ctx.job.job_id[:70]}-tiles"
        try:
            res = Job(job_id, pipeline, ctx.project, pipeline.validate(params), emit, ctx.cancel_event).run()
        except Cancelled:
            raise
        except JobError as e:
            msg = f"3D Tiles were not made: {e}"
            ctx.log(msg, "warn")
            self._note_run(
                ctx, warning=msg, stage={"name": "tiles", "state": "failed", "message": str(e)[:2000]}
            )
            return {"ok": False, "error": str(e)}
        made = tid
        for outs in (res.get("outputs") or {}).values():
            if isinstance(outs, dict) and isinstance(outs.get("tileset") or outs.get("id"), str):
                made = outs.get("tileset") or outs.get("id")
        self._note_run(ctx, tileset=made, stage={"name": "tiles", "state": "done"})
        return {"ok": True, "tileset": made}

    def _note_run(
        self,
        ctx: StepContext,
        warning: str | None = None,
        tileset: str | None = None,
        stage: dict | None = None,
    ) -> None:
        run = self._run(ctx)
        path = run.dir / "run.json"
        doc = json.loads(path.read_text("utf-8-sig"))
        if warning:
            doc["warnings"] = [*(doc.get("warnings") or []), warning][-1000:]
        if tileset:
            out = doc.setdefault("outputs", {"layers": [], "tilesets": [], "files": []})
            out["tilesets"] = sorted(set(out.get("tilesets") or []) | {tileset})
        if stage:
            doc["stages"] = [
                x
                for x in doc.get("stages") or []
                if not (isinstance(x, dict) and x.get("name") == stage["name"])
            ]
            doc["stages"].append({**stage, "finishedAt": now_iso()})
        doc["updatedAt"] = now_iso()
        with AtomicPath(path) as tmp:
            tmp.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n", "utf-8")
