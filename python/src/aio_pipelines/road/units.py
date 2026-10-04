"""Pavement footprint, defect density grids and PCI sample units.

Ported from the delivered road builder (``Road Review/_build/pci/grid_pci.py``). Two layouts:

- ``grid`` (the delivered one): square units of a UTM-aligned grid (15 m by default, 225 m2,
  the nominal ASTM D6433 asphalt unit). Every cell with at least 60 % pavement is a unit; smaller
  edge cells join the neighbouring unit with the most pavement (4-neighbours first, then
  diagonals); isolated slivers of at least 20 % stand alone. Chainage of a unit is that of the
  centreline vertex nearest its cell centre when the centreline came with chainage (as delivered),
  else of the nearest point on the line.
- ``chainage``: units along the centreline, ``unitLength`` metres long and ``lanes x laneWidth``
  wide (ASTM D6433 suggests 225 +/- 90 m2 for asphalt); a short last piece (under half a unit)
  joins the unit before it.

Quantities per unit are summed in imperial units as delivered: area distresses in square feet
(intersection area), length distresses in feet (the defect's extent times the share of its area
inside the unit), potholes as a count (by centroid). The pavement footprint is a raster (pixels
above 0 are pavement, the delivered heatmap) or the centreline buffered by the carriageway width.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from typing import Any

import numpy as np

from ..runtime import JobError
from .pci import FT, FT2, unit_pci, weighted
from .sources import Centreline, Defect

Check = Callable[[], None]
Progress = Callable[[float, str | None], None]
DENSITY_SIZES = (10, 20, 50)
SECTION_KM = 0.25


def _noop(*_a: Any) -> None:
    return None


class MaskFootprint:
    """Pavement from a raster: pixels above 0. The grid origin is the raster's top-left corner."""

    def __init__(self, path: str, dst_crs):
        import rasterio

        try:
            self.ds = rasterio.open(path)
        except Exception as e:
            raise JobError(f"The pavement raster could not be opened: {e}") from e
        t = self.ds.transform
        if t.b != 0 or t.d != 0 or t.a <= 0 or t.e >= 0:
            raise JobError("The pavement raster must be north up (no rotation).")
        if self.ds.crs and dst_crs and self.ds.crs != dst_crs:
            raise JobError("The pavement raster must be in the project CRS.")
        # the delivered builder used RES = 0.1 exactly: round away float noise in the transform
        self.res = round(t.a, 9)
        self.origin = (t.c, t.f)
        self.H, self.W = self.ds.height, self.ds.width
        self._grids: dict[float, np.ndarray] = {}
        self._base: tuple[int, np.ndarray] | None = None

    def _k(self, cell_m: float) -> int:
        k = round(cell_m / self.res)
        if k < 1 or abs(k * self.res - cell_m) > 1e-6 * cell_m:
            raise JobError(
                f"The cell size {cell_m} m is not a whole number of pavement raster pixels ({self.res} m)."
            )
        return k

    def _counts(self, k: int, check: Check, progress: Progress) -> np.ndarray:
        """Pavement pixels per k x k block (``pavement_grid`` of the delivered builder, before
        it scales the counts to m2)."""
        from rasterio.windows import Window

        H, W = self.H, self.W
        nh, nw = H // k + (H % k > 0), W // k + (W % k > 0)
        out = np.zeros((nh, nw), np.int64)
        step = k * max(1, 2000 // k)
        for r0 in range(0, H, step):
            check()
            blk = self.ds.read(1, window=Window(0, r0, W, min(step, H - r0))) > 0
            rh = blk.shape[0]
            ph = (-rh) % k
            pw = (-W) % k
            if ph or pw:
                blk = np.pad(blk, ((0, ph), (0, pw)))
            s = blk.reshape(blk.shape[0] // k, k, blk.shape[1] // k, k).sum(axis=(1, 3))
            out[r0 // k : r0 // k + s.shape[0]] = s
            progress(min(1.0, (r0 + step) / H), None)
        return out

    def prepare(self, cells_m: list[float], check: Check = _noop, progress: Progress = _noop) -> None:
        """Read the raster once for all the cell sizes: counts at their common divisor, summed up
        per size later (pixel counts are whole numbers, so the m2 are the same as per size)."""
        ks = [self._k(c) for c in cells_m]
        k0 = ks[0]
        for k in ks[1:]:
            k0 = math.gcd(k0, k)
        self._base = (k0, self._counts(k0, check, progress))

    def grid(self, cell_m: float, check: Check = _noop, progress: Progress = _noop) -> np.ndarray:
        """Pavement m2 per cell (``pavement_grid`` of the delivered builder)."""
        if cell_m in self._grids:
            return self._grids[cell_m]
        k = self._k(cell_m)
        if self._base is not None and k % self._base[0] == 0:
            f = k // self._base[0]
            b = self._base[1]
            ph, pw = (-b.shape[0]) % f, (-b.shape[1]) % f
            if ph or pw:
                b = np.pad(b, ((0, ph), (0, pw)))
            counts = b.reshape(b.shape[0] // f, f, b.shape[1] // f, f).sum(axis=(1, 3))
        else:
            counts = self._counts(k, check, progress)
        out = counts.astype(np.float64) * self.res * self.res
        self._grids[cell_m] = out
        return out

    def area_in(self, poly: Any) -> float:
        """Pavement m2 inside a polygon (pixel centres inside count)."""
        from rasterio.features import geometry_mask
        from rasterio.windows import from_bounds

        from .ortho import clip_window

        x0, y0, x1, y1 = poly.bounds
        win = clip_window(
            from_bounds(x0, y0, x1, y1, self.ds.transform).round_offsets().round_lengths(), self.W, self.H
        )
        if win is None:
            return 0.0
        data = self.ds.read(1, window=win) > 0
        inside = geometry_mask(
            [poly], out_shape=data.shape, transform=self.ds.window_transform(win), invert=True
        )
        return float((data & inside).sum()) * self.res * self.res

    def close(self) -> None:
        self.ds.close()


class PolygonFootprint:
    """Pavement from a polygon (the centreline buffered by the carriageway width)."""

    def __init__(self, geom: Any, snap: float = 50.0):
        x0, _, _, y1 = geom.bounds
        self.geom = geom
        self.origin = (math.floor(x0 / snap) * snap, math.ceil(y1 / snap) * snap)
        self._grids: dict[float, np.ndarray] = {}

    def grid(self, cell_m: float, check: Check = _noop, progress: Progress = _noop) -> np.ndarray:
        import shapely
        from shapely.prepared import prep

        if cell_m in self._grids:
            return self._grids[cell_m]
        ox, oy = self.origin
        _, y0, x1, _ = self.geom.bounds
        nh = math.ceil((oy - y0) / cell_m) + 1
        nw = math.ceil((x1 - ox) / cell_m) + 1
        out = np.zeros((nh, nw), np.float64)
        pg = prep(self.geom)
        for i in range(nh):
            check()
            boxes = [
                shapely.box(ox + j * cell_m, oy - (i + 1) * cell_m, ox + (j + 1) * cell_m, oy - i * cell_m)
                for j in range(nw)
            ]
            hit = [j for j, b in enumerate(boxes) if pg.intersects(b)]
            if hit:
                areas = shapely.area(shapely.intersection(np.array([boxes[j] for j in hit]), self.geom))
                out[i, hit] = areas
            progress((i + 1) / nh, None)
        self._grids[cell_m] = out
        return out

    def area_in(self, poly: Any) -> float:
        return float(self.geom.intersection(poly).area)

    def close(self) -> None:
        return None


def cell_box(origin: tuple[float, float], i: int, j: int, c: float):
    from shapely.geometry import box

    ox, oy = origin
    x0 = ox + j * c
    y1 = oy - i * c
    return box(x0, y1 - c, x0 + c, y1)


def density_grids(
    fp: MaskFootprint | PolygonFootprint, defects: list[Defect], check: Check = _noop
) -> dict[str, list[list[float]]]:
    """Defect count and area per 10, 20 and 50 m cell with pavement (cells over 10 % pavement)."""
    ox, oy = fp.origin
    dens: dict[str, list[list[float]]] = {}
    for c in DENSITY_SIZES:
        pav = fp.grid(float(c), check)
        cnt: dict[tuple[int, int], int] = {}
        area: dict[tuple[int, int], float] = {}
        for d in defects:
            check()
            x0, y0, x1, y1 = d.geom.bounds
            for i in range(int((oy - y1) // c), int((oy - y0) // c) + 1):
                for j in range(int((x0 - ox) // c), int((x1 - ox) // c) + 1):
                    ia = d.geom.intersection(cell_box(fp.origin, i, j, c)).area
                    if ia > 0.005:
                        cnt[(i, j)] = cnt.get((i, j), 0) + 1
                        area[(i, j)] = area.get((i, j), 0) + ia
        cells = []
        for i, j in zip(*np.nonzero(pav > 0.1 * c * c), strict=True):
            p = pav[i, j]
            n = cnt.get((int(i), int(j)), 0)
            ar = area.get((int(i), int(j)), 0.0)
            cells.append(
                [int(i), int(j), round(float(p), 1), n, round(ar, 2), round(min(100, 100 * ar / p), 2)]
            )
        dens[str(c)] = cells
    return dens


def _add(q: dict[str, float], key: str, v: float) -> None:
    q[key] = q.get(key, 0.0) + v


def grid_units(
    fp: MaskFootprint | PolygonFootprint,
    defects: list[Defect],
    cl: Centreline,
    su: float = 15.0,
    check: Check = _noop,
    progress: Progress = _noop,
) -> dict[str, Any]:
    """PCI sample units on the square grid (the delivered layout)."""
    ox, oy = fp.origin
    pav = fp.grid(su, check)
    qty: dict[tuple[int, int], dict[str, float]] = {}
    for d in defects:
        check()
        key, kind = d.cls.distress, d.cls.kind
        if key is None:
            continue
        if kind == "count":
            c = d.geom.centroid
            i, j = int((oy - c.y) // su), int((c.x - ox) // su)
            _add(qty.setdefault((i, j), {}), key, 1.0)
            continue
        x0, y0, x1, y1 = d.geom.bounds
        for i in range(int((oy - y1) // su), int((oy - y0) // su) + 1):
            for j in range(int((x0 - ox) // su), int((x1 - ox) // su) + 1):
                ia = d.geom.intersection(cell_box(fp.origin, i, j, su)).area
                if ia <= 0.005:
                    continue
                v = ia * FT2 if kind == "area" else d.extent * (ia / d.area) * FT
                _add(qty.setdefault((i, j), {}), key, v)

    min_pav = round(0.6 * su * su, 6)
    sliver = round(0.2 * su * su, 6)
    tot_pav = float(pav.sum())
    full = {(int(i), int(j)) for i, j in zip(*np.nonzero(pav >= min_pav), strict=True)}
    members: dict[tuple[int, int], list[tuple[int, int]]] = {k: [k] for k in full}
    for i, j in zip(*np.nonzero((pav > 0) & (pav < min_pav)), strict=True):
        i, j = int(i), int(j)
        host = None
        for nb in (
            [(i - 1, j), (i + 1, j), (i, j - 1), (i, j + 1)],
            [(i - 1, j - 1), (i - 1, j + 1), (i + 1, j - 1), (i + 1, j + 1)],
        ):
            c = [n for n in nb if n in full]
            if c:
                host = max(c, key=lambda n: pav[n])
                break
        if host:
            members[host].append((i, j))
        elif pav[i, j] >= sliver:
            members[(i, j)] = [(i, j)]
    units = []
    covered = 0.0
    n_all = len(members)
    for n_done, (key, cells) in enumerate(sorted(members.items())):
        check()
        p = float(sum(pav[c] for c in cells))
        covered += p
        q: dict[str, float] = {}
        for c in cells:
            for k2, v in qty.get(c, {}).items():
                q[k2] = q.get(k2, 0.0) + v
        res, det = unit_pci(q, p)
        i, j = key
        ex, ny = ox + (j + 0.5) * su, oy - (i + 0.5) * su
        km = cl.nearest_vertex_km(ex, ny) if cl.given else cl.project(ex, ny)[0]
        units.append(
            {
                "id": f"u{i}-{j}",
                "pavementM2": round(p, 1),
                "pci": res,
                "km": round(km, 3),
                "deducts": det,
                "cells": [[int(a), int(b)] for a, b in cells],
            }
        )
        progress((n_done + 1) / max(1, n_all), None)
    return {
        "layout": "grid",
        "unitM": su,
        "minPavementM2": min_pav,
        "coveragePct": round(100 * covered / tot_pav, 1) if tot_pav else 0.0,
        "pavementM2": tot_pav,
        "units": units,
    }


def unit_edges(total: float, length_m: float) -> list[float]:
    """Unit boundaries along the line (m): every ``length_m``; a last piece shorter than half a
    unit joins the unit before it."""
    n = int(total // length_m)
    if n == 0:
        return [0.0, total]
    rem = total - n * length_m
    full = n + 1 if rem >= 0.5 * length_m else n
    return [k * length_m for k in range(full)] + [total]


def unit_polygons(cl: Centreline, length_m: float, width_m: float) -> list[tuple[float, float, Any]]:
    """(start m, end m, polygon) of each unit: the centreline piece buffered with flat ends."""
    from shapely.geometry import LineString
    from shapely.ops import substring

    line = LineString(cl.xy)
    if line.length <= 0:
        raise JobError("The centreline has no length.")
    edges = unit_edges(line.length, length_m)
    return [
        (
            edges[k],
            edges[k + 1],
            substring(line, edges[k], edges[k + 1]).buffer(width_m / 2, cap_style="flat"),
        )
        for k in range(len(edges) - 1)
    ]


def chainage_units(
    fp: MaskFootprint | PolygonFootprint,
    defects: list[Defect],
    cl: Centreline,
    length_m: float,
    width_m: float,
    check: Check = _noop,
    progress: Progress = _noop,
) -> dict[str, Any]:
    """PCI sample units along the centreline, ``length_m`` long and ``width_m`` wide."""
    import shapely

    pieces = unit_polygons(cl, length_m, width_m)
    tree = shapely.STRtree([d.geom for d in defects]) if defects else None
    units = []
    tot = float(fp.geom.area) if isinstance(fp, PolygonFootprint) else float(fp.grid(10.0, check).sum())
    covered = 0.0
    for k, (s0, s1, poly) in enumerate(pieces):
        check()
        p = fp.area_in(poly)
        q: dict[str, float] = {}
        if tree is not None:
            for idx in tree.query(poly, predicate="intersects"):
                d = defects[int(idx)]
                key, kind = d.cls.distress, d.cls.kind
                if key is None:
                    continue
                if kind == "count":
                    if poly.contains(d.geom.centroid):
                        _add(q, key, 1.0)
                    continue
                ia = d.geom.intersection(poly).area
                if ia <= 0.005:
                    continue
                _add(q, key, ia * FT2 if kind == "area" else d.extent * (ia / d.area) * FT)
        if p <= 0:
            continue
        covered += p
        res, det = unit_pci(q, p)
        units.append(
            {
                "id": f"s{k:04d}",
                "pavementM2": round(p, 1),
                "pci": res,
                "km": round(cl.km_at_s((s0 + s1) / 2), 3),
                "fromKm": round(cl.km_at_s(s0), 3),
                "toKm": round(cl.km_at_s(s1), 3),
                "deducts": det,
                "cells": [],
                "_poly": poly,
            }
        )
        progress((k + 1) / len(pieces), None)
    return {
        "layout": "chainage",
        "unitM": length_m,
        "widthM": width_m,
        "coveragePct": round(100 * covered / tot, 1) if tot else 0.0,
        "pavementM2": tot,
        "units": units,
    }


def sections(units: list[dict[str, Any]], length_km: float) -> list[list[Any]]:
    """Pavement and weighted PCI per 250 m of chainage (``bins`` of the delivered builder)."""
    bins = []
    nb = math.ceil(length_km / SECTION_KM - 1e-9)
    for b in range(nb):
        sel = [u for u in units if b * SECTION_KM <= u["km"] < (b + 1) * SECTION_KM]
        bins.append(
            [round(b * SECTION_KM, 2), round(sum(u["pavementM2"] for u in sel), 1)]
            + [weighted(sel, s) for s in range(3)]
        )
    return bins
