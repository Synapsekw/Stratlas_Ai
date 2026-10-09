"""Shared parts of the hydrology pipelines (data-conventions section 30): the surface window a run
works on, parameter checks, the output writers and the run folder.

**The window.** A run reads one prepared surface (``survey/surfaces/<id>/``, section 26) at its own
cell size, over its data extent or the bounding box of ``region`` (cells whose centre lies outside
the region are left out). Heights are float64 in memory, ``z[j, i]`` with row 0 the southernmost
and column 0 the westernmost, cell ``(i, j)`` centred at ``(originE + (i + 0.5) cell, originN +
(j + 0.5) cell)`` in the project CRS. Each pipeline bounds the cells it reads (``MAX_CELLS``) so a
run never holds more than a few hundred megabytes; a larger surface needs a region.

**The run folder** ``survey/hydro/<run>/``: ``run.json`` (``aio.hydro-run/1``, ``HydroRun`` in
``@aio/schema``) plus the outputs it lists in ``files``, all paths relative to the folder. Geometry
files (GeoJSON, DXF) are in the project CRS (E, N, metres), as the design linework is (section 28).
Grids are ``aio.grid/1`` (16-bit PNG and JSON, north-up, as ``survey.compare`` writes them) with a
colour view PNG beside them for the map. A run replaces an earlier run of the same id.
"""

from __future__ import annotations

import csv
import hashlib
import itertools
import math
import re
import shutil
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from ..params import known_keys
from ..runtime import JobError, StepContext, atomic_write_json, now_iso
from ..survey.compare import ProjectSurfaces, canonical
from ..survey.grid import TileSurface, normal_ring, ring_area

RUN_SCHEMA = "aio.hydro-run/1"
HYDRO_DIR = "survey/hydro"
#: Version of the hydrology arithmetic; part of every run's fingerprint.
HYDRO_VERSION = 1
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")

Check = Callable[[], None]


def _no_check() -> None:
    return None


# ------------------------------------------------------------------------------------ the window


@dataclass
class Raster:
    """Heights (or any values) on a north-growing grid in the project CRS (see the module doc)."""

    z: np.ndarray
    origin_e: float
    origin_n: float
    cell: float

    @property
    def ny(self) -> int:
        return int(self.z.shape[0])

    @property
    def nx(self) -> int:
        return int(self.z.shape[1])

    def centre(self, i: int | np.ndarray, j: int | np.ndarray) -> tuple[Any, Any]:
        return (
            self.origin_e + (np.asarray(i) + 0.5) * self.cell,
            self.origin_n + (np.asarray(j) + 0.5) * self.cell,
        )

    def cell_of(self, e: float, n: float) -> tuple[int, int] | None:
        """The cell holding (E, N), or None outside the window. A point on an edge belongs to the
        cell on its east or north side, except on the window's own east and north edges."""
        u = (e - self.origin_e) / self.cell
        v = (n - self.origin_n) / self.cell
        i = min(math.floor(u), self.nx - 1) if u <= self.nx else self.nx
        j = min(math.floor(v), self.ny - 1) if v <= self.ny else self.ny
        if not (0 <= i < self.nx and 0 <= j < self.ny):
            return None
        return i, j


@dataclass
class Surface:
    """The prepared surface a run reads: its id, name, fingerprint and the window of heights."""

    id: str
    name: str
    fingerprint: str
    raster: Raster
    #: The region ring (E, N) when one was given.
    region: list[tuple[float, float]] | None


def ring_mask(ring: list[tuple[float, float]], r: Raster) -> np.ndarray:
    """True where a cell centre lies inside ``ring`` (even-odd rule, a cell centre on an edge is in)."""
    import shapely
    from shapely.geometry import Polygon

    poly = Polygon(ring)
    shapely.prepare(poly)
    out = np.zeros((r.ny, r.nx), bool)
    xs = r.origin_e + (np.arange(r.nx) + 0.5) * r.cell
    for j in range(r.ny):
        y = r.origin_n + (j + 0.5) * r.cell
        out[j] = shapely.intersects_xy(poly, xs, np.full(r.nx, y))
    return out


def _read_level(g: TileSurface, level: int, i0: int, j0: int, w: int, h: int) -> np.ndarray:
    """Cells ``i0 ..``, ``j0 ..`` of pyramid level ``level`` (cell ``g.cell * 2**level``)."""
    if level == 0:
        return g.read(i0, j0, w, h)
    from ..survey.grid import TILE

    out = np.full((h, w), np.nan)
    c0, c1 = max(i0, 0) // TILE, (i0 + w - 1) // TILE
    r0, r1 = max(j0, 0) // TILE, (j0 + h - 1) // TILE
    for r in range(r0, r1 + 1):
        for c in range(c0, c1 + 1):
            t = g.tile(c, r, level)
            if t is None:
                continue
            a0, a1 = max(i0, c * TILE), min(i0 + w, (c + 1) * TILE)
            b0, b1 = max(j0, r * TILE), min(j0 + h, (r + 1) * TILE)
            if a0 < a1 and b0 < b1:
                out[b0 - j0 : b1 - j0, a0 - i0 : a1 - i0] = t[
                    b0 - r * TILE : b1 - r * TILE, a0 - c * TILE : a1 - c * TILE
                ]
    return out


def load_surface(
    project: Path,
    sid: str,
    region: list[list[float]] | None,
    max_cells: int,
    check: Check = _no_check,
    cell: float | None = None,
) -> Surface:
    """Read the surface ``sid`` over its data extent or ``region`` (cells outside are NaN).

    With ``cell`` the heights are resampled to cells of that size (aligned to the surface's
    origin): read from the coarsest pyramid level at or below that size, then sampled bilinearly
    at the new cell centres, so a fine surface never has to be read whole.
    """
    from ..survey.grid import ArraySurface, sample_cells

    ps = ProjectSurfaces(project)
    res = ps.grid(sid)
    g = res.grid
    assert isinstance(g, TileSurface)
    ext = res.extent or g.bounds
    ring = normal_ring(region) if region is not None else None
    if ring is not None:
        if len(ring) < 3 or ring_area(ring) <= 0:
            raise JobError("The region must be a ring of three or more points with an area.")
        xs = [p[0] for p in ring]
        ys = [p[1] for p in ring]
        box = (max(min(xs), ext[0]), max(min(ys), ext[1]), min(max(xs), ext[2]), min(max(ys), ext[3]))
    else:
        box = ext
    c = float(cell) if cell is not None else g.cell
    i0 = max(0, math.floor((box[0] - g.origin_e) / c + 1e-9))
    j0 = max(0, math.floor((box[1] - g.origin_n) / c + 1e-9))
    i1 = math.ceil((box[2] - g.origin_e) / c - 1e-9)
    j1 = math.ceil((box[3] - g.origin_n) / c - 1e-9)
    if cell is None:
        i1, j1 = min(g.nx, i1), min(g.ny, j1)
    if i1 <= i0 or j1 <= j0:
        raise JobError("The region does not overlap the surface.")
    w, h = i1 - i0, j1 - j0
    if w * h > max_cells:
        side = math.sqrt(max_cells) * c
        raise JobError(
            f"The area is {w:,} by {h:,} cells at {c:g} m; this tool takes at most {max_cells:,} cells "
            f"(about {side:,.0f} by {side:,.0f} m at this cell). Draw a region around the area of interest."
        )
    if cell is None or abs(c - g.cell) <= 1e-9 * g.cell:
        z = np.empty((h, w))
        for r0 in range(0, h, 256):
            check()
            rows = min(256, h - r0)
            z[r0 : r0 + rows] = g.read(i0, j0 + r0, w, rows)
    else:
        levels = int(g.meta.get("levels") or 1)
        level = max(0, min(levels - 1, math.floor(math.log2(c / g.cell) + 1e-9)))
        lc = g.cell * 2**level
        # the level cells under the window, one cell of margin for the bilinear posts
        a0 = math.floor(i0 * c / lc) - 1
        b0 = math.floor(j0 * c / lc) - 1
        a1 = math.ceil(i1 * c / lc) + 1
        b1 = math.ceil(j1 * c / lc) + 1
        check()
        src = _read_level(g, level, a0, b0, a1 - a0, b1 - b0)
        arr = ArraySurface(g.origin_e + a0 * lc, g.origin_n + b0 * lc, lc, src)
        z = sample_cells(arr, -a0 * lc, -b0 * lc, c, i0, j0, w, h)
    raster = Raster(z, g.origin_e + i0 * c, g.origin_n + j0 * c, c)
    if ring is not None:
        z[~ring_mask(ring, raster)] = np.nan
    if not np.isfinite(z).any():
        raise JobError("The surface has no heights in the region.")
    return Surface(sid, res.name, res.fingerprint, raster, ring)


# ------------------------------------------------------------------------------------ parameters


def check_point(v: Any, where: str) -> tuple[float, float]:
    if (
        not isinstance(v, list | tuple)
        or len(v) != 2
        or not all(isinstance(x, int | float) and not isinstance(x, bool) and math.isfinite(x) for x in v)
    ):
        raise JobError(f"{where} must be a point [E, N].")
    return float(v[0]), float(v[1])


def check_common(params: dict[str, Any], name: str, keys: frozenset[str], required: frozenset[str]) -> None:
    known_keys(params, set(keys), name)
    missing = sorted(k for k in required if params.get(k) is None)
    if missing:
        raise JobError(f"{name} needs: {', '.join(missing)}.")
    sid = params.get("surface")
    if not isinstance(sid, str) or not ID_RE.match(sid):
        raise JobError("surface must be a prepared surface id.")
    run = params.get("run")
    if run is not None and (not isinstance(run, str) or not ID_RE.match(run)):
        raise JobError("run must be an id: letters, digits, dot, dash or _.")
    region = params.get("region")
    if region is not None:
        if not isinstance(region, list) or not 3 <= len(region) <= 100_000:
            raise JobError("region must be a ring of 3 to 100,000 [E, N] points.")
        for k, p in enumerate(region):
            check_point(p, f"region[{k}]")


def choice(params: dict[str, Any], key: str, allowed: frozenset[str]) -> None:
    v = params.get(key)
    if v is not None and (not isinstance(v, str) or v not in allowed):
        raise JobError(f"{key} must be one of: {', '.join(sorted(allowed))}.")


# ---------------------------------------------------------------------------------------- writers


def grid16(values: np.ndarray, r: Raster, stem: str, kind: str, folder: Path) -> list[str]:
    """``values`` (row 0 south, NaN no data) as ``<stem>.png`` (16-bit) and ``<stem>.json`` (aio.grid/1):
    ``value = offset + scale * pixel``, pixel 0 no data, north-up."""
    from PIL import Image

    north_up = values[::-1]
    ok = np.isfinite(north_up)
    lo = float(north_up[ok].min()) if ok.any() else 0.0
    hi = float(north_up[ok].max()) if ok.any() else 0.0
    scale = max(1e-4, math.ceil((hi - lo) / 65534 * 1e6) / 1e6)
    offset = lo - scale
    q = np.zeros(north_up.shape, np.uint16)
    q[ok] = np.clip(np.round((north_up[ok] - offset) / scale), 1, 65535).astype(np.uint16)
    folder.mkdir(parents=True, exist_ok=True)
    Image.fromarray(q).save(folder / f"{stem}.png")
    atomic_write_json(
        folder / f"{stem}.json",
        {
            "schema": "aio.grid/1",
            "kind": kind,
            "file": f"{stem}.png",
            "x0": r.origin_e,
            "y1": r.origin_n + r.ny * r.cell,
            "res": r.cell,
            "width": r.nx,
            "height": r.ny,
            "scale": scale,
            "offset": offset,
            "nodata": 0,
        },
    )
    return [f"{stem}.json", f"{stem}.png"]


#: Water depth colours (metres): shallow light blue to deep navy.
DEPTH_STOPS: list[tuple[float, str, float]] = [
    (0.0, "#c6e9ff", 0.55),
    (0.25, "#6cc3f5", 0.7),
    (1.0, "#2a8bd6", 0.8),
    (3.0, "#1554a8", 0.85),
    (10.0, "#0b2a66", 0.9),
]


def colour_view(values: np.ndarray, path: Path, stops: list[tuple[float, str, float]] = DEPTH_STOPS) -> None:
    """``values`` (row 0 south) through the stops as an RGBA PNG, north-up, transparent where NaN."""
    from PIL import Image

    from ..change.imagery import colour_ramp

    rgba = colour_ramp(values[::-1], stops)
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba, "RGBA").save(path)


def view_bounds(r: Raster) -> list[float]:
    """West, south, east, north of a raster's cells (project CRS)."""
    return [r.origin_e, r.origin_n, r.origin_e + r.nx * r.cell, r.origin_n + r.ny * r.cell]


def write_geojson(path: Path, features: list[dict[str, Any]]) -> None:
    atomic_write_json(path, {"type": "FeatureCollection", "features": features}, indent=None)


def rnd(x: float, d: int = 3) -> float:
    return round(float(x), d)


# ------------------------------------------------------------------------------------- run folder


def run_id(ctx: StepContext) -> str:
    return str(ctx.params.get("run") or ctx.job.job_id)


def run_fingerprint(
    pipeline: str, params: dict[str, Any], surface_fp: str, extra: dict[str, Any] | None = None
) -> str:
    obj = {
        "hydro": HYDRO_VERSION,
        "pipeline": pipeline,
        "params": {k: v for k, v in params.items() if k != "run"},
        "surface": surface_fp,
        **(extra or {}),
    }
    return "sha256:" + hashlib.sha256(canonical(obj).encode("utf-8")).hexdigest()


def write_run(
    ctx: StepContext,
    pipeline: str,
    surface: Surface,
    results: dict[str, Any],
    files: dict[str, Any],
    extra_fp: dict[str, Any] | None = None,
    preview: bool = False,
    notes: list[str] | None = None,
) -> dict[str, Any]:
    """Stage ``run.json`` for the outputs staged under ``out/``."""
    params = {k: v for k, v in ctx.params.items()}
    doc: dict[str, Any] = {
        "schema": RUN_SCHEMA,
        "id": run_id(ctx),
        "pipeline": pipeline,
        "jobId": ctx.job.job_id,
        "computedAt": now_iso(),
        "surface": {"id": surface.id, "name": surface.name, "fingerprint": surface.fingerprint},
        "params": params,
        "cellM": surface.raster.cell,
        "results": results,
        "files": files,
        "fingerprint": run_fingerprint(pipeline, params, surface.fingerprint, extra_fp),
    }
    if preview:
        doc["preview"] = True
    if notes:
        doc["notes"] = notes
    atomic_write_json(ctx.stage("out/run.json"), doc)
    return doc


def commit_run(ctx: StepContext) -> dict[str, Any]:
    """Move the staged ``out/`` folder to ``survey/hydro/<run>/``, replacing an earlier one."""
    from ..runtime import commit_tree

    rel = f"{HYDRO_DIR}/{run_id(ctx)}"
    marker = ctx.job.dir / "steps" / ".committing"
    old = ctx.out(rel)
    if old.exists() and not marker.exists():
        shutil.rmtree(old)
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text("", "utf-8")
    n = commit_tree(ctx, "out", rel)
    marker.unlink(missing_ok=True)
    return {"out": rel, "files": n}


# ---------------------------------------------------------------------------------------- hyetograph


def read_hyetograph(path: Path) -> list[tuple[float, float]]:
    """Rows (time in minutes, intensity in mm/h) of a rainfall CSV, in time order.

    Comma, semicolon or tab separated; a first row that is not numbers is a header. Each row's
    intensity holds from its time to the next row's time; the rain stops at the last row's time.
    """
    try:
        text = path.read_text("utf-8-sig")
    except (OSError, UnicodeDecodeError) as e:
        raise JobError(f"The rainfall file could not be read: {e}") from e
    sample = text[:4096]
    delim = ";" if sample.count(";") > sample.count(",") else ("\t" if "\t" in sample else ",")
    rows: list[tuple[float, float]] = []
    for k, rec in enumerate(csv.reader(text.splitlines(), delimiter=delim)):
        cells = [c.strip() for c in rec if c.strip()]
        if not cells:
            continue
        try:
            t, i = float(cells[0]), float(cells[1])
        except (ValueError, IndexError) as e:
            if k == 0 and not rows:
                continue  # a header
            raise JobError(f"Line {k + 1} of the rainfall file is not a time and an intensity.") from e
        if not (math.isfinite(t) and math.isfinite(i)) or t < 0 or i < 0:
            raise JobError(f"Line {k + 1} of the rainfall file has a negative or invalid value.")
        if i > 1000:
            raise JobError(f"Line {k + 1}: {i:g} mm/h is more rain than this model takes (1,000 mm/h).")
        rows.append((t, i))
    if len(rows) < 2:
        raise JobError("The rainfall file needs at least two rows: time in minutes and intensity in mm/h.")
    for a, b in itertools.pairwise(rows):
        if b[0] <= a[0]:
            raise JobError("The rainfall times must increase from row to row.")
    return rows


def file_sha256(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
