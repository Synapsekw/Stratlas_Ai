"""hydro.flow: flow paths from a drop point, catchments of outlets and the stream network (PRD
HYD-2, section 30).

Parameters as ``HydroFlowParams`` in packages/schema/src/jobs.ts. On the prepared surface's own
cells (or inside ``region``), with the algorithms of ``dem.py``:

1. **Depressions**: ``breach`` (default) carves each depression's spill path; ``fill`` raises
   depressions to their spill level (both Priority-Flood+epsilon, so every cell drains).
2. **Directions**: ``d8`` (default) or ``dinf`` (D-infinity), and the flow accumulation (upslope
   area, square metres) over them.
3. By ``mode``:

   - ``runoff``: the preferential flow path from ``drop`` downhill until the water leaves the
     surface (D8 receivers; with D-infinity the larger share), ``path.geojson`` (a 3D LineString
     with the chainage of each vertex for an animation) and its length and fall.
   - ``catchment``: the catchment of each outlet in ``outlets`` (each snapped to the cell of
     largest D8 accumulation within ``SNAP_M``), or without outlets the catchment of the surface's
     main outlet (where the most water leaves the grid; its pour point is where it crosses the
     edge). Catchments are delineated on D8 receivers, nested outlets split the area (each cell
     goes to the first outlet downstream). ``catchments.geojson`` (polygons of whole cells),
     their areas, and with D-infinity also the D-infinity contributing area at each outlet. The
     stream network is written too.
   - ``streams``: the stream network, ``streams.geojson``: D8 links of the cells whose upslope area
     reaches ``streamAreaM2`` (default 1% of the area, between 100 m² and 1 ha), each with the
     upslope area at its downstream end.

Bounded memory and time: at most ``MAX_CELLS`` cells (the flood is a Python loop of about a
microsecond per neighbour, so 9 M cells take a few minutes).
"""

from __future__ import annotations

import itertools
import math
from typing import Any

import numpy as np

from ..runtime import JobError, Step, StepContext
from . import dem
from .common import (
    Raster,
    check_common,
    check_point,
    choice,
    commit_run,
    load_surface,
    rnd,
    write_geojson,
    write_run,
)

MAX_CELLS = 9_000_000
#: Outlets snap to the largest accumulation within this distance (metres, at least one cell).
SNAP_M = 5.0
STREAM_DEFAULT_SHARE = 0.01
STREAM_DEFAULT_MIN_M2 = 100.0
STREAM_DEFAULT_MAX_M2 = 10_000.0


def condition(z: np.ndarray, depressions: str, check: dem.Check = dem._no_check) -> np.ndarray:
    fl = dem.priority_flood(z, check)
    return dem.breach(z, fl, check) if depressions == "breach" else fl.filled


def _xy(r: Raster, k: int) -> tuple[float, float]:
    j, i = divmod(int(k), r.nx)
    e, n = r.centre(i, j)
    return float(e), float(n)


def pour_point(r: Raster, rt: dem.Routing, k: int) -> tuple[float, float]:
    """Where water leaves outlet cell ``k``: the crossing of its edge when it drains off the grid,
    else the cell centre."""
    j, i = divmod(int(k), r.nx)
    if rt.d8r[k] >= 0:
        return _xy(r, k)
    e, n = dem.exit_point(i, j, int(rt.d8[j, i]), r.origin_e, r.origin_n, r.cell)
    return float(e), float(n)


def snap(r: Raster, acc8: np.ndarray, e: float, n: float) -> int | None:
    """The cell of largest D8 accumulation within ``SNAP_M`` of (E, N), or None off the surface."""
    rad = max(1, math.ceil(SNAP_M / r.cell))
    u = (e - r.origin_e) / r.cell
    v = (n - r.origin_n) / r.cell
    i = min(max(math.floor(u), 0), r.nx - 1)
    j = min(max(math.floor(v), 0), r.ny - 1)
    if abs(u - (i + 0.5)) > rad + 0.5 or abs(v - (j + 0.5)) > rad + 0.5:
        return None
    i0, i1 = max(0, i - rad), min(r.nx, i + rad + 1)
    j0, j1 = max(0, j - rad), min(r.ny, j + rad + 1)
    win = acc8[j0:j1, i0:i1]
    jj, ii = np.mgrid[j0:j1, i0:i1]
    near = (np.hypot(ii + 0.5 - u, jj + 0.5 - v) <= rad + 0.5) & np.isfinite(r.z[j0:j1, i0:i1])
    if not near.any():
        return None
    k = int(np.argmax(np.where(near, win, -1.0)))
    bj, bi = divmod(k, win.shape[1])
    return (j0 + bj) * r.nx + (i0 + bi)


def cell_polygons(mask: np.ndarray, r: Raster) -> list[Any]:
    """The union of the cells in ``mask`` as shapely polygons (E, N), cell edges exactly."""
    from rasterio import features
    from rasterio.transform import Affine
    from shapely.geometry import shape

    # row 0 south: flip to north-up for rasterio's transform
    north_up = mask[::-1].astype(np.uint8)
    t = Affine(r.cell, 0, r.origin_e, 0, -r.cell, r.origin_n + r.ny * r.cell)
    return [
        shape(g) for g, v in features.shapes(north_up, mask=north_up > 0, transform=t, connectivity=8) if v
    ]


def _polygon_feature(poly: Any, props: dict[str, Any]) -> dict[str, Any]:
    def ring(c):
        return [[rnd(x), rnd(y)] for x, y in c.coords]

    return {
        "type": "Feature",
        "properties": props,
        "geometry": {
            "type": "Polygon",
            "coordinates": [ring(poly.exterior)] + [ring(h) for h in poly.interiors],
        },
    }


def stream_features(r: Raster, rt: dem.Routing, acc8: np.ndarray, threshold: float) -> list[dict[str, Any]]:
    stream = (acc8 >= threshold) & np.isfinite(r.z)
    feats = []
    flat_acc = acc8.reshape(-1)
    flat_z = r.z.reshape(-1)
    for line in dem.stream_lines(rt, stream):
        coords = []
        for k in line:
            e, n = _xy(r, k)
            coords.append([rnd(e), rnd(n), rnd(flat_z[k])])
        last = line[-1]
        if rt.d8r[last] < 0:
            e, n = pour_point(r, rt, last)
            coords.append([rnd(e), rnd(n), rnd(flat_z[last])])
        feats.append(
            {
                "type": "Feature",
                "properties": {"upAreaM2": rnd(flat_acc[last], 1)},
                "geometry": {"type": "LineString", "coordinates": coords},
            }
        )
    return feats


class HydroFlow:
    name = "hydro.flow"
    title = "Runoff and catchments"
    description = "Flow paths from a drop point, catchments of outlets and the stream network."
    keys = frozenset(
        {"surface", "mode", "drop", "outlets", "method", "depressions", "streamAreaM2", "region", "run"}
    )
    required = frozenset({"surface", "mode"})
    choices = {  # noqa: RUF012 - read only
        "mode": frozenset({"runoff", "catchment", "streams"}),
        "method": frozenset({"d8", "dinf"}),
        "depressions": frozenset({"fill", "breach"}),
    }

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        check_common(params, self.name, self.keys, self.required)
        for key, allowed in self.choices.items():
            choice(params, key, allowed)
        if params.get("drop") is not None:
            check_point(params["drop"], "drop")
        outlets = params.get("outlets")
        if outlets is not None:
            if not isinstance(outlets, list) or len(outlets) > 100:
                raise JobError("outlets must be a list of up to 100 [E, N] points.")
            for k, o in enumerate(outlets):
                check_point(o, f"outlets[{k}]")
        a = params.get("streamAreaM2")
        if a is not None and (isinstance(a, bool) or not isinstance(a, int | float) or not a > 0):
            raise JobError("streamAreaM2 must be a positive area (square metres).")
        if params["mode"] == "runoff" and params.get("drop") is None:
            raise JobError("Runoff needs a drop point.")
        return dict(params)

    def inputs(self, params: dict[str, Any]) -> list[str]:
        return [f"survey/surfaces/{params['surface']}"]

    def plan(self, params: dict[str, Any]) -> list[Step]:
        def flow(ctx: StepContext) -> dict[str, Any]:
            p = ctx.params
            method = p.get("method") or "d8"
            depressions = p.get("depressions") or "breach"
            surf = load_surface(ctx.project, p["surface"], p.get("region"), MAX_CELLS, ctx.check)
            r = surf.raster
            ctx.progress(0.1, "Depressions")
            h = condition(r.z, depressions, ctx.check)
            ctx.progress(0.5, "Directions")
            rt = dem.routing(h, method)
            area = np.full(r.z.shape, r.cell * r.cell)
            ctx.progress(0.6, "Accumulation")
            acc = dem.accumulate(rt, area, ctx.check)
            if method == "d8":
                acc8 = acc
                rt8 = rt
            else:
                rt8 = dem.routing(h, "d8")
                acc8 = dem.accumulate(rt8, area, ctx.check)
            valid_area = float(np.isfinite(r.z).sum()) * r.cell * r.cell
            threshold = float(
                p.get("streamAreaM2")
                or min(STREAM_DEFAULT_MAX_M2, max(STREAM_DEFAULT_MIN_M2, STREAM_DEFAULT_SHARE * valid_area))
            )
            results: dict[str, Any] = {"mode": p["mode"], "method": method, "depressions": depressions}
            files: dict[str, Any] = {}
            notes: list[str] = []
            ctx.progress(0.8, "Outputs")
            if p["mode"] == "runoff":
                results["path"], files["path"] = self._runoff(ctx, r, rt, p["drop"])
            if p["mode"] in ("catchment", "streams"):
                feats = stream_features(r, rt8, acc8, threshold)
                write_geojson(ctx.stage("out/streams.geojson"), feats)
                files["streams"] = "streams.geojson"
                results["streamAreaM2"] = threshold
                results["streamLinks"] = len(feats)
                results["streamLengthM"] = float(
                    sum(
                        sum(
                            math.dist(a[:2], b[:2])
                            for a, b in itertools.pairwise(f["geometry"]["coordinates"])
                        )
                        for f in feats
                    )
                )
            if p["mode"] == "catchment":
                results["outlets"] = self._catchments(ctx, r, rt8, acc8, acc, p.get("outlets"), method, notes)
                files["catchments"] = "catchments.geojson"
            doc = write_run(ctx, self.name, surf, results, files, notes=notes)
            return {"results": doc["results"]}

        return [Step("flow", "Route the water", flow, 4.0), Step("commit", "Save the run", commit_run)]

    @staticmethod
    def _runoff(
        ctx: StepContext, r: Raster, rt: dem.Routing, drop: list[float]
    ) -> tuple[dict[str, Any], str]:
        e0, n0 = check_point(drop, "drop")
        cell = r.cell_of(e0, n0)
        if cell is None or not math.isfinite(r.z[cell[1], cell[0]]):
            raise JobError("The drop point is outside the surface (or the region).")
        start = cell[1] * r.nx + cell[0]
        # with D-infinity follow the larger share (D8 where it leaves the grid)
        main = np.where(rt.p2 > rt.p1, rt.r2, rt.r1)
        steer = dem.Routing(
            rt.shape, main, rt.r2, rt.p1, rt.p2, rt.d8, np.where(main >= 0, main, -1), rt.valid
        )
        cells = dem.trace(steer, start)
        zf = r.z.reshape(-1)
        pts = [(e0, n0, float(zf[start]))]
        for k in cells[1:]:
            e, n = _xy(r, k)
            pts.append((e, n, float(zf[k])))
        last = cells[-1]
        leaves = bool(steer.d8r[last] < 0)
        if leaves and rt.d8r[last] < 0:
            e, n = pour_point(r, rt, last)
            pts.append((e, n, float(zf[last])))
        chain = [0.0]
        for a, b in itertools.pairwise(pts):
            chain.append(chain[-1] + math.dist(a[:2], b[:2]))
        feat = {
            "type": "Feature",
            "properties": {"chainageM": [rnd(c, 2) for c in chain]},
            "geometry": {"type": "LineString", "coordinates": [[rnd(x), rnd(y), rnd(z)] for x, y, z in pts]},
        }
        write_geojson(ctx.stage("out/path.geojson"), [feat])
        return (
            {
                "start": [e0, n0],
                "end": [pts[-1][0], pts[-1][1]],
                "lengthM": chain[-1],
                "fallM": pts[0][2] - pts[-1][2],
                "cells": len(cells),
                "leavesSurface": leaves,
            },
            "path.geojson",
        )

    @staticmethod
    def _catchments(
        ctx: StepContext,
        r: Raster,
        rt8: dem.Routing,
        acc8: np.ndarray,
        acc: np.ndarray,
        given: list[list[float]] | None,
        method: str,
        notes: list[str],
    ) -> list[dict[str, Any]]:
        seeds: list[int] = []
        asked: list[list[float] | None] = []
        if given:
            for k, o in enumerate(given):
                s = snap(r, acc8, float(o[0]), float(o[1]))
                if s is None:
                    raise JobError(f"Outlet {k + 1} is outside the surface (or the region).")
                if s in seeds:
                    notes.append(
                        f"Outlet {k + 1} snapped to the same cell as an earlier one and is left out."
                    )
                    continue
                seeds.append(s)
                asked.append([float(o[0]), float(o[1])])
        else:
            outs = np.flatnonzero((rt8.d8r < 0) & rt8.valid.reshape(-1))
            if outs.size == 0:
                raise JobError("No water leaves this surface.")
            seeds.append(int(outs[np.argmax(acc8.reshape(-1)[outs])]))
            asked.append(None)
        lab = dem.label_watersheds(rt8, np.array(seeds, np.int64), np.arange(len(seeds), dtype=np.int64))
        feats = []
        out = []
        accf = acc.reshape(-1)
        for k, s in enumerate(seeds):
            ctx.check()
            mask = lab == k
            polys = cell_polygons(mask, r)
            area = float(mask.sum()) * r.cell * r.cell
            pp = pour_point(r, rt8, s)
            rec: dict[str, Any] = {
                "pourPoint": [pp[0], pp[1]],
                "areaM2": area,
                "cells": int(mask.sum()),
            }
            if asked[k] is not None:
                rec["outlet"] = asked[k]
            if method == "dinf":
                rec["contributingAreaM2"] = float(accf[s])
            out.append(rec)
            for poly in polys:
                feats.append(_polygon_feature(poly, {"outlet": k, "areaM2": rnd(area, 1)}))
        write_geojson(ctx.stage("out/catchments.geojson"), feats)
        return out


__all__ = ["HydroFlow", "condition", "pour_point", "snap"]
