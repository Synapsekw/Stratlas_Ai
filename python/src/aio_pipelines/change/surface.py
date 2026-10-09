"""change.surface: two DSMs or point clouds to cut and fill regions with volumes.

Parameters as ``ChangeSurfaceParams`` in ``@aio/schema`` (``jobs.ts``). Steps:

1. read     both surfaces onto a common grid over the area both cover: a DSM (a ``cog`` raster
            layer with role ``dsm``, or another format with an ``aio.grid/1`` height grid in
            ``sources/``, see ``sources.py``) resampled through GDAL, a point cloud
            (``kit-packed``, ``copc`` through PDAL, or another format with its ``sources/<id>.las``)
            as the mean height of its points per cell with small gaps closed (as
            ``volumetric/cloud.py`` grids a cloud). The cell is the coarser input's (``cellM`` to
            choose);
2. register the dates must line up: a horizontal shift found on the shapes both dates share
            (2 cells at most) and the median height difference over unchanged ground (5 cm at
            most, founder default) are measured, and the run refused beyond them;
3. compare  the DEM of difference (later minus earlier): cells deeper or higher than
            ``minDepthM`` (default 0.10 m) joined into regions of at least ``minAreaM2`` (default
            1 m2), each with its cut, fill and net volume; volumes of the given ``areas``; the
            site total; a diverging heat map (metres) and the polygons;
4. commit   as ``change.raster`` does (``imagery.commit_run``).

This does not replace the stockpile workflow (``volumetric.build``); it gives any project with two
surfaces its cut and fill. Every region is a proposal a person confirms.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import numpy as np

from ..params import known_keys, number, text
from ..runtime import JobError, Step, StepContext, input_fingerprint
from ..survey.compare import ring_weights
from .changeset import change_set, change_set_id
from .imagery import (
    Grid,
    asset_path,
    capture_label,
    cell_for,
    check_captures,
    colour_ramp,
    commit_run,
    derived,
    find_layer,
    from_lonlat,
    intersect,
    load_arrays,
    outline,
    polygons,
    project_crs,
    read_manifest,
    save_arrays,
    write_pyramid,
)
from .register import estimate_shift, refusal
from .sources import GridSource, cloud_source, grid_source

PRODUCER = "change.surface"
#: Founder defaults (``ChangeThresholds.surface`` and ``.registration``).
DEFAULT_MIN_DEPTH_M = 0.10
DEFAULT_MIN_AREA_M2 = 1.0
MAX_SHIFT_PX = 2.0
MAX_VERTICAL_M = 0.05
#: Heights within this of each other count as unchanged ground for the vertical check.
STABLE_M = 0.5
GAP_PASSES = 3
#: Diverging heat map, metres: blue is cut (lower), red is fill (higher).
SURFACE_STOPS: list[tuple[float, str, float]] = [
    (-2.0, "#2166ac", 0.85),
    (-0.5, "#67a9cf", 0.75),
    (-0.1, "#d1e5f0", 0.6),
    (-0.05, "#d1e5f0", 0.0),
    (0.05, "#fddbc7", 0.0),
    (0.1, "#fddbc7", 0.6),
    (0.5, "#ef8a62", 0.75),
    (2.0, "#b2182b", 0.85),
]
LEGEND = {
    "kind": "metres",
    "unit": "m",
    "label": "Height change",
    "stops": [[v, c] for v, c, a in SURFACE_STOPS if a > 0],
}
REGION_STYLE = {
    "line": {"color": "#e8eaee", "width": 1.5},
    "fill": {"color": "#b2182b", "opacity": 0.15},
    "colorBy": {"field": "sign", "stops": [[-1, "#2166ac"], [1, "#b2182b"]]},
}
INPUTS_CHANGED = "The surfaces changed since this job started. Start the job again."


# ------------------------------------------------------------------------------------- surfaces


class Surface:
    """A DSM raster or a point cloud layer as heights in the local frame (y up)."""

    def __init__(self, project: Path, manifest: dict[str, Any], spec: dict[str, Any]):
        self.project = project
        self.manifest = manifest
        self.layer = find_layer(manifest, spec["layer"])
        self.kind = spec["kind"]
        self.name = str(self.layer.get("name") or self.layer.get("id"))
        self.origin = manifest.get("origin") or [0, 0, 0]
        self.grid: GridSource | None = None
        if self.kind == "dsm":
            if self.layer.get("kind") != "raster" or self.layer.get("role") != "dsm":
                raise JobError(f'The layer "{self.name}" is not a DSM.')
            if self.layer.get("format") == "cog":
                self.path = asset_path(project, self.layer)
                self.files = [str(self.path)]
                self._dsm_footprint()
            else:
                # a shaded relief for viewing: the heights are in its aio.grid/1 source
                self.grid = grid_source(project, self.layer, manifest)
                self.path = self.grid.image
                self.files = self.grid.files
                self._grid_footprint()
        else:
            if self.layer.get("kind") != "pointcloud":
                raise JobError(f'The layer "{self.name}" is not a point cloud.')
            if self.layer.get("format") in ("kit-packed", "copc"):
                self.path = asset_path(project, self.layer)
            else:
                # packed for viewing: the points are in its LAS source
                self.path = cloud_source(project, self.layer)
            self.files = [str(self.path)]
            self.res = None  # known once the points are read

    def _grid_footprint(self) -> None:
        assert self.grid is not None
        left, bottom, right, top = self.grid.bounds
        self.res = self.grid.res
        o = self.origin
        self.box = (left - o[0], o[1] - top, right - o[0], o[1] - bottom)

    def _dsm_footprint(self) -> None:
        import rasterio
        from rasterio.warp import transform_bounds

        with rasterio.open(self.path) as ds:
            b = ds.bounds
            dst = project_crs(self.manifest)
            if ds.crs is not None and dst is not None and ds.crs != dst:
                b = transform_bounds(ds.crs, dst, *b)
                left, bottom, right, top = b
                self.res = abs(ds.res[0])  # in its own units; metres for the projected CRSs used
            else:
                left, bottom, right, top = b.left, b.bottom, b.right, b.top
                self.res = min(abs(ds.res[0]), abs(ds.res[1]))
        o = self.origin
        self.box = (left - o[0], o[1] - top, right - o[0], o[1] - bottom)

    # -- clouds

    def points(self, ctx: StepContext) -> np.ndarray:
        """(n, 3) local x, y, z of the cloud."""
        if self.layer.get("format") == "kit-packed":
            raw = np.fromfile(self.path, dtype=np.uint8)
            n = raw.size // 7
            if n == 0 or raw.size != n * 7:
                raise JobError(f'The point cloud "{self.name}" is not a kit-packed file.')
            return raw[: 6 * n].view("<i2").reshape(n, 3).astype(np.float64) / 1000.0
        from ..pointcloud import PDAL_MISSING, _run, find_pdal
        from ..runtime import atomic_write_json
        from ..volumetric.cloud import read_las_chunks

        if self.path.suffix.lower() == ".las":
            las = self.path  # plain LAS (any point format) is read here, without PDAL
        else:
            pdal = find_pdal()
            if not pdal:
                raise JobError(PDAL_MISSING)
            las = ctx.stage(f"work/{self.layer['id']}.las")
        if not las.exists():
            pipe = ctx.stage("work/pdal.json")
            atomic_write_json(
                pipe,
                {
                    "pipeline": [
                        str(self.path),
                        {"type": "writers.las", "filename": str(las), "minor_version": 4},
                    ]
                },
            )
            _run(ctx, [pdal, "pipeline", str(pipe)], "Read the point cloud")
        o = self.origin
        parts = []
        for x, y, z, _ in read_las_chunks(las, ctx.check):
            parts.append(np.stack([x - o[0], z - o[2], o[1] - y], axis=1))
        return np.concatenate(parts) if parts else np.zeros((0, 3))

    def footprint(self, ctx: StepContext) -> None:
        if self.kind == "dsm":
            return
        pts = self.points(ctx)
        if len(pts) == 0:
            raise JobError(f'The point cloud "{self.name}" has no points.')
        self.box = (
            float(pts[:, 0].min()),
            float(pts[:, 2].min()),
            float(pts[:, 0].max()),
            float(pts[:, 2].max()),
        )
        area = max(1e-6, (self.box[2] - self.box[0]) * (self.box[3] - self.box[1]))
        # about four points per cell
        self.res = max(0.05, 2 * math.sqrt(area / len(pts)))
        self._pts = pts

    def heights(self, grid: Grid, ctx: StepContext) -> np.ndarray:
        """Local heights on ``grid`` (NaN where there is no data)."""
        if self.kind == "dsm":
            return self._dsm_heights(grid)
        pts = getattr(self, "_pts", None)
        if pts is None:
            pts = self.points(ctx)
        return grid_points(pts, grid, ctx.check)

    def _dsm_heights(self, grid: Grid) -> np.ndarray:
        import rasterio
        from rasterio.enums import Resampling
        from rasterio.warp import reproject

        dst_crs = project_crs(self.manifest)
        nodata = -3.0e38
        out = np.full((grid.rows, grid.cols), nodata, np.float32)
        if self.grid is not None:
            # aio.grid/1 heights are in the project CRS (grid_source checks the EPSG): the same
            # resampling onto the comparison cells as a GeoTIFF's
            src = self.grid.heights().astype(np.float32)
            src[~np.isfinite(src)] = nodata
            crs = dst_crs or f"EPSG:{self.grid.epsg or 3857}"
            reproject(
                src,
                out,
                src_transform=self.grid.transform(),
                src_crs=crs,
                src_nodata=nodata,
                dst_transform=grid.crs_transform(self.origin),
                dst_crs=crs,
                dst_nodata=nodata,
                resampling=Resampling.bilinear,
            )
        else:
            with rasterio.open(self.path) as ds:
                src_crs = ds.crs or dst_crs
                reproject(
                    rasterio.band(ds, 1),
                    out,
                    src_transform=ds.transform,
                    src_crs=src_crs,
                    src_nodata=ds.nodata,
                    dst_transform=grid.crs_transform(self.origin),
                    dst_crs=dst_crs or src_crs,
                    dst_nodata=nodata,
                    resampling=Resampling.bilinear,
                )
        h = out.astype(np.float64)
        h[(out <= nodata * 0.5) | ~np.isfinite(h)] = np.nan
        return h - float(self.origin[2])


def grid_points(pts: np.ndarray, grid: Grid, check=lambda: None) -> np.ndarray:
    """Mean height of the points per cell; small gaps closed from their neighbours."""
    from scipy import ndimage as ndi

    n = grid.rows * grid.cols
    s = np.zeros(n)
    c = np.zeros(n, np.int64)
    for i in range(0, len(pts), 2_000_000):
        check()
        blk = pts[i : i + 2_000_000]
        ci = np.floor((blk[:, 0] - grid.x0) / grid.cell).astype(np.int64)
        ri = np.floor((blk[:, 2] - grid.z0) / grid.cell).astype(np.int64)
        ok = (ci >= 0) & (ci < grid.cols) & (ri >= 0) & (ri < grid.rows)
        idx = ri[ok] * grid.cols + ci[ok]
        s += np.bincount(idx, weights=blk[ok, 1], minlength=n)
        c += np.bincount(idx, minlength=n)
    with np.errstate(invalid="ignore", divide="ignore"):
        h = (s / c).reshape(grid.rows, grid.cols)
    empty = (c == 0).reshape(grid.rows, grid.cols)
    k3 = np.ones((3, 3))
    for _ in range(GAP_PASSES):
        have = ~empty
        nb = ndi.convolve(have.astype(np.float64), k3, mode="constant")
        grow = empty & (nb >= 3)
        if not grow.any():
            break
        sums = ndi.convolve(np.where(have, h, 0.0), k3, mode="constant")
        h[grow] = sums[grow] / nb[grow]
        empty &= ~grow
    h[empty] = np.nan
    return h


# --------------------------------------------------------------------------------------- regions


def surface_regions(dod: np.ndarray, min_depth: float, min_cells: int) -> list[tuple[str, np.ndarray]]:
    """``('fill' | 'cut', mask)`` of each region deeper or higher than ``min_depth``.

    A region is cleaned (one-cell lines along walls and edges go) and grown by one cell of the same
    sign, so the rim of a pile counts in its volume.
    """
    from scipy import ndimage as ndi

    d = np.nan_to_num(dod, nan=0.0)
    disk = ndi.generate_binary_structure(2, 1)
    out = []
    for verdict, sel, same in (("fill", d >= min_depth, d > 0), ("cut", d <= -min_depth, d < 0)):
        m = ndi.binary_opening(sel, structure=disk)
        m = ndi.binary_fill_holes(m) & sel | m
        labels, n = ndi.label(m)
        if n == 0:
            continue
        sizes = ndi.sum(np.ones_like(labels), labels, index=np.arange(1, n + 1))
        for i, size in enumerate(sizes, start=1):
            if size < min_cells:
                continue
            reg = labels == i
            reg = reg | (ndi.binary_dilation(reg, structure=disk) & same)
            out.append((verdict, reg))
    return out


def volumes(dod: np.ndarray, mask: np.ndarray, cell: float, floor: float = 0.0) -> dict[str, float]:
    """Cut, fill and net of the cells of ``mask`` (or their coverage weights) through the survey core."""
    from ..survey.compare import weighted_volumes

    t = weighted_volumes(dod, mask, cell, floor, floor > 0)
    fill, cut = t.fill, abs(t.cut)  # abs: no "-0.0" when nothing was cut
    return {"cutM3": round(cut, 2), "fillM3": round(fill, 2), "netM3": round(fill - cut, 2)}


# --------------------------------------------------------------------------------------- pipeline


def _spec(v: Any, key: str) -> dict[str, Any]:
    if not isinstance(v, dict) or set(v) - {"layer", "kind"}:
        raise JobError(f"{key} must be {{ layer, kind }}.")
    if not isinstance(v.get("layer"), str) or not v["layer"]:
        raise JobError(f"{key}.layer must be a layer id.")
    if v.get("kind") not in ("dsm", "cloud"):
        raise JobError(f"{key}.kind must be dsm or cloud.")
    return v


class ChangeSurface:
    name = PRODUCER
    title = "Surface change"
    description = "Two DSMs or point clouds: DEM of difference, cut and fill regions, site total."
    keys = frozenset({"from", "to", "captures", "cellM", "minDepthM", "minAreaM2", "areas", "out"})

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(params, set(self.keys), self.name)
        p = dict(params)
        _spec(p.get("from"), "from")
        _spec(p.get("to"), "to")
        cap = p.get("captures")
        if cap is not None and (
            not isinstance(cap, dict)
            or set(cap) != {"from", "to"}
            or not all(isinstance(cap[k], str) and cap[k] for k in ("from", "to"))
        ):
            raise JobError("captures must be { from, to } survey date ids.")
        number(p, "cellM", lo=0.01, hi=100)
        number(p, "minDepthM", lo=1e-6, hi=100)
        number(p, "minAreaM2", lo=1e-6, hi=1e6)
        areas = p.get("areas")
        if areas is not None:
            if not isinstance(areas, list):
                raise JobError("areas must be a list.")
            for a in areas:
                ring = a.get("ring") if isinstance(a, dict) else None
                if (
                    not isinstance(a, dict)
                    or not isinstance(a.get("id"), str)
                    or not isinstance(a.get("name"), str)
                    or not isinstance(ring, list)
                    or len(ring) < 3
                ):
                    raise JobError("Each area needs an id, a name and a ring of [lon, lat] points.")
        text(p, "out")
        return p

    def plan(self, params: dict[str, Any]) -> list[Step]:
        state: dict[str, Any] = {}

        def captures(m: dict[str, Any]) -> tuple[str, str]:
            cap = params.get("captures")
            if cap:
                a, b = cap["from"], cap["to"]
            else:
                a = find_layer(m, params["from"]["layer"]).get("capture")
                b = find_layer(m, params["to"]["layer"]).get("capture")
                if not a or not b:
                    raise JobError(
                        "Say which survey dates the two surfaces belong to: set each layer's date, or give the date pair."
                    )
            check_captures(m, a, b)
            return a, b

        def surfaces(ctx: StepContext):
            m = read_manifest(ctx.project)
            pair = (Surface(ctx.project, m, params["from"]), Surface(ctx.project, m, params["to"]))
            return m, pair

        def ids(m: dict[str, Any]) -> tuple[str, str, str]:
            a, b = captures(m)
            sid = change_set_id(a, b, PRODUCER)
            return a, b, sid

        def check_inputs(ctx: StepContext, pair) -> None:
            want = ctx.outputs("read").get("inputs")
            now = input_fingerprint(ctx.project, [f for s in pair for f in s.files])
            if want and want.get("hash") != now["hash"]:
                raise JobError(INPUTS_CHANGED)

        def read(ctx: StepContext) -> dict[str, Any]:
            m, (sa, sb) = surfaces(ctx)
            ids(m)
            inputs = input_fingerprint(ctx.project, [f for s in (sa, sb) for f in s.files])
            sa.footprint(ctx)
            sb.footprint(ctx)
            box = intersect(sa.box, sb.box)
            if box is None:
                raise JobError("The two surfaces do not overlap.")
            cell = float(params.get("cellM") or cell_for(box, max(sa.res, sb.res)))
            cell = max(cell, cell_for(box, cell))
            grid = Grid.over(box, cell)
            ctx.log(f"Comparing {grid.cols} x {grid.rows} cells of {cell * 100:.1f} cm.")
            ha = sa.heights(grid, ctx)
            ctx.progress(0.5, "Earlier surface")
            hb = sb.heights(grid, ctx)
            both = np.isfinite(ha) & np.isfinite(hb)
            if not both.any():
                raise JobError("The two surfaces do not overlap where they have data.")
            save_arrays(ctx.stage("work/surfaces.npz"), a=ha.astype(np.float32), b=hb.astype(np.float32))
            either = np.isfinite(ha) | np.isfinite(hb)
            return {
                "grid": grid.to_dict(),
                "coverage": round(float(both.sum()) / float(either.sum()), 4),
                "inputs": inputs,
            }

        def register(ctx: StepContext) -> dict[str, Any]:
            _, pair = surfaces(ctx)
            check_inputs(ctx, pair)
            grid = Grid.of(ctx.outputs("read")["grid"])
            arr = load_arrays(ctx.stage("work/surfaces.npz"))
            ha, hb = arr["a"].astype(np.float64), arr["b"].astype(np.float64)
            both = np.isfinite(ha) & np.isfinite(hb)
            dod = hb - ha
            stable = both & (np.abs(dod) < STABLE_M)
            vertical = float(np.median(dod[stable])) if stable.sum() > 16 else 0.0
            fill = float(np.nanmedian(ha[both])) if both.any() else 0.0
            a0, b0 = np.where(both, ha, fill), np.where(both, hb, fill)
            shift = estimate_shift(a0, b0, both, log=False, min_texture=0.02)
            reg: dict[str, Any] = {
                "ok": True,
                "shiftPx": round(shift["px"], 2),
                "shiftM": round(shift["px"] * grid.cell, 3),
                "tolerancePx": MAX_SHIFT_PX,
                "toleranceM": MAX_VERTICAL_M,
            }
            if shift["px"] > MAX_SHIFT_PX:
                raise JobError(refusal(shift["px"], grid.cell, MAX_SHIFT_PX))
            if abs(vertical) > MAX_VERTICAL_M:
                word = "higher" if vertical > 0 else "lower"
                raise JobError(
                    f"The later surface is {abs(vertical):.2f} m {word} than the earlier one over unchanged "
                    f"ground; the largest offset allowed is {MAX_VERTICAL_M:.2f} m. Check both surfaces use "
                    "the same height datum."
                )
            reg["message"] = (
                f"The dates line up within {shift['px']:.1f} cells ({shift['px'] * grid.cell:.2f} m) "
                f"and {abs(vertical) * 100:.1f} cm in height."
            )
            ctx.log(reg["message"])
            return {"registration": reg, "verticalOffsetM": round(vertical, 4)}

        def compare(ctx: StepContext) -> dict[str, Any]:
            m, pair = surfaces(ctx)
            check_inputs(ctx, pair)
            a, b, sid = ids(m)
            out_dir = params.get("out") or f"change/{sid}"
            state.update(set_id=sid, out=out_dir)
            r = ctx.outputs("read")
            grid = Grid.of(r["grid"])
            arr = load_arrays(ctx.stage("work/surfaces.npz"))
            ha, hb = arr["a"].astype(np.float64), arr["b"].astype(np.float64)
            dod = hb - ha
            min_depth = float(params.get("minDepthM", DEFAULT_MIN_DEPTH_M))
            min_area = float(params.get("minAreaM2", DEFAULT_MIN_AREA_M2))
            min_cells = max(1, math.ceil(min_area / grid.cell**2 - 1e-9))
            regions = surface_regions(dod, min_depth, min_cells)
            ctx.progress(0.3, "Regions")
            regions_layer = f"{sid}-regions"
            found = []
            for verdict, mask in regions:
                polys = polygons(mask, grid, simplify=grid.cell * 0.5)
                if not polys:
                    continue
                poly = max(polys, key=lambda p: p.area)
                vol = volumes(dod, mask, grid.cell)
                found.append((verdict, mask, poly, vol))
            found.sort(key=lambda f: (round(f[2].centroid.y / grid.cell), f[2].centroid.x))
            items, feats = [], []
            for i, (verdict, mask, poly, vol) in enumerate(found, start=1):
                iid = f"region:{i:04d}"
                y = float(np.nanmean(hb[mask])) if np.isfinite(hb[mask]).any() else 0.0
                ring, local = outline(m, poly, y)
                x0, z0, x1, z1 = poly.bounds
                area = round(float(mask.sum() * grid.cell**2), 2)
                amount = vol["fillM3"] if verdict == "fill" else vol["cutM3"]
                peak = float(np.nanmax(np.abs(dod[mask])))
                item: dict[str, Any] = {
                    "kind": "region",
                    "id": iid,
                    "verdict": verdict,
                    "label": f"{verdict.capitalize()} of {amount:,.1f} m³ over {area:,.1f} m²",
                    "score": round(min(1.0, peak / (10 * min_depth)), 3),
                    "at": [round(poly.centroid.x, 3), round(y, 3), round(poly.centroid.y, 3)],
                    "bounds": {
                        "min": [round(x0, 3), round(y, 3), round(z0, 3)],
                        "max": [round(x1, 3), round(y, 3), round(z1, 3)],
                    },
                    "method": "dod",
                    "outlineLocal": local,
                    "areaM2": area,
                    "volume": vol,
                    "layer": regions_layer,
                    "feature": iid,
                }
                if ring:
                    item["outline"] = ring
                    feats.append(_feature(iid, ring, verdict, area, vol))
                items.append(item)
            # areas the person drew: their own cut, fill and net
            floor = 0.5 * min_depth
            for area in params.get("areas") or []:
                # exact coverage weights of the drawn polygon (the survey core)
                inside = ring_weights(
                    from_lonlat(m, area["ring"]), grid.x0, grid.z0, grid.cell, grid.cols, grid.rows
                )
                vol = volumes(dod, inside, grid.cell, floor)
                cells = (inside > 0) & np.isfinite(dod)
                verdict = "fill" if vol["netM3"] >= 0 else "cut"
                xs = (np.nonzero(cells)[1] + 0.5) * grid.cell + grid.x0
                zs = (np.nonzero(cells)[0] + 0.5) * grid.cell + grid.z0
                item = {
                    "kind": "region",
                    "id": f"area:{area['id']}",
                    "verdict": verdict,
                    "label": f"{area['name']}: fill {vol['fillM3']:,.1f} m³, cut {vol['cutM3']:,.1f} m³",
                    "method": "area",
                    "areaM2": round(float(inside[cells].sum() * grid.cell**2), 2),
                    "volume": vol,
                    "outline": area["ring"],
                }
                if len(xs):
                    item["at"] = [
                        round(float(xs.mean()), 3),
                        round(float(np.nanmean(hb[cells])), 3),
                        round(float(zs.mean()), 3),
                    ]
                items.append(item)
            ctx.progress(0.6, "Heat map")
            heat = colour_ramp(np.clip(dod, -2.0, 2.0), SURFACE_STOPS)
            heat[~np.isfinite(dod)] = 0
            y = float(np.nanmedian(hb)) if np.isfinite(hb).any() else 0.0
            tiles = write_pyramid(heat, grid, ctx.stage("out/heat"), f"{out_dir}/heat", y, LEGEND, ctx.check)
            from ..runtime import atomic_write_json

            atomic_write_json(ctx.stage("out/heat/tiles.json"), tiles)
            atomic_write_json(
                ctx.stage("out/regions.geojson"),
                {"type": "FeatureCollection", "features": feats},
                indent=None,
            )
            site = volumes(dod, np.isfinite(dod), grid.cell, floor)
            regs = [it for it in items if it["id"].startswith("region:")]
            reg = ctx.outputs("register")
            stats = {
                "items": len(regs),
                "fillM3": round(sum(it["volume"]["fillM3"] for it in regs), 2),
                "cutM3": round(sum(it["volume"]["cutM3"] for it in regs), 2),
                "siteFillM3": site["fillM3"],
                "siteCutM3": site["cutM3"],
                "siteNetM3": site["netM3"],
                "verticalOffsetM": reg["verticalOffsetM"],
                "cellM": grid.cell,
                "minDepthM": min_depth,
            }
            stats["netM3"] = round(stats["fillM3"] - stats["cutM3"], 2)
            cs = change_set(
                sid,
                a,
                b,
                PRODUCER,
                items,
                layers=[f"{sid}-heat", regions_layer],
                stats=stats,
                run={"jobId": ctx.job.job_id, "params": dict(params)},
                registration=reg["registration"],
                coverage=r["coverage"],
            )
            atomic_write_json(ctx.stage("work/change-set.json"), cs)
            return {"items": len(items), "setId": sid, "out": out_dir}

        def commit(ctx: StepContext) -> dict[str, Any]:
            import json

            m = read_manifest(ctx.project)
            a, b, sid = ids(m)
            out_dir = ctx.outputs("compare")["out"]
            cs = json.loads(ctx.stage("work/change-set.json").read_text("utf-8"))
            src = [params["from"]["layer"], params["to"]["layer"]]
            when = f"{capture_label(m, a)} to {capture_label(m, b)}"
            prov = derived(a, b, sid, ctx.job.job_id, src)
            layers = [
                {
                    "kind": "raster",
                    "id": f"{sid}-heat",
                    "name": f"Surface change heat map, {when}",
                    "visible": True,
                    "capture": b,
                    "derived": prov,
                    "src": {"path": f"{out_dir}/heat/tiles.json"},
                    "role": "plan",
                    "format": "kit-pyramid",
                },
                {
                    "kind": "vector",
                    "id": f"{sid}-regions",
                    "name": f"Cut and fill areas, {when}",
                    "visible": True,
                    "capture": b,
                    "derived": dict(prov),
                    "src": {"path": f"{out_dir}/regions.geojson"},
                    "format": "geojson",
                    "style": REGION_STYLE,
                },
            ]
            return commit_run(ctx, sid, "out", out_dir, cs, layers)

        return [
            Step("read", "Read both surfaces", read, 3.0),
            Step("register", "Check the alignment", register, 1.0),
            Step("compare", "Cut and fill", compare, 2.0),
            Step("commit", "Add the change layers", commit, 1.0),
        ]


def _feature(
    iid: str, ring: list[list[float]], verdict: str, area: float, vol: dict[str, float]
) -> dict[str, Any]:
    return {
        "type": "Feature",
        "id": iid,
        "properties": {
            "id": iid,
            "verdict": verdict,
            "sign": 1 if verdict == "fill" else -1,
            "areaM2": area,
            **vol,
        },
        "geometry": {"type": "Polygon", "coordinates": [ring]},
    }
