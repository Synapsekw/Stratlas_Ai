"""The outputs an OPF project brings: point clouds to COPC, orthomosaics and DSMs to kit pyramids.

Each output is staged in the job (``clouds/``, ``cogs/``, ``pyramids/``, ``grids/``) and resumes
where it stopped; one output that cannot be read is left out with its reason, never the import.

- **Point clouds** (OPF glTF): positions to the project CRS, a LAS 1.4 file (``change/las.py``),
  then PDAL ``writers.copc``. Without PDAL the cloud is left out and the report says why.
- **Orthomosaics**: a COG copy for the run folder, and a ``kit-pyramid`` in the project CRS
  (``road/ortho.py``: WebP tiles, warped on the fly).
- **DSMs**: a COG copy, heights resampled onto a north-up grid in the project CRS (at most
  4096 cells a side) kept as ``aio.grid/1`` (``sources/<layer>.json``, 16-bit PNG, the M8 change
  pipelines read it), and that grid drawn as a coloured hillshade ``kit-pyramid``.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import numpy as np

from ..runtime import JobError, StepContext, atomic_write_json, replace_over
from .geometry import SceneFrame, crs_definition, project_crs

DSM_GRID_MAX = 4096
RAMP = np.array(
    [[40, 70, 140], [60, 150, 140], [150, 190, 90], [235, 200, 90], [230, 120, 70], [245, 245, 245]],
    dtype=np.float64,
)


def _manifest(ctx: StepContext) -> dict[str, Any]:
    return json.loads((ctx.project / "manifest.json").read_text("utf-8"))


def frame_from_plan(plan: dict[str, Any], manifest: dict[str, Any]) -> SceneFrame:
    f = plan.get("frame")
    srf = None
    if f is not None:
        srf = SimpleNamespace(
            crs=SimpleNamespace(definition=f["crs"]),
            base_to_canonical=SimpleNamespace(shift=f["shift"], scale=f["scale"], swap_xy=f["swap"]),
        )
    return SceneFrame(srf, project_crs(manifest), manifest.get("origin") or [0, 0, 0])


def _skip(what: str, why: str) -> dict[str, Any]:
    return {"skipped": True, "what": what, "reason": why}


# ---------------------------------------------------------------- point clouds


def import_clouds(ctx: StepContext, plan: dict[str, Any], run: str) -> list[dict[str, Any]]:
    if not plan["clouds"]:
        return []
    from ..change.las import write_las
    from ..pointcloud import _run, find_pdal

    pdal = find_pdal()
    if not pdal:
        ctx.log("PDAL is not available, so the point clouds are not added as layers.", "warn")
        return [
            _skip(f"point cloud {c['name']}", "PDAL is not available in this pipeline pack")
            for c in plan["clouds"]
        ]
    from pyopf.pointcloud.pcl import GlTFPointCloud

    from .reader import cloud_points
    from .safety import check_gltf

    manifest = _manifest(ctx)
    frame = frame_from_plan(plan, manifest)
    srs = crs_definition(manifest)
    opf_dir = Path(plan["src"]).parent.resolve()
    out: list[dict[str, Any]] = []
    for i, c in enumerate(plan["clouds"]):
        ctx.check()
        staged = f"clouds/{i}.copc.laz"
        dest = f"clouds/{run}{'' if i == 0 else f'-{i + 1}'}.copc.laz"
        record = {"staged": staged, "path": dest, "layer": f"cloud-{run}", "name": c["name"]}
        target = ctx.stage(staged)
        if target.exists():
            record["points"] = int(json.loads(ctx.stage(f"clouds/{i}.json").read_text("utf-8"))["points"])
            out.append(record)
            continue
        try:
            gltf = Path(c["gltf"])
            check_gltf(opf_dir, gltf)
            pcl = GlTFPointCloud.open(gltf)
            proc, rgb = cloud_points(pcl)
            del pcl
            xyz = frame.to_project(proc) if len(proc) else np.zeros((0, 3))
        except JobError as e:
            out.append(_skip(f"point cloud {c['name']}", str(e)))
            continue
        except Exception as e:
            out.append(_skip(f"point cloud {c['name']}", f"could not be read: {e}"[:300]))
            continue
        if not len(xyz):
            out.append(_skip(f"point cloud {c['name']}", "it has no points"))
            continue
        las = ctx.stage(f"clouds/{i}.las")
        write_las(
            las,
            xyz,
            pdrf=7,
            rgb=(rgb.astype(np.uint16) * 257) if rgb is not None else None,
        )
        pipe = ctx.stage(f"clouds/{i}.pipeline.json")
        tmp = target.with_name(f".{target.name}.tmp.copc.laz")
        atomic_write_json(
            pipe,
            {"pipeline": [str(las), {"type": "writers.copc", "filename": str(tmp), "a_srs": srs}]},
        )
        _run(ctx, [pdal, "pipeline", str(pipe)], f"Write the COPC file of {c['name']}")
        if not tmp.is_file():
            raise JobError("PDAL finished without writing the COPC file.")
        replace_over(tmp, target)
        las.unlink(missing_ok=True)
        atomic_write_json(ctx.stage(f"clouds/{i}.json"), {"points": len(xyz)})
        record["points"] = len(xyz)
        ctx.log(f"{c['name']}: {len(xyz):,} points to COPC.")
        out.append(record)
    return out


# ---------------------------------------------------------------- rasters


def hillshade(z: np.ndarray, cell: float) -> np.ndarray:
    """RGBA (rows, cols, 4) of heights: an elevation ramp times a north-west light (as the builder's)."""
    valid = np.isfinite(z)
    rgba = np.zeros((*z.shape, 4), dtype=np.uint8)
    if not valid.any():
        return rgba
    lo, hi = float(np.nanmin(z)), float(np.nanmax(z))
    span = hi - lo if hi > lo else 1.0
    f = np.where(valid, z, lo)
    zx = np.zeros_like(f)
    zy = np.zeros_like(f)
    zx[:, 1:-1] = f[:, 2:] - f[:, :-2]
    zy[1:-1, :] = f[2:, :] - f[:-2, :]
    nx = -zx / (2 * cell)
    ny = zy / (2 * cell)
    shade = np.maximum(0.35, (nx * -0.5 + ny * 0.5 + 0.7) / np.sqrt(nx * nx + ny * ny + 1))
    u = (f - lo) / span * (len(RAMP) - 1)
    k = np.clip(np.floor(u).astype(np.int64), 0, len(RAMP) - 2)
    t = (u - k)[..., None]
    colour = (RAMP[k] * (1 - t) + RAMP[k + 1] * t) * shade[..., None]
    rgba[..., :3] = np.clip(np.round(colour), 0, 255).astype(np.uint8)
    rgba[..., 3] = np.where(valid, 255, 0).astype(np.uint8)
    rgba[~valid, :3] = 0
    return rgba


def dsm_grid(src: Path, dst_crs) -> tuple[np.ndarray, float, float, float]:
    """Heights resampled north-up in ``dst_crs``: (heights with NaN, left, top, cell size)."""
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.transform import from_origin
    from rasterio.warp import calculate_default_transform, reproject, transform_bounds

    with rasterio.open(src) as ds:
        if ds.crs is None:
            raise JobError(f"The DSM {src.name} has no CRS.")
        if ds.count != 1:
            raise JobError(f"The DSM {src.name} has {ds.count} bands; a DSM has one band of heights.")
        left, bottom, right, top = transform_bounds(ds.crs, dst_crs, *ds.bounds)
        t, w, h = calculate_default_transform(ds.crs, dst_crs, ds.width, ds.height, *ds.bounds)
        res = abs(t.a) * max(1.0, max(w, h) / DSM_GRID_MAX)
        cols = max(1, math.ceil((right - left) / res))
        rows = max(1, math.ceil((top - bottom) / res))
        grid = np.full((rows, cols), np.nan, dtype=np.float32)
        reproject(
            rasterio.band(ds, 1),
            grid,
            src_transform=ds.transform,
            src_crs=ds.crs,
            src_nodata=ds.nodata,
            dst_transform=from_origin(left, top, res, res),
            dst_crs=dst_crs,
            dst_nodata=np.nan,
            resampling=Resampling.bilinear,
        )
    z = grid.astype(np.float64)
    z[(z < -1e4) | (z > 1e5)] = np.nan
    return z, left, top, res


def _cog(src: Path, dest: Path) -> None:
    from rasterio.shutil import copy as rio_copy

    tmp = dest.with_name(f".{dest.stem}.tmp.tif")
    rio_copy(str(src), str(tmp), driver="COG", compress="DEFLATE", BIGTIFF="IF_SAFER")
    replace_over(tmp, dest)


def _pyramid(
    ctx: StepContext, tif: Path, out_dir: Path, manifest: dict[str, Any], name: str
) -> dict[str, Any]:
    from ..road.ortho import build_pyramid, open_sources, plan_pyramid, stamp, tiles_json

    crs = project_crs(manifest)
    sources = open_sources([str(tif)], crs)
    try:
        plan = plan_pyramid(sources, None)
        build_pyramid(sources, plan, out_dir, ctx.check, ctx.progress, ctx.log)
        epsg = (manifest.get("crs") or {}).get("epsg")
        return tiles_json(
            plan,
            manifest.get("origin") or [0, 0, 0],
            epsg if isinstance(epsg, int) else None,
            name,
            stamp([str(tif)], plan),
        )
    finally:
        for s in sources:
            s.close()


def import_rasters(ctx: StepContext, plan: dict[str, Any], run: str) -> list[dict[str, Any]]:
    import rasterio
    from PIL import Image
    from rasterio.transform import from_origin

    manifest = _manifest(ctx)
    crs = project_crs(manifest)
    epsg = (manifest.get("crs") or {}).get("epsg")
    out: list[dict[str, Any]] = []
    seen: dict[str, int] = {}
    for r in plan["rasters"]:
        ctx.check()
        role = r["role"]
        seen[role] = seen.get(role, 0) + 1
        key = role if seen[role] == 1 else f"{role}-{seen[role]}"
        src = Path(r["file"])
        rec: dict[str, Any] = {
            "role": role,
            "name": r["name"],
            "layer": f"{role}-{run}" if seen[role] == 1 else f"{role}-{run}-{seen[role]}",
            "cog": f"cogs/{key}.tif",
            "cogName": f"{key}.tif",
            "pyramid": f"pyramids/{key}",
        }
        try:
            cog = ctx.stage(rec["cog"])
            if not cog.exists():
                _cog(src, cog)
            tiles_file = ctx.stage(f"pyramids/{key}.tiles.json")
            if tiles_file.exists():
                rec.update(json.loads(tiles_file.read_text("utf-8")))
                out.append(rec)
                continue
            pyr = ctx.stage(f"{rec['pyramid']}/.keep").parent
            if role == "ortho":
                rec["tiles"] = _pyramid(ctx, cog, pyr, manifest, r["name"])
            else:
                z, left, top, res = dsm_grid(cog, crs)
                rgba = hillshade(z, res)
                shade = ctx.stage(f"grids/{key}.shade.tif")
                with rasterio.open(
                    shade,
                    "w",
                    driver="GTiff",
                    width=z.shape[1],
                    height=z.shape[0],
                    count=4,
                    dtype="uint8",
                    crs=crs,
                    transform=from_origin(left, top, res, res),
                    photometric="RGB",
                    alpha="YES",
                ) as ds:
                    ds.write(np.moveaxis(rgba, -1, 0))
                rec["tiles"] = _pyramid(ctx, shade, pyr, manifest, r["name"])
                valid = np.isfinite(z)
                lo = float(np.nanmin(z)) if valid.any() else 0.0
                hi = float(np.nanmax(z)) if valid.any() else 0.0
                scale = max((hi - lo) / 65534.0, 1e-4)
                offset = lo - scale
                vals = np.where(
                    valid, np.clip(np.round((np.where(valid, z, lo) - offset) / scale), 1, 65535), 0
                )
                png = ctx.stage(f"grids/{key}.png")
                Image.fromarray(vals.astype(np.uint16)).save(png)
                rec["grid"] = {
                    "png": f"grids/{key}.png",
                    "json": {
                        "schema": "aio.grid/1",
                        "kind": "dsm",
                        "x0": left,
                        "y1": top,
                        "res": res,
                        "width": int(z.shape[1]),
                        "height": int(z.shape[0]),
                        "scale": scale,
                        "offset": offset,
                        "nodata": 0,
                        **({"epsg": epsg} if isinstance(epsg, int) else {}),
                    },
                }
                shade.unlink(missing_ok=True)
            atomic_write_json(tiles_file, {k: rec[k] for k in ("tiles", "grid") if k in rec})
            ctx.log(f"{r['name']}: {role} tiled ({len(rec['tiles']['levels'])} levels).")
        except JobError as e:
            out.append(_skip(f"{role} {r['name']}", str(e)))
            continue
        except Exception as e:
            out.append(_skip(f"{role} {r['name']}", f"could not be read: {e}"[:300]))
            continue
        out.append(rec)
    return out
