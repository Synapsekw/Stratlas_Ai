"""photo.products: point cloud (COPC), DSM and DTM, orthomosaic and textured mesh, as new layers.

Parameters as ``PhotoProductsParams`` in ``@aio/schema`` ``jobs.ts``. From a run aligned by ODM
(``photogrammetry/<run>/``: ``run.json`` and the ODM project ``odm/`` of ``photo.align`` or
``photo.georef``), ODM (ADR 0012) runs over its own stage range in each job step and its outputs
are imported right after; each step is resumable (the runtime skips finished steps and ODM resumes
after the last stage it finished) and cancellable, with progress per stage:

| Step      | Makes                                                                              |
| --------- | ---------------------------------------------------------------------------------- |
| prepare   | run and ODM checks, resolutions, threads, graphics card, disk, the boundary         |
| dense     | ODM openmvs to odm_filterpoints (Fast: from ``FAST_FIRST_STAGE``, no dense matching) |
| mesh      | ODM odm_meshing                                                                     |
| texture   | ODM mvs_texturing; the site-view GLB layer and the full mesh for 3D Tiles           |
| cloud     | ODM to odm_georeferencing; the ground check; ``clouds/<run>.copc.laz``              |
| dsm       | ODM odm_dem; ``dsm.tif`` and ``dtm.tif`` (COG), shaded ``kit-pyramid`` layers, heights |
| ortho     | ODM to the end; ``ortho.tif`` (COG), its ``kit-pyramid`` layer and ODM's report     |
| commit    | files into the project, layers into the manifest, ``run.json``, the report; then ODM's |
|           | heavy intermediate folders are removed (the alignment stays)                        |
| tiles     | the full mesh to 3D Tiles through ``tiles.mesh`` (stream G7)                        |

The Fast preset makes no 3D model: ``mesh`` and ``tiles`` are left out with a job-log line.
Existing layer kinds only (``mesh``, ``pointcloud`` ``copc``, ``raster`` ``kit-pyramid``); their
provenance is the run's ``outputs`` (data-conventions section 21). Intermediates (rasters in the
project CRS, the cloud's temporary files) live in ``photogrammetry/<run>/work/products/``, ODM's
logs in ``photogrammetry/<run>/odm-logs/<job>-<step>/``. Nothing a person delivered is replaced:
a layer with one of this run's ids that the run did not make is refused. A run with no ODM
project (aligned by an earlier version, or imported) is refused with ``OLD_RUN``.

The report is ``report/products.json`` (``aio.photo-products/1``), with ODM's own report beside it
(``report/odm-report.pdf``, ``report/odm-stats.json``). The ``tiles`` step hands
``photogrammetry/<run>/mesh/full.glb`` to ``tiles.mesh`` as tileset ``<run>-mesh``; when that
fails the products stay and the run says why (a warning, a failed ``tiles`` stage).
"""

from __future__ import annotations

import json
import re
import shutil
import time
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
from . import crs as C
from . import native
from .odm import flags as OF
from .odm import outputs as OU
from .odm import project as OP
from .odm import runner as OR

PRODUCTS_SCHEMA = "aio.photo-products/1"
PRODUCTS = ("cloud", "dsm", "dtm", "ortho", "mesh", "tiles")
PRESETS = ("fast", "standard", "high")
RUN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
#: The stages ``run.json`` records (``prepare`` stays out: ``PhotoStageName`` has none).
STAGES = ("dense", "mesh", "texture", "cloud", "dsm", "ortho", "commit", "tiles")
LAYOUT = 3
OLD_LAYOUT = (
    "This job was started by an earlier version of the processing engine. Remove it from the "
    "Processing list and use Create maps from photos again (a new run)."
)
OLD_RUN = (
    "This run was made by an earlier version of the processing engine, or imported. Use Create "
    "maps from photos on its photos to make a new run."
)
#: Free space needed, times the bytes of ``odm/images/``.
DISK_FACTOR = {"fast": 3, "standard": 6, "high": 10}
FAST_NO_MODEL = "The Fast preset makes no 3D model; mesh and 3D Tiles are left out."
NO_GROUND = "ODM found no ground points in this cloud, so no terrain model (DTM) is made."
DEFAULT_ORTHO_CM = 5.0
GROUND_CLASS = 2


# ------------------------------------------------------------------------------------ helpers


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


def made_products(preset: str | None, products: list[str]) -> list[str]:
    """The products a job makes: the Fast preset makes no 3D model (founder, 14 Oct 2026)."""
    if preset == "fast":
        return [p for p in products if p not in OF.MESH_PRODUCTS]
    return list(products)


def terrain_args(args: list[str], products: list[str] | set[str]) -> list[str]:
    """``--dtm`` only when a terrain model is asked for; a cloud without one gets ``--pc-classify``
    (ground classified in georeferencing, no DTM rendered, so the runner's DTM guard stays off)."""
    want = set(products)
    swap = ["--dtm"] if "dtm" in want else ["--pc-classify"] if "cloud" in want else []
    out: list[str] = []
    for a in args:
        if a in ("--dtm", "--pc-classify"):
            out += [x for x in swap if x not in out]
        else:
            out.append(a)
    return out


class _Within:
    """A step context whose progress moves only within ``lo``..``hi`` of the step, never back."""

    def __init__(self, ctx: StepContext, lo: float, hi: float):
        self._ctx, self._lo, self._hi = ctx, lo, hi
        self._shown = 0.0

    def progress(
        self, fraction: float, message: str | None = None, *, live: dict[str, Any] | None = None
    ) -> None:
        self._shown = max(self._shown, min(1.0, max(0.0, float(fraction))))
        self._ctx.progress(self._lo + (self._hi - self._lo) * self._shown, message, live=live)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._ctx, name)


def ground_found(ctx: StepContext, laz: Path) -> bool | None:
    """Whether ODM classified any ground points (class 2) in its georeferenced cloud, read with
    ``pdal info``; None when there is no PDAL or it cannot tell (the runner's guards remain)."""
    from .. import pointcloud

    pdal = pointcloud.find_pdal()
    if pdal is None or not laz.is_file():
        return None
    try:
        out = pointcloud._run(
            ctx,
            # statistics of the one dimension only (PDAL still reads every point once)
            [
                pdal,
                "info",
                "--stats",
                "--dimensions",
                "Classification",
                "--enumerate",
                "Classification",
                str(laz),
            ],
            "Read the ground classes",
        )
        stats = json.loads(out)["stats"]["statistic"]
        values = next(x["values"] for x in stats if x.get("name") == "Classification")
        return any(int(v) == GROUND_CLASS for v in values)
    except (JobError, ValueError, KeyError, TypeError, StopIteration) as e:
        ctx.log(f"The ground classes of ODM's cloud could not be read ({e}); the check is skipped.")
        return None


def _no_ground(ctx: StepContext) -> bool:
    return ctx.outputs("cloud").get("ground") == 0


def _bytes_under(folder: Path) -> int:
    total = 0
    if folder.is_dir():
        for f in folder.iterdir():
            try:
                if f.is_file():
                    total += f.stat().st_size
            except OSError:
                pass
    return total


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
    ctx: StepContext,
    tif: Path,
    rel_dir: str,
    origin: np.ndarray,
    epsg,
    y: float,
    res: float,
    extra: dict,
    span: tuple[float, float] = (0.5, 1.0),
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
    lo, hi = span
    try:
        plan = plan_pyramid(srcs, res)
        res_info = build_pyramid(
            srcs,
            plan,
            ctx.stage(rel_dir),
            ctx.check,
            lambda f, m=None: ctx.progress(lo + (hi - lo) * f, m),
            ctx.log,
        )
    finally:
        for s in srcs:
            s.close()
    atomic_write_json(
        ctx.stage(f"{rel_dir}/tiles.json"), pyramid_index(plan, origin, epsg, rel_dir, y, extra)
    )
    return {"levels": plan.levels, "tiles": res_info["tiles"]}


# ------------------------------------------------------------------------------------ imports


def _target(s: dict) -> int | str:
    """The project CRS ODM's outputs go into: its EPSG code, or its WKT when it has none."""
    return s.get("crs") or s["epsg"]


def _nothing(self: PhotoProducts, ctx: StepContext, s: dict, odm_dir: Path) -> dict[str, Any]:
    return {}


def _import_mesh(self: PhotoProducts, ctx: StepContext, s: dict, odm_dir: Path) -> dict[str, Any]:
    want = set(s["products"])
    if not want & OF.MESH_PRODUCTS:
        return {}
    run = ctx.params["run"]
    ctx.progress(0.7, "Mesh to GLB")
    data, info = OU.mesh_to_glb(odm_dir, _target(s), np.array(s["origin"], dtype=np.float64))
    warnings = list(info.get("warnings", []))
    for w in warnings:
        ctx.log(w, "warn")
    if "mesh" in want:
        atomic_write_bytes(ctx.stage(f"models/{run}-mesh.glb"), data)
    if "tiles" in want:
        atomic_write_bytes(ctx.stage(f"photogrammetry/{run}/mesh/full.glb"), data)
    ctx.log(f"Mesh from ODM ({info['source']}): {info['triangles']:,} triangles.")
    ctx.progress(1.0)
    return {"triangles": info["triangles"], "meshSource": info["source"], "meshWarnings": warnings}


def _import_cloud(self: PhotoProducts, ctx: StepContext, s: dict, odm_dir: Path) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if "dtm" in s["products"] and ground_found(_Within(ctx, 0.7, 0.75), odm_dir / OR.GEOREF_LAZ) is False:
        # ODM's terrain model would never finish on a cloud without ground points
        ctx.log(NO_GROUND, "warn")
        out["ground"] = 0
    if "cloud" in s["products"]:
        run = ctx.params["run"]
        temp = self._work(ctx) / "cloud"
        ctx.progress(0.75, "Point cloud to COPC")
        info = OU.cloud_to_copc(
            _Within(ctx, 0.75, 1.0),
            odm_dir,
            ctx.stage(f"clouds/{run}.copc.laz"),
            _target(s),
            temp,
            native.memory_budget(),
        )
        shutil.rmtree(temp, ignore_errors=True)
        ctx.log(f"Point cloud: {info['points']:,} points; COPC by {info['writer']}.")
        out.update(points=int(info["points"]), writer=info["writer"])
    ctx.progress(1.0)
    return out


def _import_dems(self: PhotoProducts, ctx: StepContext, s: dict, odm_dir: Path) -> dict[str, Any]:
    want = set(s["products"])
    ground_z = OU.ground_height(OU.output_path(odm_dir, OU.DSM))
    which = [w for w in ("dsm", "dtm") if w in want and not (w == "dtm" and _no_ground(ctx))]
    layers = []
    for i, name in enumerate(which):
        lo, hi = 0.7 + 0.3 * i / len(which), 0.7 + 0.3 * (i + 1) / len(which)
        ctx.progress(lo, "Elevation model into the project")
        raw = self._work(ctx) / f"{name}.tif"
        spec = OU.dem_to_project(
            OU.output_path(odm_dir, OU.DSM if name == "dsm" else OU.DTM), raw, _target(s)
        )
        layers.append(self._surface_layer(ctx, s, raw, spec, name, ground_z, (lo, hi)))
    ctx.progress(1.0)
    return {"groundZ": ground_z, "layers": layers}


def _import_ortho(self: PhotoProducts, ctx: StepContext, s: dict, odm_dir: Path) -> dict[str, Any]:
    from .surface import to_cog

    run = ctx.params["run"]
    out: dict[str, Any] = {}
    if "ortho" in s["products"]:
        import rasterio

        ctx.progress(0.7, "Orthophoto into the project")
        src = OU.ortho_to_project(
            OU.output_path(odm_dir, OU.ORTHO), self._work(ctx) / "ortho.tif", _target(s)
        )
        to_cog(src, ctx.stage(f"photogrammetry/{run}/ortho.tif"), "average")
        with rasterio.open(src) as ds:
            res = abs(ds.transform.a)
        origin = np.array(s["origin"], dtype=np.float64)
        y = ctx.outputs("dsm")["groundZ"] - origin[2]
        lid = f"{run}-ortho"
        pyr = _pyramid(
            ctx, src, f"rasters/{lid}", origin, s["epsg"], y, res, {"source": "ortho.tif"}, (0.75, 1.0)
        )
        out.update(layer=lid, pyramid=pyr, resM=res)
    reports = []
    for rel, name in ((OU.REPORT_PDF, "odm-report.pdf"), (OU.STATS, "odm-stats.json")):
        src_file = odm_dir / rel
        if src_file.is_file():
            shutil.copyfile(src_file, ctx.stage(f"photogrammetry/{run}/report/{name}"))
            reports.append(name)
    out["reports"] = reports
    ctx.progress(1.0)
    return out


IMPORTS = {"texture": _import_mesh, "cloud": _import_cloud, "dsm": _import_dems, "ortho": _import_ortho}


def imports(step: str, s: dict) -> bool:
    """Whether a step has work after ODM (its bar then gives ODM 0 to 0.7 of the step)."""
    want = set(s["products"])
    if step == "texture":
        return bool(want & OF.MESH_PRODUCTS)
    if step == "cloud":
        return bool(want & {"cloud", "dtm"})
    return step in ("dsm", "ortho")


# ------------------------------------------------------------------------------------ pipeline


class PhotoProducts:
    name = "photo.products"
    title = "Create products from photos"
    description = "Point cloud, DSM and DTM, orthomosaic and textured mesh from an aligned run (ODM)."

    # parameters ----------------------------------------------------------------------------------
    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(
            params,
            {"run", "products", "preset", "gsdCm", "region", "capture", "meshTriangles"},
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
        (Not ``run.json``, which this job itself updates when it commits.)"""
        return [f"photogrammetry/{params['run']}/sparse"]

    # plan ------------------------------------------------------------------------------------------
    def plan(self, params: dict[str, Any]) -> list[Step]:
        want = made_products(params.get("preset"), params["products"])
        steps = [Step("prepare", "Check the run and plan the products", _timed(self._prepare), 0.5)]
        steps += [
            Step(s.name, s.title, _timed(self._odm_step(s)), s.weight) for s in OF.product_steps(set(want))
        ]
        steps.append(Step("commit", "Add the products to the project", _timed(self._commit), 0.5))
        if "tiles" in want:
            steps.append(Step("tiles", "Mesh to 3D Tiles", _timed(self._tiles), 2))
        return steps

    # shared state ------------------------------------------------------------------------------------
    def _settings(self, ctx: StepContext) -> dict[str, Any]:
        """The prepare step's outputs; a job begun by an earlier layout is refused."""
        s = ctx.outputs("prepare")
        if s.get("layout") != LAYOUT:
            raise JobError(OLD_LAYOUT)
        return s

    def _run_dir(self, ctx: StepContext) -> Path:
        return safe_project_path(ctx.project, f"photogrammetry/{ctx.params['run']}")

    def _work(self, ctx: StepContext) -> Path:
        work = self._run_dir(ctx) / "work" / "products"
        work.mkdir(parents=True, exist_ok=True)
        return work

    def _run_doc(self, ctx: StepContext) -> dict[str, Any]:
        path = self._run_dir(ctx) / "run.json"
        if not path.is_file():
            raise JobError(f'Run "{ctx.params["run"]}" was not found in this project.')
        return json.loads(path.read_text("utf-8-sig"))

    # steps ---------------------------------------------------------------------------------------------
    def _prepare(self, ctx: StepContext) -> dict[str, Any]:
        p = ctx.params
        run = p["run"]
        doc = self._run_doc(ctx)
        if doc.get("status") not in ("aligned", "adjusted", "done"):
            raise JobError(f'Run "{run}" is not aligned yet.')
        # the real folder first: run_odm_dir may make a junction, and must not for a run without one
        if not OP.has_alignment(OP.odm_project_dir(ctx.project, run)):
            raise JobError(OLD_RUN)
        odm_dir = OP.run_odm_dir(ctx.project, run)
        odm = OR.find_odm()
        mc = OR.machine()
        preset = p.get("preset") or doc.get("preset") or "standard"
        if preset not in PRESETS:
            preset = "standard"
        products = made_products(preset, p["products"])
        if products != p["products"]:
            ctx.log(FAST_NO_MODEL)
        if not products:
            raise JobError(
                "The Fast preset makes no 3D model; choose Standard or High for a mesh or 3D Tiles."
            )
        crs = C.crs_of(doc.get("crs"))
        epsg = crs.to_epsg()  # None for a site grid: its WKT then (GDAL, PDAL and PROJ take either)
        manifest = json.loads(safe_project_path(ctx.project, "manifest.json").read_text("utf-8-sig"))
        origin = manifest.get("origin")
        if not origin:
            raise JobError("The project has no origin, so the products cannot be placed.")
        ortho_cm = p.get("gsdCm") or self._align_gsd_cm(ctx) or DEFAULT_ORTHO_CM
        dem_cm = 2 * ortho_cm
        boundary = OP.write_boundary(odm_dir, p["region"]) if p.get("region") else None
        need = _bytes_under(odm_dir / "images") * DISK_FACTOR[preset]
        free = native.check_disk(ctx.project, need)
        args = OF.products_flags(
            preset, set(products), mc.use_gpu, mc.threads, ortho_cm, dem_cm, p.get("meshTriangles"), boundary
        )
        args = terrain_args(args, products)
        ctx.log(
            f"ODM {odm.version}, preset {preset}: ortho {ortho_cm:g} cm, DEM {dem_cm:g} cm, "
            f"{mc.threads} threads, graphics card {'on' if mc.use_gpu else 'off'}."
        )
        return {
            "layout": LAYOUT,
            "preset": preset,
            "products": products,
            "odmDir": str(odm_dir),
            "epsg": int(epsg) if epsg else None,
            "crs": int(epsg) if epsg else crs.to_wkt(),
            "origin": [float(v) for v in origin],
            "orthoResCm": float(ortho_cm),
            "demResCm": float(dem_cm),
            "threads": mc.threads,
            "gpu": mc.use_gpu,
            "args": args,
            "disk": {"neededBytes": int(need), "freeBytes": int(free)},
            "memoryBudgetBytes": native.memory_budget(),
            "version": odm.version,
        }

    def _align_gsd_cm(self, ctx: StepContext) -> float | None:
        """The photos' GSD that ``photo.align`` reported (``report/align.json``), if any."""
        from .align import reported_gsd_cm

        return reported_gsd_cm(self._run_dir(ctx))

    def _odm_step(self, step: OF.OdmStep):
        def run(ctx: StepContext) -> dict[str, Any]:
            s = self._settings(ctx)
            first = OF.dense_first(s["preset"]) if step.name == "dense" else step.first
            odm_dir = Path(s["odmDir"])
            args = s["args"]
            if step.name in ("dsm", "ortho") and _no_ground(ctx):
                args = [a for a in args if a != "--dtm"]  # ODM's DTM would never finish
            res = OR.run_odm(
                ctx, OR.find_odm(), odm_dir, args, first, step.last,
                self._run_dir(ctx) / "odm-logs" / f"{ctx.job.job_id}-{step.name}",
                rerun=True, use_gpu=s["gpu"], progress=(0.0, 0.7 if imports(step.name, s) else 1.0),
            )  # fmt: skip
            # "gpuFallbacks", never "fallbacks": a PhotoStage's "fallbacks" is a number in the schema
            out: dict[str, Any] = {
                "gpu": {"features": res.gpu.features, "dense": res.gpu.dense},
                "gpuFallbacks": res.gpu.fallbacks,
            }
            out.update(IMPORTS.get(step.name, _nothing)(self, ctx, s, odm_dir))
            return out

        return run

    def _surface_layer(
        self,
        ctx: StepContext,
        s: dict,
        raw: Path,
        spec,
        which: str,
        ground_z: float,
        span: tuple[float, float],
    ) -> dict[str, Any]:
        from .surface import shaded_tif, to_cog, write_height_grid

        run = ctx.params["run"]
        epsg = s["epsg"]
        origin = np.array(s["origin"], dtype=np.float64)
        lo, hi = span
        to_cog(raw, ctx.stage(f"photogrammetry/{run}/{which}.tif"), "average")
        shaded = self._work(ctx) / f"{which}-shaded.tif"
        legend = shaded_tif(raw, shaded, spec, epsg, ctx.check)
        ctx.progress(lo + 0.4 * (hi - lo), "Shaded relief")
        lid = f"{run}-{which}"
        y = ground_z - origin[2]
        pyr = _pyramid(
            ctx,
            shaded,
            f"rasters/{lid}",
            origin,
            epsg,
            y,
            spec.res,
            {"legend": legend["legend"], "source": f"{which}.tif"},
            (lo + 0.4 * (hi - lo), hi),
        )
        grid_dir = ctx.stage(f"sources/{lid}.json").parent
        write_height_grid(raw, grid_dir, lid, spec, epsg, "dsm")
        return {"layer": lid, "pyramid": pyr, "legend": legend["legend"]}

    def _gpu(self, ctx: StepContext) -> OR.GpuUse:
        """The graphics card's use over the ODM steps that ran."""
        g = OR.GpuUse(None, None)
        for name in STAGES:
            o = ctx.outputs(name)
            if isinstance(o.get("gpu"), dict):
                g = g.merge(
                    OR.GpuUse(
                        o["gpu"].get("features"), o["gpu"].get("dense"), list(o.get("gpuFallbacks") or [])
                    )
                )
        return g

    def _commit(self, ctx: StepContext) -> dict[str, Any]:
        s = self._settings(ctx)  # an older version's job is refused before anything is moved
        p = ctx.params
        run = p["run"]
        want = set(s["products"])
        rdir = f"photogrammetry/{run}"
        run_json = self._run_dir(ctx) / "run.json"
        mpath = safe_project_path(ctx.project, "manifest.json")
        manifest = json.loads(mpath.read_text("utf-8-sig"))
        doc = self._run_doc(ctx)
        ours = set(((doc.get("outputs") or {}).get("layers")) or [])
        layers: list[dict[str, Any]] = []
        files: list[str] = []
        cap = {"capture": p["capture"]} if p.get("capture") else {}
        label = run
        dtm_made = "dtm" in want and not _no_ground(ctx)

        def raster(which: str, role: str, title: str) -> None:
            lid = f"{run}-{which}"
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
        if dtm_made:
            raster("dtm", "dsm", "DTM")
        if "cloud" in want:
            n = int(ctx.outputs("cloud").get("points") or 0)
            layers.append(
                {
                    "kind": "pointcloud",
                    "id": f"{run}-cloud",
                    "name": f"Point cloud {label}",
                    "visible": True,
                    "src": {"path": f"clouds/{run}.copc.laz"},
                    "format": "copc",
                    **({"pointCount": n} if n else {}),
                    **cap,
                }
            )
        if "mesh" in want:
            layers.append(
                {
                    "kind": "mesh",
                    "id": f"{run}-mesh",
                    "name": f"Mesh {label}",
                    "visible": True,
                    "src": {"path": f"models/{run}-mesh.glb"},
                    "transform": IDENTITY,
                    **cap,
                }
            )
        if "tiles" in want:
            files.append(f"{rdir}/mesh/full.glb")
        files += [f"{rdir}/report/{name}" for name in ctx.outputs("ortho").get("reports") or []]
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
                old = ctx.out(f"rasters/{run}-{which}")
                made = dtm_made if which == "dtm" else which in want
                if made and old.exists():
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
        # run.json: status, stages, outputs, versions, engine, warnings; then the products report
        report = self._report(ctx, layers)
        atomic_write_json(ctx.out(f"{rdir}/report/products.json"), report)
        doc = self._run_doc(ctx)
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
        doc["versions"]["odm"] = s["version"]
        engine = OR.engine_record(OR.OdmInstall(Path(), s["version"]), self._gpu(ctx))
        # what alignment found out about the card (features) stays when these steps say nothing of it
        before = (doc.get("engine") or {}).get("gpu") or {}
        engine["gpu"] = {**{k: v for k, v in before.items() if k in ("features", "dense")}, **engine["gpu"]}
        doc["engine"] = engine
        warnings = list(doc.get("warnings") or [])
        warnings += [w for w in report["warnings"] if w not in warnings]
        if warnings:
            doc["warnings"] = [w[:500] for w in warnings[-1000:]]
        atomic_write_json(run_json, doc)
        ctx.artifact(f"{rdir}/run.json")
        freed = OP.clean_intermediates(Path(s["odmDir"]))
        ctx.log(f"Removed {native._gb(freed)} of ODM's intermediate files.")
        return {"layers": [x["id"] for x in layers], "files": len(moves), "freedBytes": freed}

    def _report(self, ctx: StepContext, layers: list[dict[str, Any]]) -> dict[str, Any]:
        s = self._settings(ctx)
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
        gpu = self._gpu(ctx)
        warnings: list[str] = []
        for w in gpu.fallbacks:
            if w not in warnings:
                warnings.append(w)
        if _no_ground(ctx):
            warnings.append(NO_GROUND)
        for w in ctx.outputs("texture").get("meshWarnings") or []:
            if w not in warnings:
                warnings.append(w)
        cloud = ctx.outputs("cloud")
        texture = ctx.outputs("texture")
        return {
            "schema": PRODUCTS_SCHEMA,
            "run": ctx.params["run"],
            "createdAt": now_iso(),
            "preset": s["preset"],
            "products": s["products"],
            "layers": [x["id"] for x in layers],
            "gsdCm": {"ortho": s["orthoResCm"], "dsm": s["demResCm"]},
            "engines": {"odm": s["version"]},
            "gpu": {k: v for k, v in (("features", gpu.features), ("dense", gpu.dense)) if v is not None},
            **(
                {"cloud": {"points": cloud["points"], "writer": cloud["writer"]}}
                if cloud.get("writer")
                else {}
            ),
            **(
                {"mesh": {"triangles": texture["triangles"], "source": texture["meshSource"]}}
                if texture.get("triangles")
                else {}
            ),
            "stages": stages,
            "memoryPeakBytes": peak,
            "memoryBudgetBytes": s["memoryBudgetBytes"],
            "disk": s["disk"],
            "warnings": warnings,
        }

    def _tiles(self, ctx: StepContext) -> dict[str, Any]:
        """The full mesh to 3D Tiles through G7's ``tiles.mesh``, as a job inside this one."""
        from ..tiles.mesh import TilesMesh

        s = self._settings(ctx)  # an older version's job is refused here too
        if "tiles" not in s["products"]:  # the Fast preset of the run left the 3D model out
            return {"ok": False, "skipped": True}
        run = ctx.params["run"]
        tid = f"{run}-mesh"[:80]
        params = {
            "src": f"photogrammetry/{run}/mesh/full.glb",
            "run": run,
            "id": tid,
            "name": f"Mesh {run}",
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
        path = self._run_dir(ctx) / "run.json"
        doc = json.loads(path.read_text("utf-8-sig"))
        if warning:
            doc["warnings"] = [*(doc.get("warnings") or []), warning[:500]][-1000:]
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
