"""hydro.flood: the area, depth and stored volume below a water level (PRD HYD-1, section 30).

Parameters as ``HydroFloodParams`` in packages/schema/src/jobs.ts. On the prepared surface's own
cells (or inside ``region``):

- **Wet cells** are the cells whose height is below ``levelM``. In ``all-below`` mode every such
  cell holds water; in ``connected`` mode only those joined to the ``seed`` cell through wet cells
  (eight-neighbour), or to the lowest cell when no seed is given.
- **Depth** ``levelM - z`` per wet cell; **stored volume** the sum of depth times the cell area
  (the midpoint rule on the surface's posts) and **area** the wet cells' area. Both converge on an
  analytic bowl within 1% at a 0.25 m cell (``tests/test_hydro.py``).
- **Outline**: the water's edge from marching squares on ``levelM - z`` (linear between posts),
  with islands as holes, in the project CRS: ``outline.geojson`` and ``outline.dxf`` (closed
  LWPOLYLINEs at the level's elevation on layer ``FLOOD-OUTLINE``, metres).
- **Depth raster**: ``depth.json`` and ``depth.png`` (``aio.grid/1``) and ``depth-view.png`` (colour,
  north-up) over the wet cells' bounding box.

Bounded memory: at most ``MAX_CELLS`` surface cells (a region narrows a larger site).
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

from ..runtime import JobError, Step, StepContext
from .common import (
    Raster,
    check_common,
    check_point,
    choice,
    colour_view,
    commit_run,
    grid16,
    load_surface,
    rnd,
    view_bounds,
    write_geojson,
    write_run,
)

#: Largest window read (cells): 25 M float64 heights and their masks stay under about 600 MB.
MAX_CELLS = 25_000_000
DXF_LAYER = "FLOOD-OUTLINE"


def wet_cells(z: np.ndarray, level: float, mode: str, seed: tuple[int, int] | None) -> np.ndarray:
    """The cells holding water (see the module doc); ``seed`` is (i, j)."""
    from scipy import ndimage

    below = np.isfinite(z) & (z < level)
    if mode == "all-below" or not below.any():
        return below
    if seed is None:
        k = int(np.nanargmin(np.where(below, z, np.inf)))
        seed = (k % z.shape[1], k // z.shape[1])
    lab, _ = ndimage.label(below, structure=np.ones((3, 3), bool))
    s = lab[seed[1], seed[0]]
    return lab == s if s > 0 else np.zeros_like(below)


def outline_polygons(z: np.ndarray, wet: np.ndarray, level: float, r: Raster) -> list[Any]:
    """The water's edge as shapely polygons (E, N), islands as holes."""
    import shapely
    from shapely.geometry import Polygon
    from skimage import measure

    if not wet.any():
        return []
    jj, ii = np.nonzero(wet)
    j0, j1 = max(0, jj.min() - 1), min(z.shape[0], jj.max() + 2)
    i0, i1 = max(0, ii.min() - 1), min(z.shape[1], ii.max() + 2)
    sub = z[j0:j1, i0:i1]
    w = wet[j0:j1, i0:i1]
    dry = np.where(np.isfinite(sub), np.minimum(level - sub, -1e-9), -1e-9)
    field = np.where(w, level - sub, dry)
    pad = np.full((field.shape[0] + 2, field.shape[1] + 2), -1e-9)
    pad[1:-1, 1:-1] = field
    rings = []
    for line in measure.find_contours(pad, 0.0):
        if len(line) < 4:
            continue
        e = r.origin_e + (line[:, 1] - 1 + i0 + 0.5) * r.cell
        n = r.origin_n + (line[:, 0] - 1 + j0 + 0.5) * r.cell
        poly = Polygon(np.column_stack([e, n]))
        if not poly.is_valid:
            poly = shapely.make_valid(poly)
        if poly.area > 0:
            rings.append(poly)
    if not rings:
        return []
    # even-odd nesting: the largest rings first, each one a hole of the ring it lies in when that
    # ring is a shell, else a shell of its own
    rings.sort(key=lambda p: -p.area)
    tree = shapely.STRtree(rings)
    shells: list[dict[str, Any]] = []
    depth: list[int] = []
    by_index: dict[int, dict[str, Any]] = {}
    for k, p in enumerate(rings):
        hits = tree.query(p.representative_point(), predicate="intersects")
        inside = sorted(int(m) for m in hits if m < k)
        d = (depth[inside[-1]] + 1) if inside else 0
        depth.append(d)
        if d % 2 == 0:
            by_index[k] = {"shell": p, "holes": []}
            shells.append(by_index[k])
        else:
            by_index[inside[-1]]["holes"].append(p)
    out = []
    for s in shells:
        shell = s["shell"]
        poly = Polygon(
            shell.exterior.coords, [h.exterior.coords for h in s["holes"] if hasattr(h, "exterior")]
        )
        if not poly.is_valid:
            poly = shapely.make_valid(poly)
        out.append(poly)
    return out


def _polys(geom: Any) -> list[Any]:
    if geom.geom_type == "Polygon":
        return [geom]
    return [g for g in getattr(geom, "geoms", []) if g.geom_type == "Polygon"]


def write_outline_dxf(path, polygons: list[Any], level: float) -> int:
    """Closed LWPOLYLINEs (shells and holes) at ``level`` on ``FLOOD-OUTLINE``, metres; the count."""
    import ezdxf

    doc = ezdxf.new("R2010", setup=False)
    doc.header["$INSUNITS"] = 6
    doc.header["$MEASUREMENT"] = 1
    doc.layers.add(DXF_LAYER, color=5)
    msp = doc.modelspace()
    n = 0
    for geom in polygons:
        for poly in _polys(geom):
            for ring in [poly.exterior, *poly.interiors]:
                pts = [(float(x), float(y)) for x, y in list(ring.coords)[:-1]]
                if len(pts) < 3:
                    continue
                msp.add_lwpolyline(pts, close=True, dxfattribs={"layer": DXF_LAYER, "elevation": level})
                n += 1
    path.parent.mkdir(parents=True, exist_ok=True)
    doc.saveas(path)
    return n


def _ring_coords(ring: Any) -> list[list[float]]:
    return [[rnd(x), rnd(y)] for x, y in ring.coords]


class HydroFlood:
    name = "hydro.flood"
    title = "Flood to level"
    description = "The area, depth and stored volume below a water level."
    keys = frozenset({"surface", "levelM", "mode", "seed", "region", "run"})
    required = frozenset({"surface", "levelM", "mode"})
    choices = {  # noqa: RUF012 - read only
        "mode": frozenset({"connected", "all-below"}),
    }

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        check_common(params, self.name, self.keys, self.required)
        choice(params, "mode", self.choices["mode"])
        level = params["levelM"]
        if isinstance(level, bool) or not isinstance(level, int | float) or not math.isfinite(level):
            raise JobError("levelM must be a number (metres).")
        if params.get("seed") is not None:
            check_point(params["seed"], "seed")
        return dict(params)

    def inputs(self, params: dict[str, Any]) -> list[str]:
        return [f"survey/surfaces/{params['surface']}"]

    def plan(self, params: dict[str, Any]) -> list[Step]:
        def flood(ctx: StepContext) -> dict[str, Any]:
            p = ctx.params
            surf = load_surface(ctx.project, p["surface"], p.get("region"), MAX_CELLS, ctx.check)
            r = surf.raster
            z = r.z
            level = float(p["levelM"])
            seed_cell = None
            if p["mode"] == "connected" and p.get("seed") is not None:
                se, sn = check_point(p["seed"], "seed")
                seed_cell = r.cell_of(se, sn)
                if seed_cell is None or not math.isfinite(z[seed_cell[1], seed_cell[0]]):
                    raise JobError("The seed point is outside the surface (or the region).")
                zs = float(z[seed_cell[1], seed_cell[0]])
                if zs >= level:
                    raise JobError(
                        f"The ground at the seed point is at {zs:.3f} m, not below the water level "
                        f"{level:.3f} m. Pick a point under water or raise the level."
                    )
            ctx.progress(0.3, "Wet cells")
            wet = wet_cells(z, level, p["mode"], seed_cell)
            area_cell = r.cell * r.cell
            depth = np.where(wet, level - z, np.nan)
            n_wet = int(wet.sum())
            volume = float(np.nansum(depth) * area_cell) if n_wet else 0.0
            results: dict[str, Any] = {
                "levelM": level,
                "mode": p["mode"],
                "areaM2": n_wet * area_cell,
                "volumeM3": volume,
                "maxDepthM": float(np.nanmax(depth)) if n_wet else 0.0,
                "wetCells": n_wet,
            }
            if seed_cell is not None:
                results["seed"] = [float(v) for v in p["seed"]]
            files: dict[str, Any] = {}
            notes: list[str] = []
            if n_wet == 0:
                notes.append("No ground is below the level: nothing floods.")
            else:
                ctx.progress(0.5, "Outline")
                polys = outline_polygons(z, wet, level, r)
                feats = []
                for geom in polys:
                    for poly in _polys(geom):
                        feats.append(
                            {
                                "type": "Feature",
                                "properties": {"levelM": level, "areaM2": rnd(poly.area, 3)},
                                "geometry": {
                                    "type": "Polygon",
                                    "coordinates": [_ring_coords(poly.exterior)]
                                    + [_ring_coords(h) for h in poly.interiors],
                                },
                            }
                        )
                write_geojson(ctx.stage("out/outline.geojson"), feats)
                rings = write_outline_dxf(ctx.stage("out/outline.dxf"), polys, level)
                results["outlineAreaM2"] = float(sum(f["properties"]["areaM2"] for f in feats))
                results["outlineRings"] = rings
                files["outline"] = "outline.geojson"
                files["dxf"] = "outline.dxf"
                # the depth grid over the wet cells' box
                ctx.progress(0.8, "Depth")
                jj, ii = np.nonzero(wet)
                j0, j1, i0, i1 = jj.min(), jj.max() + 1, ii.min(), ii.max() + 1
                sub = Raster(depth[j0:j1, i0:i1], r.origin_e + i0 * r.cell, r.origin_n + j0 * r.cell, r.cell)
                grid16(sub.z, sub, "depth", "depth", ctx.stage("out/x").parent)
                colour_view(sub.z, ctx.stage("out/depth-view.png"))
                files["depth"] = "depth.json"
                files["view"] = {"file": "depth-view.png", "bounds": view_bounds(sub)}
            doc = write_run(ctx, self.name, surf, results, files, notes=notes)
            return {"results": doc["results"]}

        return [Step("flood", "Flood to the level", flood, 4.0), Step("commit", "Save the run", commit_run)]


__all__ = ["HydroFlood", "outline_polygons", "wet_cells"]
