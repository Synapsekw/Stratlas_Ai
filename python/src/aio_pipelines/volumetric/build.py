"""volumetric.build: raw survey rasters (or point clouds) per date -> a complete volumetric project.

Runs the Volumetric Survey Kit end to end inside one resumable job (the kit's README steps):

    prepare     resolve the job: sources, CRS, the common grid (derived from the inputs when the
                job does not give one); point clouds other than LAS go through PDAL
    dsm-1/2     a point cloud becomes a DSM GeoTIFF (cloud.py); resample.py dsm (grid.py)
    ortho-1/2   resample.py ortho and pyramid.py (ortho.py); point colours stand in for an ortho
    process     process.py: yard floor, pile zones, toe lines, four bases, volumes, change
    package     package.py + pack3d.py: the kit's grids (data/*.js) and authoritative volumes
    terrain     terrain meshes with the site photo, ortho pyramids, volumes.json (aio.volumes/1)
    commit      files into the project, volumes.json, then the manifest (layers, captures) last

The project then opens in the native volumetric workspace like the imported Masafi project
(data-conventions section 10): register, bodies, sections and the boundary editor read the kit
grids through ``volumes.json`` ``grids``. The resolved job is kept as ``volumetric/job.json``;
edit its ``detect`` block (yard polygon, clip lines, excluded zones, as in the kit) and run the
job again with ``job: volumetric/job.json``.

A resume skips finished steps. It is refused when an input changed since the job started: the
runtime hashes the inputs of an inline config, and ``prepare`` records a hash of the resolved
sources that every later step checks (that also covers a job file's sources).
"""

from __future__ import annotations

import json
import math
import pickle
import re
import shutil
from datetime import date as Date
from pathlib import Path
from typing import Any

from ..params import known_keys, text
from ..runtime import (
    INPUTS_CHANGED,
    JobError,
    Step,
    StepContext,
    atomic_write_bytes,
    atomic_write_json,
    commit_files,
    commit_tree,
    input_fingerprint,
    safe_project_path,
)

EPOCH_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,15}$")
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
CLOUD_EXT = {".las", ".laz", ".e57", ".ply"}
RASTER_EXT = {".tif", ".tiff"}
KIT_DSM_RES = 0.1  # the kit's grid: its thresholds and morphology are in 0.5 m cells of 5 x 0.1 m
MAX_ORTHO_PX = 4.0e8
VOLUME_DEFAULTS = {"deadband_m": 0.1, "default_base": "tin", "density_t_m3": 1.6, "swell": 1.0}
BASE_LABELS = [
    {"id": "tin", "label": "Triangulated toe"},
    {"id": "plane", "label": "Best-fit plane"},
    {"id": "avg", "label": "Average toe"},
    {"id": "low", "label": "Lowest toe"},
]
EPOCH_META = ("gsd_cm", "cp_rmse_z_m", "gcps", "checkpoints", "images", "camera", "processing")
LATTICE_M = 0.5
REGION_BUFFER_M = 1.5
ORTHO_LEVELS = 4  # the finest level and three below it, as the Masafi import keeps
ORTHO_NODATA = (0x14, 0x1B, 0x24)  # the stage background under alpha 0 (the raster adapter is opaque)
JOB_OUT = "volumetric/job.json"
KIT_DIR = "volumetric"


def _label(d: str) -> str:
    y, m, dd = (int(x) for x in d.split("-"))
    return Date(y, m, dd).strftime("%d %b %Y").lstrip("0")


def _check_config(cfg: Any) -> dict[str, Any]:
    if not isinstance(cfg, dict):
        raise JobError("The volumetric job must be an object with epochs.")
    eps = cfg.get("epochs")
    if not isinstance(eps, list) or not 1 <= len(eps) <= 2:
        raise JobError("epochs must list one or two survey dates.")
    for i, e in enumerate(eps, 1):
        if not isinstance(e, dict):
            raise JobError(f"Survey {i} must be an object.")
        eid = e.get("id", f"e{i}")
        if not isinstance(eid, str) or not EPOCH_ID.match(eid):
            raise JobError("Each survey needs a short lower-case id such as e1.")
        if not isinstance(e.get("date"), str) or not ISO_DATE.match(e["date"]):
            raise JobError(f"Survey {eid} needs a date as YYYY-MM-DD.")
        try:
            _label(e["date"])
        except ValueError as ex:
            raise JobError(f"Survey {eid}: {e['date']} is not a date.") from ex
        has_dsm = isinstance(e.get("dsm"), str) and e["dsm"].strip()
        has_cloud = isinstance(e.get("cloud"), str) and e["cloud"].strip()
        if bool(has_dsm) == bool(has_cloud):
            raise JobError(f"Survey {eid} needs either a DSM GeoTIFF (dsm) or a point cloud (cloud).")
        if has_dsm and Path(e["dsm"]).suffix.lower() not in RASTER_EXT:
            raise JobError(f"Survey {eid}: the DSM must be a GeoTIFF (.tif).")
        if has_cloud and Path(e["cloud"]).suffix.lower() not in CLOUD_EXT:
            raise JobError(f"Survey {eid}: the point cloud must be LAS, LAZ, E57 or PLY.")
        if e.get("ortho") is not None and (
            not isinstance(e["ortho"], str) or Path(e["ortho"]).suffix.lower() not in RASTER_EXT
        ):
            raise JobError(f"Survey {eid}: the orthomosaic must be a GeoTIFF (.tif).")
    ids = [e.get("id", f"e{i}") for i, e in enumerate(eps, 1)]
    if len(set(ids)) != len(ids):
        raise JobError("Survey ids must differ.")
    if len({e["date"] for e in eps}) != len(eps):
        raise JobError("Two surveys have the same date.")
    if [e["date"] for e in eps] != sorted(e["date"] for e in eps):
        raise JobError("List the surveys in date order, first to last.")
    g = cfg.get("grid")
    if g is not None:
        if not isinstance(g, dict) or not all(
            isinstance(g.get(k), int | float) for k in ("x0", "y0", "x1", "y1")
        ):
            raise JobError("grid needs x0, y0, x1, y1 (metres, in the project CRS).")
        if g["x1"] <= g["x0"] or g["y1"] <= g["y0"]:
            raise JobError("grid bounds must run from x0, y0 (bottom left) to x1, y1 (top right).")
    for k in ("detect", "volume"):
        if cfg.get(k) is not None and not isinstance(cfg[k], dict):
            raise JobError(f"{k} must be an object.")
    return cfg


def _sources(e: dict) -> list[str]:
    return [e[k] for k in ("dsm", "ortho", "cloud") if isinstance(e.get(k), str)]


class VolumetricBuild:
    name = "volumetric.build"
    title = "Volumetric survey"
    description = (
        "Runs the Volumetric Survey Kit on raw DSM and ortho GeoTIFFs (or point clouds) per date: "
        "piles, toe lines, four bases, volumes, change, terrain meshes; the project opens in the "
        "volumetric workspace."
    )

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(params, {"job", "config"}, self.name)
        if "config" in params:
            return {"config": _check_config(params["config"])}
        return {"job": text(params, "job", JOB_OUT)}

    def inputs(self, params: dict[str, Any]) -> list[str]:
        if "config" in params:
            return [s for e in params["config"]["epochs"] for s in _sources(e)]
        return [params["job"]]

    # ------------------------------------------------------------ helpers

    def _raw_config(self, ctx: StepContext) -> tuple[dict[str, Any], Path]:
        if "config" in ctx.params:
            return ctx.params["config"], ctx.project
        p = ctx.input(ctx.params["job"])
        try:
            cfg = json.loads(p.read_text("utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            raise JobError(f"Could not read the volumetric job {p.name}: {e}") from e
        return _check_config(cfg), p.parent

    @staticmethod
    def _job(ctx: StepContext) -> dict[str, Any]:
        """The resolved job written by prepare; checks the sources have not changed since."""
        job = json.loads(ctx.stage("job.json").read_text("utf-8"))
        now = input_fingerprint(ctx.project, job["_sources"])
        if now["hash"] != job["_fingerprint"]:
            raise JobError(INPUTS_CHANGED.replace("input photos", "survey files"))
        return job

    # ------------------------------------------------------------ steps

    def plan(self, params: dict[str, Any]) -> list[Step]:
        def prepare(ctx: StepContext) -> dict[str, Any]:
            cfg, base = self._raw_config(ctx)
            manifest = json.loads(safe_project_path(ctx.project, "manifest.json").read_text("utf-8"))
            epsg = (manifest.get("crs") or {}).get("epsg")
            epochs = []
            for i, e in enumerate(cfg["epochs"], 1):
                r = {k: v for k, v in e.items() if k not in ("dsm", "ortho", "cloud")}
                r["id"] = e.get("id", f"e{i}")
                r.setdefault("label", _label(e["date"]))
                for k in ("dsm", "ortho", "cloud"):
                    if isinstance(e.get(k), str):
                        p = Path(e[k])
                        p = p if p.is_absolute() else base / p
                        if not p.is_file():
                            raise JobError(f"Survey {r['label']}: {k} file not found: {p}")
                        r[k] = str(p.resolve())
                epochs.append(r)
            sources = [s for e in epochs for s in _sources(e)]
            # point clouds PDAL must convert first (LAS is read directly)
            for e in epochs:
                ctx.check()
                if "cloud" in e and Path(e["cloud"]).suffix.lower() != ".las":
                    las = ctx.stage(f"work/cloud_{e['id']}.las")
                    if not las.exists():
                        from .cloud import to_las

                        ctx.log(f"Converting {Path(e['cloud']).name} to LAS with PDAL")
                        to_las(Path(e["cloud"]), las, epsg, lambda st: _pdal(ctx, st))
                    e["las"] = str(las)
                elif "cloud" in e:
                    e["las"] = e["cloud"]
            grid = _grid(cfg.get("grid"), epochs, epsg, ctx)
            job = {
                "title": cfg.get("title") or manifest.get("name"),
                "customer": cfg.get("customer") or manifest.get("customer"),
                "site": cfg.get("site") or manifest.get("site"),
                "crs": f"EPSG:{epsg}" if epsg else None,
                "grid": grid,
                "epochs": epochs,
                "volume": {**VOLUME_DEFAULTS, **(cfg.get("volume") or {})},
                "detect": cfg.get("detect") or {},
                "_sources": sources,
                "_fingerprint": input_fingerprint(ctx.project, sources)["hash"],
            }
            atomic_write_json(ctx.stage("job.json"), job)
            W = round((grid["x1"] - grid["x0"]) / grid["dsm_res"])
            H = round((grid["y1"] - grid["y0"]) / grid["dsm_res"])
            ctx.log(
                f"Grid {grid['x1'] - grid['x0']:.0f} x {grid['y1'] - grid['y0']:.0f} m from E {grid['x0']}, "
                f"N {grid['y0']}: DSM {W} x {H} cells at {grid['dsm_res']} m, ortho {grid['ortho_res']} m "
                f"in {grid['zmax'] + 1} levels"
            )
            return {"epochs": [e["id"] for e in epochs], "grid": grid}

        def dsm(i: int):
            def run(ctx: StepContext) -> dict[str, Any]:
                from .grid import resample_dsm

                job = self._job(ctx)
                if i >= len(job["epochs"]):
                    return {"skipped": True}
                e = job["epochs"][i]
                src = Path(e["dsm"]) if "dsm" in e else None
                if src is None:
                    from .cloud import rasterise

                    tif = ctx.stage(f"work/cloud_{e['id']}_dsm.tif")
                    rgb = ctx.stage(f"work/cloud_{e['id']}_rgb.tif")
                    if not tif.exists():
                        ctx.log(f"Gridding the point cloud of {e['label']} at {job['grid']['dsm_res']} m")
                        info = rasterise(
                            Path(e["las"]),
                            job["grid"],
                            tif,
                            None if "ortho" in e else rgb,
                            _epsg(job),
                            ctx.check,
                            lambda f: ctx.progress(0.5 * f, "Point cloud to DSM"),
                        )
                        ctx.log(f"{info['points']:,} points, {info['cells']:,} cells with data")
                    src = tif
                ctx.log(f"Resampling {src.name} to {job['grid']['dsm_res']} m cells")
                H, W = resample_dsm(
                    src,
                    job["grid"],
                    ctx.stage(f"work/dsm_{e['id']}.npy"),
                    ctx.check,
                    lambda f: ctx.progress(f if "dsm" in e else 0.5 + 0.5 * f),
                )
                return {"epoch": e["id"], "rows": H, "cols": W}

            return run

        def ortho(i: int):
            def run(ctx: StepContext) -> dict[str, Any]:
                from .ortho import build_pyramid, resample_ortho

                job = self._job(ctx)
                if i >= len(job["epochs"]):
                    return {"skipped": True}
                e = job["epochs"][i]
                src = Path(e["ortho"]) if "ortho" in e else ctx.stage(f"work/cloud_{e['id']}_rgb.tif")
                if not src.exists():
                    ctx.log(
                        f"{e['label']}: no orthomosaic and no point colours; the terrain stays untextured.",
                        "warn",
                    )
                    return {"epoch": e["id"], "tiles": 0}
                tiles = ctx.stage(f"tiles/{e['id']}")
                ctx.log(f"Tiling {src.name} at {job['grid']['ortho_res']} m")
                r = resample_ortho(
                    src,
                    job["grid"],
                    tiles,
                    ctx.stage(f"work/ortho_{e['id']}.progress"),
                    ctx.check,
                    lambda f: ctx.progress(0.85 * f, "Ortho tiles"),
                )
                counts = build_pyramid(tiles, job["grid"], ctx.check)
                ctx.log(f"{e['label']}: {r['tiles']} tiles at the finest level, {len(counts)} levels")
                return {"epoch": e["id"], "tiles": r["tiles"], "levels": len(counts)}

            return run

        def process(ctx: StepContext) -> dict[str, Any]:
            import numpy as np

            from .process import process as run_process

            job = self._job(ctx)
            Z10 = {e["id"]: np.load(ctx.stage(f"work/dsm_{e['id']}.npy")) for e in job["epochs"]}
            work: dict = {}
            kit_job = {k: v for k, v in job.items() if not k.startswith("_")}
            res = run_process(kit_job, Z10, log=ctx.log, check=ctx.check, progress=ctx.progress, work=work)
            if not res["piles"]:
                ctx.log("No pile was found. Check the grid, the yard polygon and the minimum size.", "warn")
            np.save(ctx.stage("work/zones05.npy"), work["zones"])
            for e, lab in work["labels"].items():
                np.save(ctx.stage(f"work/lab05_{e}.npy"), lab)
            atomic_write_bytes(ctx.stage("work/piledata.pkl"), pickle.dumps(work["piledata"]))
            atomic_write_json(ctx.stage("piles.json"), res)
            return {"piles": len(res["piles"])}

        def package(ctx: StepContext) -> dict[str, Any]:
            import numpy as np

            from .package import package as run_package

            job = self._job(ctx)
            Z10 = {e["id"]: np.load(ctx.stage(f"work/dsm_{e['id']}.npy")) for e in job["epochs"]}
            res = json.loads(ctx.stage("piles.json").read_text("utf-8"))
            PD = pickle.loads(ctx.stage("work/piledata.pkl").read_bytes())
            ZL = np.load(ctx.stage("work/zones05.npy"))
            out = ctx.stage(f"out/{KIT_DIR}")
            kit_job = {k: v for k, v in job.items() if not k.startswith("_")}
            site = run_package(
                kit_job, Z10, res, PD, ZL, ctx.stage("tiles"), out, ctx.log, ctx.check, ctx.progress
            )
            atomic_write_json(ctx.stage("site.json"), site)
            tot = site["totals"]
            return {"piles": len(site["piles"]), "totals": {e: tot[e]["tin"] for e in tot}}

        def terrain(ctx: StepContext) -> dict[str, Any]:
            job = self._job(ctx)
            site = json.loads(ctx.stage("site.json").read_text("utf-8"))
            manifest = json.loads(safe_project_path(ctx.project, "manifest.json").read_text("utf-8"))
            return _publish(ctx, job, site, manifest)

        def commit(ctx: StepContext) -> dict[str, Any]:
            job = self._job(ctx)
            pub = ctx.outputs("terrain")
            n = 0
            for d in ("volumetric", "models", "rasters"):
                n += commit_tree(ctx, f"out/{d}", d)
            if ctx.stage("out/thumbnail.jpg").exists():
                commit_files(ctx, [("out/thumbnail.jpg", "thumbnail.jpg")])
            # the index files go last: volumes.json, then the manifest
            commit_files(ctx, [("out/volumes.json", "volumes.json")])
            mpath = safe_project_path(ctx.project, "manifest.json")
            manifest = json.loads(mpath.read_text("utf-8"))
            _merge_manifest(manifest, pub["layers"], pub["captures"])
            shutil.copyfile(mpath, mpath.with_name("manifest.json.bak"))
            atomic_write_json(mpath, manifest, indent=2)
            ctx.artifact("manifest.json")
            ctx.log(f"Added {len(pub['layers'])} layers and {len(job['epochs'])} surveys to the project.")
            return {"files": n, "layers": [x["id"] for x in pub["layers"]]}

        return [
            Step("prepare", "Read the surveys and set the grid", prepare, weight=0.5),
            Step("dsm-1", "DSM of survey 1", dsm(0), weight=3),
            Step("dsm-2", "DSM of survey 2", dsm(1), weight=3),
            Step("ortho-1", "Ortho tiles of survey 1", ortho(0), weight=3),
            Step("ortho-2", "Ortho tiles of survey 2", ortho(1), weight=3),
            Step("process", "Detect piles, toe lines, bases and volumes", process, weight=6),
            Step("package", "Package the kit grids", package, weight=2),
            Step("terrain", "Terrain meshes, ortho pyramids and volumes", terrain, weight=3),
            Step("commit", "Write to the project", commit, weight=0.3),
        ]


# ---------------------------------------------------------------- prepare helpers


def _epsg(job: dict) -> int | None:
    m = re.match(r"EPSG:(\d+)$", job.get("crs") or "")
    return int(m.group(1)) if m else None


def _pdal(ctx: StepContext, stages: list) -> None:
    from ..pointcloud import PDAL_MISSING, _run, find_pdal

    pdal = find_pdal()
    if not pdal:
        raise JobError(PDAL_MISSING)
    pipe = ctx.stage("work/pdal.json")
    atomic_write_json(pipe, {"pipeline": stages})
    _run(ctx, [pdal, "pipeline", str(pipe)], "Convert the point cloud")


def _grid(given: dict | None, epochs: list[dict], epsg: int | None, ctx: StepContext) -> dict:
    """The kit's common grid: the given bounds, else the union of the DSM / cloud extents in whole
    metres; 0.1 m DSM cells; ortho cells at the finest orthomosaic's pixel (or the DSM cell)."""
    import rasterio

    from .cloud import LasHeader
    from .grid import source_res

    exts = []
    ortho_px = []
    for e in epochs:
        if "dsm" in e:
            with rasterio.open(e["dsm"]) as d:
                _check_crs(d, epsg, e["label"], "DSM", ctx)
                exts.append(tuple(d.bounds))
        else:
            h = LasHeader(Path(e["las"]))
            exts.append(h.bounds)
            if h.count == 0:
                raise JobError(f"The point cloud of {e['label']} is empty.")
        if "ortho" in e:
            with rasterio.open(e["ortho"]) as d:
                _check_crs(d, epsg, e["label"], "orthomosaic", ctx)
                if d.count < 3:
                    raise JobError(f"The orthomosaic of {e['label']} has {d.count} band(s); it needs RGB.")
                ortho_px.append(source_res(d))
    g = dict(given or {})
    if not given:
        g["x0"] = math.floor(min(x[0] for x in exts))
        g["y0"] = math.floor(min(x[1] for x in exts))
        g["x1"] = math.ceil(max(x[2] for x in exts))
        g["y1"] = math.ceil(max(x[3] for x in exts))
    g.setdefault("dsm_res", KIT_DSM_RES)
    if g["dsm_res"] != KIT_DSM_RES:
        ctx.log(
            f"dsm_res {g['dsm_res']} m: the kit's thresholds are tuned for {KIT_DSM_RES} m cells.", "warn"
        )
    w_m, h_m = g["x1"] - g["x0"], g["y1"] - g["y0"]
    if (w_m / g["dsm_res"]) * (h_m / g["dsm_res"]) > 400e6:
        raise JobError(
            f"The survey area is {w_m:.0f} x {h_m:.0f} m, over 400 million DSM cells. "
            "Give a smaller grid in the job."
        )
    if "ortho_res" not in g:
        r = max(0.01, round(min(ortho_px), 3)) if ortho_px else g["dsm_res"]
        while (w_m / r) * (h_m / r) > MAX_ORTHO_PX:
            r = round(r * 2, 3)
        g["ortho_res"] = r
    g.setdefault("tile", 1024)
    if "zmax" not in g:
        px = max(w_m, h_m) / g["ortho_res"]
        g["zmax"] = max(0, math.ceil(math.log2(px / g["tile"]))) if px > g["tile"] else 0
    return g


def _check_crs(d, epsg: int | None, label: str, what: str, ctx: StepContext) -> None:
    if d.crs is None:
        ctx.log(f"The {what} of {label} declares no CRS; it is taken as the project CRS.", "warn")
        return
    got = d.crs.to_epsg()
    if epsg and got and got != epsg:
        raise JobError(
            f"The {what} of {label} is in EPSG:{got}, the project in EPSG:{epsg}. "
            "Export it in the project CRS, then run the job again."
        )


# ---------------------------------------------------------------- terrain, ortho, volumes.json


def _fmt_m3(v: float) -> str:
    return f"{round(v):,} m³"


def _publish(ctx: StepContext, job: dict, site: dict, manifest: dict) -> dict:
    """Terrain GLBs, ortho pyramids, thumbnail and volumes.json into staging/out (masafi.ts)."""
    import numpy as np
    from PIL import Image

    from .package import site_photo
    from .terrain import block_mean, build_terrain, terrain_glb, toe_line

    G = job["grid"]
    EPS = [e["id"] for e in job["epochs"]]
    epoch = {e["id"]: e for e in job["epochs"]}
    origin = manifest.get("origin") or [(G["x0"] + G["x1"]) / 2, (G["y0"] + G["y1"]) / 2, 0]
    E0, N0, H0 = (float(v) for v in origin)
    far = math.hypot((G["x0"] + G["x1"]) / 2 - E0, (G["y0"] + G["y1"]) / 2 - N0)
    if far > 5000:
        ctx.log(f"The project origin is {far / 1000:.1f} km from the survey; set it near the site.", "warn")

    def loc(e, n):
        return [round(e - E0, 3), round(-(n - N0), 3)]

    piles = site["piles"]
    f = max(1, round(LATTICE_M / G["dsm_res"]))
    lattices = {}
    for e in EPS:
        z = np.load(ctx.stage(f"work/dsm_{e}.npy"), mmap_mode="r")
        lattices[e] = block_mean(z, G["dsm_res"], G["x0"], G["y1"], f)
    min_h = min(float(np.nanmin(g.z)) for g in lattices.values())
    layers: list[dict] = []
    latest = EPS[-1]
    tiles = ctx.stage("tiles")
    thumb = None
    for k, e in enumerate(reversed(EPS)):
        ctx.check()
        ep = epoch[e]
        lat = lattices[e]
        present = [p for p in piles if e in p["epochs"]]
        has_tiles = (tiles / e / str(G["zmax"])).is_dir() and any((tiles / e / str(G["zmax"])).glob("*.webp"))
        tex = None
        if has_tiles:
            im = site_photo(tiles, G, e)
            tex = _jpeg(im, 80)
            if e == latest:
                thumb = im
        ground, regions = build_terrain(
            lat,
            (E0, N0, H0),
            [(f"{p['id']}_{e}", p["zone_ring"]) for p in present],
            REGION_BUFFER_M,
            (G["x0"], G["y0"], G["x1"], G["y1"]),
        )
        rings = {f"{p['id']}_{e}": p["epochs"][e]["ring"] for p in present}
        glb = terrain_glb(
            e,
            ground,
            regions,
            tex,
            lambda node, rings=rings, lat=lat: (
                toe_line(rings[node], lat, (E0, N0, H0)) if node in rings else None
            ),
        )
        rel = f"models/terrain-{ep['date']}.glb"
        atomic_write_bytes(ctx.stage(f"out/{rel}"), glb)
        tris = (ground.indices.size + sum(r.indices.size for r in regions)) // 3
        ctx.log(
            f"Terrain {ep['label']}: {tris:,} triangles, {len(regions)} pile nodes, {len(glb) / 1e6:.1f} MB"
        )
        layers.append(
            {
                "kind": "mesh",
                "id": f"terrain-{ep['date']}",
                "name": f"Terrain {ep['label']}",
                "visible": e == latest,
                "src": {"path": rel},
                "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
                "tags": [
                    {
                        "node": f"{p['id']}_{e}",
                        "tag": p["id"],
                        "area": _fmt_m3(p["epochs"][e]["vol"]["tin"]["net"]),
                    }
                    for p in present
                ],
            }
        )
        ctx.progress(0.1 + 0.4 * (k + 1) / len(EPS), f"Terrain {ep['label']}")

    # ortho pyramids (kit-pyramid), the finest ORTHO_LEVELS levels, no-data tiles padded
    ortho_y = round(min_h - H0 - 0.3, 2)
    for k, e in enumerate(reversed(EPS)):
        ctx.check()
        ep = epoch[e]
        tdir = tiles / e
        if not (tdir / str(G["zmax"])).is_dir():
            continue
        lay = _ortho_pyramid(ctx, tdir, e, G, (E0, N0, H0), ortho_y)
        if lay is None:
            continue
        layers.append(
            {
                "kind": "raster",
                "id": f"ortho-{ep['date']}",
                "name": f"Ortho {ep['label']}",
                "visible": e == latest,
                "src": {"path": lay["tiles"]},
                "role": "ortho",
                "format": "kit-pyramid",
                "corners": lay["corners"],
            }
        )
        ctx.progress(0.5 + 0.4 * (k + 1) / len(EPS), f"Ortho {ep['label']}")

    if thumb is not None:
        t = thumb.copy()
        t.thumbnail((960, 960), Image.LANCZOS)
        atomic_write_bytes(ctx.stage("out/thumbnail.jpg"), _jpeg(t, 82))

    captures = [{"epoch": e, "date": epoch[e]["date"], "label": epoch[e]["label"]} for e in EPS]
    cap_ids = _capture_ids(manifest, captures)
    zero = {"fill": 0.0, "cut": 0.0, "net": 0.0}
    two = len(EPS) == 2
    pile_docs = []
    for p in piles:
        eps = {}
        for e, m in p["epochs"].items():
            eps[e] = {
                "captureId": cap_ids[e],
                "areaM2": m["area_m2"],
                "topM": m["top_m"],
                "heightM": m["height_m"],
                "surveyErrM3": m.get("survey_err_m3"),
                "groundToeFrac": m.get("ground_toe_frac"),
                "node": f"{p['id']}_{e}",
                "ring": [loc(x, y) for x, y in m["ring"]],
                "volumes": {b["id"]: m["vol"][b["id"]] for b in BASE_LABELS},
            }
        ring = np.asarray(p["zone_ring"], dtype=np.float64)
        pile_docs.append(
            {
                "id": p["id"],
                "name": p["name"],
                "material": p.get("material"),
                "status": p.get("status"),
                "centreEN": [round(float(v), 2) for v in _centroid(ring)],
                "zoneRing": [loc(x, y) for x, y in p["zone_ring"]],
                "epochs": eps,
                "change": p.get("change") or dict(zero),
            }
        )
    vol = job["volume"]
    doc = {
        "schema": "aio.volumes/1",
        "source": "Volumetric Survey Kit, run in Stratlas (volumetric.build)",
        "units": {"volume": "m3", "area": "m2", "length": "m"},
        "frame": "rings are [x, z] in the project local frame (x east, z south); centreEN in the project CRS",
        "densityTPerM3": vol["density_t_m3"],
        "swell": vol.get("swell", 1),
        "deadbandM": vol["deadband_m"],
        "defaultBase": vol["default_base"],
        "bases": BASE_LABELS,
        "captures": [
            {
                "epoch": c["epoch"],
                "captureId": cap_ids[c["epoch"]],
                "date": c["date"],
                "label": c["label"],
                "layers": [
                    x["id"] for x in layers if x["id"] in (f"terrain-{c['date']}", f"ortho-{c['date']}")
                ],
            }
            for c in captures
        ],
        "grids": {
            "format": "vs-kit-js",
            "piles": f"{KIT_DIR}/data/piles/{{id}}.js",
            "dsm": f"{KIT_DIR}/data/dsm_{{epoch}}.js",
            "coarse": f"{KIT_DIR}/data/vol.js",
        },
        "piles": pile_docs,
        "totals": site["totals"],
        "pileChange": site.get("pile_change") if two else dict(zero),
        "siteChange": site.get("site_change") if two else dict(zero),
        "aoi": [loc(x, y) for x, y in site["aoi"]] if site.get("aoi") else None,
        "excluded": [
            {"reason": x["reason"], "ring": [loc(a, b) for a, b in x["ring"]]}
            for x in site.get("excluded", [])
        ],
    }
    atomic_write_json(ctx.stage("out/volumes.json"), doc)
    kit_job = {k: v for k, v in job.items() if not k.startswith("_") and k != "grid"}
    kit_job["grid"] = G
    kit_job["epochs"] = [{k: v for k, v in e.items() if k != "las"} for e in job["epochs"]]
    atomic_write_json(ctx.stage(f"out/{JOB_OUT}"), kit_job)
    ctx.progress(1.0, "Volumes")
    return {
        "layers": layers,
        "captures": [
            {"id": cap_ids[c["epoch"]], "label": f"Drone survey {c['label']}", "date": c["date"]}
            for c in captures
        ],
        "piles": len(pile_docs),
    }


def _jpeg(im, q: int) -> bytes:
    import io

    bio = io.BytesIO()
    im.convert("RGB").save(bio, "JPEG", quality=q, optimize=True)
    return bio.getvalue()


def _centroid(ring) -> tuple[float, float]:
    """Area centroid of a ring (masafi.ts ringCentroid)."""
    a = cx = cy = 0.0
    n = len(ring)
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[i - 1]
        f = xj * yi - xi * yj
        a += f
        cx += (xi + xj) * f
        cy += (yi + yj) * f
    if abs(a) < 1e-9:
        return (float(ring[0][0]), float(ring[0][1])) if n else (0.0, 0.0)
    return cx / (3 * a), cy / (3 * a)


def _capture_ids(manifest: dict, captures: list[dict]) -> dict[str, str]:
    """A manifest capture on the same date is reused; otherwise ``survey-<date>``."""
    by_date = {c.get("date"): c.get("id") for c in manifest.get("captures") or []}
    return {c["epoch"]: by_date.get(c["date"]) or f"survey-{c['date']}" for c in captures}


def _merge_manifest(manifest: dict, layers: list[dict], captures: list[dict]) -> None:
    """Replace layers with the same id (a re-run), keep everything else; add missing captures."""
    ids = {x["id"] for x in layers}
    kept = [x for x in manifest.get("layers") or [] if x.get("id") not in ids]
    manifest["layers"] = kept + layers
    have = {c.get("id") for c in manifest.get("captures") or []}
    caps = list(manifest.get("captures") or [])
    for c in captures:
        if c["id"] not in have:
            caps.append(c)
    manifest["captures"] = sorted(caps, key=lambda c: c.get("date") or "")
    manifest.setdefault("type", "volumetric")


def _ortho_pyramid(ctx: StepContext, tdir: Path, e: str, G: dict, origin, ortho_y: float) -> dict | None:
    """masafi.ts orthomosaic section with ``orthoPyramidPlan``: the finest levels, every level
    spanning the same whole-tile window from the grid corner; missing tiles are 64 px no-data
    tiles; RGB under alpha 0 is the stage background."""
    import numpy as np
    from PIL import Image

    source = []
    for zd in tdir.iterdir():
        if zd.is_dir() and zd.name.isdigit():
            for f in zd.glob("*.webp"):
                m = re.match(r"^(\d+)_(\d+)$", f.stem)
                if m:
                    source.append((int(zd.name), int(m.group(1)), int(m.group(2))))
    if not source:
        return None
    z_top = max(t[0] for t in source)
    z_min = max(min(t[0] for t in source), z_top - (ORTHO_LEVELS - 1))
    src = [t for t in source if t[0] >= z_min]
    cols = rows = 0
    for z, x, y in src:
        k = 2 ** (z_top - z)
        cols, rows = max(cols, (x + 1) * k), max(rows, (y + 1) * k)
    step = 2 ** (z_top - z_min)
    cols, rows = math.ceil(cols / step) * step, math.ceil(rows / step) * step
    have = set(src)
    pattern = f"rasters/ortho-{e}/{{z}}/{{x}}_{{y}}.webp"
    levels = []
    T = G.get("tile", 1024)
    blank = None
    for z in range(z_min, z_top + 1):
        ctx.check()
        k = 2 ** (z_top - z)
        lv = {"z": z, "tileSize": T, "cols": cols // k, "rows": rows // k, "pattern": pattern}
        levels.append(lv)
        for y in range(lv["rows"]):
            for x in range(lv["cols"]):
                out = ctx.stage(f"out/rasters/ortho-{e}/{z}/{x}_{y}.webp")
                if out.exists():
                    continue
                if (z, x, y) in have:
                    with Image.open(tdir / str(z) / f"{x}_{y}.webp") as im:
                        t = im.convert("RGBA")
                    if t.size != (T, T):
                        c = Image.new("RGBA", (T, T), (*ORTHO_NODATA, 0))
                        c.paste(t, (0, 0))
                        t = c
                    a = np.asarray(t).copy()
                    a[a[..., 3] == 0, :3] = ORTHO_NODATA
                    Image.fromarray(a, "RGBA").save(out, "WEBP", quality=82, exact=True)
                else:
                    if blank is None:
                        blank = Image.new("RGBA", (64, 64), (*ORTHO_NODATA, 0))
                    blank.save(out, "WEBP", quality=82, exact=True)
    E0, N0, _ = origin
    tg = T * G["ortho_res"]
    span_e, span_n = cols * tg, rows * tg

    def local(ee, nn):
        return [round(ee - E0, 3), round(ortho_y, 3), round(-(nn - N0), 3)]

    corners = {
        "tl": local(G["x0"], G["y1"]),
        "tr": local(G["x0"] + span_e, G["y1"]),
        "bl": local(G["x0"], G["y1"] - span_n),
    }
    rel = f"rasters/ortho-{e}/tiles.json"
    atomic_write_json(
        ctx.stage(f"out/{rel}"), {"schema": "aio.tiles/1", "levels": levels, "corners": corners}
    )
    return {"tiles": rel, "corners": corners}
