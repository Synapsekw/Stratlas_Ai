"""change.cloud: cloud-to-cloud distance between two capture dates, and change regions.

For every point of the later cloud, the distance to the earlier cloud (metres, data-conventions
section 14): the nearest earlier point (SciPy KD-tree), refined to the distance from the local
plane of its neighbours where they form one, else less the local point spacing (so the sampling of
the two surveys does not show as change), optionally signed along that plane's normal (up, or out of objects). Distances are capped
at ``cap`` (beyond that nothing is near). The later cloud is written again as a COPC with the
distance as a LAS 1.4 extra-bytes dimension ``Distance`` (float32, metres), added to the project as
a derived point cloud layer with ``scalar`` metadata, and summarised as ``region`` items of a change
set: points beyond ``minDistM`` gathered on a ground grid and joined by touching cells (the forward
pass gives what is new, the reverse pass what has gone).

Bounded memory: both clouds are read by PDAL (``readers.copc``, optional ``resolution``) one tile at
a time, each with a margin of ``cap`` so the tiled result equals the untiled one. A cloud layer
packed for viewing (``png-packed``) is read from its ``sources/<id>.las`` instead (``readers.las``
cropped to the tile, see ``sources.py``); the result is a COPC all the same. Tiles are kept in
the job's staging folder, so a cancelled job resumes at the next tile. PDAL is found as in
``pointcloud.py`` (``AIO_PDAL``, the pack's ``tools/pdal``, the PATH).
"""

from __future__ import annotations

import json
import math
import os
import subprocess
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, ClassVar, Protocol

import numpy as np

from ..params import known_keys, number, text
from ..pointcloud import PDAL_MISSING, find_pdal, pdal_env
from ..runtime import JobError, Step, StepContext, atomic_write_bytes, commit_files
from .changeset import change_set, change_set_id, dump_change_set, write_change_set
from .derived import (
    capture_label,
    capture_pair,
    crs_to_local,
    default_out,
    find_layer,
    layer_file,
    lonlat,
    origin_of,
    read_manifest,
    rounded,
    upsert_layer,
)
from .las import Las, read_las, write_las
from .sources import cloud_source

#: Founder defaults (``DEFAULT_CHANGE_THRESHOLDS``, 6 Oct 2026).
SIGNIFICANT_M = 0.05
FAR_M = 0.30
TOLERANCE_M = 0.05
#: Ground grid of the change regions, metres.
CELL_M = 0.25
#: Most points of either cloud read at once.
MAX_TILE_POINTS = 4_000_000
#: The registration check reads at most this square (metres) at the centre of the overlap.
SAMPLE_SIDE_M = 40.0
MIN_REGION_POINTS = 30
NEIGHBOURS = 10
#: Histogram bin of the distances (for the median and the 95th percentile), metres.
HIST_BIN_M = 0.001

Box = tuple[float, float, float, float]  # xmin, xmax, ymin, ymax (file CRS)


# ---------------------------------------------------------------- distances


def _voxel_mass(ref: np.ndarray, size: float) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Per-voxel sums of the reference points, for the centre of mass around a point."""
    v = np.floor(ref / size).astype(np.int64)
    lo = v.min(axis=0) - 1
    dims = v.max(axis=0) - lo + 2
    key = ((v[:, 0] - lo[0]) * dims[1] + (v[:, 1] - lo[1])) * dims[2] + (v[:, 2] - lo[2])
    uniq, inv = np.unique(key, return_inverse=True)
    sums = np.zeros((len(uniq), 3))
    for a in range(3):
        sums[:, a] = np.bincount(inv, weights=ref[:, a], minlength=len(uniq))
    counts = np.bincount(inv, minlength=len(uniq)).astype(np.float64)
    return uniq, sums, counts, np.concatenate([lo, dims])


def _mass_centre(mass: tuple[np.ndarray, ...], p: np.ndarray, size: float) -> np.ndarray:
    uniq, sums, counts, frame = mass
    lo, dims = frame[:3], frame[3:]
    v = np.floor(p / size).astype(np.int64) - lo
    total = np.zeros_like(p)
    n = np.zeros(len(p))
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for dz in (-1, 0, 1):
                w = v + np.array([dx, dy, dz])
                ok = np.all((w >= 0) & (w < dims), axis=1)
                key = (w[:, 0] * dims[1] + w[:, 1]) * dims[2] + w[:, 2]
                i = np.clip(np.searchsorted(uniq, key), 0, len(uniq) - 1)
                hit = ok & (uniq[i] == key)
                total[hit] += sums[i[hit]]
                n[hit] += counts[i[hit]]
    return total / np.maximum(n, 1)[:, None]


def c2c_distances(
    ref: np.ndarray,
    pts: np.ndarray,
    *,
    cap: float,
    signed: bool = False,
    k: int = NEIGHBOURS,
    chunk: int = 200_000,
) -> np.ndarray:
    """Distance of each of ``pts`` to the cloud ``ref`` (float32, metres, at most ``cap``)."""
    pts = np.asarray(pts, dtype=np.float64).reshape(-1, 3)
    ref = np.asarray(ref, dtype=np.float64).reshape(-1, 3)
    out = np.full(len(pts), cap, dtype=np.float32)
    if not len(pts) or not len(ref):
        return out
    from scipy.spatial import cKDTree

    # work near the origin: project coordinates are large
    centre = ref.mean(axis=0)
    ref = ref - centre
    pts = pts - centre
    tree = cKDTree(ref)
    mass = _voxel_mass(ref, 0.5) if signed else None
    kk = min(k, len(ref))
    for s in range(0, len(pts), chunk):
        p = pts[s : s + chunk]
        dist, idx = tree.query(p, k=kk, distance_upper_bound=cap)
        if kk == 1:
            dist, idx = dist[:, None], idx[:, None]
        found = np.isfinite(dist[:, 0])
        d = np.where(found, dist[:, 0], cap)
        sign = np.ones(len(p))
        full = np.isfinite(dist).all(axis=1) & (kk >= 4)
        if full.any():
            q = ref[idx[full]]
            c = q.mean(axis=1)
            dq = q - c[:, None, :]
            w, v = np.linalg.eigh(np.einsum("fki,fkj->fij", dq, dq) / kk)
            n = v[:, :, 0]
            curv = w[:, 0] / np.maximum(w.sum(axis=1), 1e-12)
            rel = p[full] - c
            along = np.einsum("fi,fi->f", rel, n)
            lateral = np.sqrt(np.maximum(np.einsum("fi,fi->f", rel, rel) - along**2, 0))
            spread = np.sqrt(np.einsum("fki,fki->fk", dq, dq)).mean(axis=1)
            planar = (curv < 0.05) & (lateral <= 2.5 * spread + 1e-9)
            # elsewhere (edges, corners, rough ground) the nearest point is up to a sampling step
            # away even where nothing changed: take off the local spacing (about spread / 1.1)
            rough = np.maximum(d[full] - spread / 1.1, 0)
            d[full] = np.where(planar, np.minimum(np.abs(along), d[full]), rough)
            if signed and mass is not None:
                # up for ground-like surfaces; out of objects (away from the nearby mass) for walls
                up = np.abs(n[:, 2]) >= 0.3
                n = np.where((up & (n[:, 2] < 0))[:, None], -n, n)
                wall = ~up
                if wall.any():
                    away = c[wall] - _mass_centre(mass, c[wall], 0.5)
                    flip = np.einsum("fi,fi->f", away, n[wall]) < 0
                    nw = n[wall]
                    nw[flip] = -nw[flip]
                    n[wall] = nw
                sg = np.sign(np.einsum("fi,fi->f", rel, n))
                sign[full] = np.where(sg == 0, 1, sg)
        if signed:
            partial = found & ~full
            if partial.any():
                below = p[partial, 2] < ref[idx[partial, 0], 2]
                sign[partial] = np.where(below, -1, 1)
        out[s : s + len(p)] = (np.minimum(d, cap) * sign).astype(np.float32)
    return out


def registration(distances: np.ndarray | float, tolerance: float = TOLERANCE_M) -> dict[str, Any]:
    """How well the dates line up: the median distance over the compared points."""
    if isinstance(distances, np.ndarray):
        shift = float(np.median(np.abs(distances))) if distances.size else 0.0
    else:
        shift = float(distances)
    reg: dict[str, Any] = {"ok": shift <= tolerance, "shiftM": round(shift, 4), "toleranceM": tolerance}
    if not reg["ok"]:
        reg["message"] = (
            f"The dates are not aligned: the clouds are {shift:.2f} m apart where nothing changed, "
            f"more than the {tolerance:.2f} m allowed. Align the clouds (for example to the survey "
            "control) and run the comparison again."
        )
    return reg


# ---------------------------------------------------------------- change regions


@dataclass
class Cells:
    """Aggregates of the changed points on a ground grid of ``cell`` metres (file CRS)."""

    keys: np.ndarray = field(default_factory=lambda: np.zeros((0, 2), dtype=np.int64))
    count: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=np.int64))
    sum_abs: np.ndarray = field(default_factory=lambda: np.zeros(0))
    sum_signed: np.ndarray = field(default_factory=lambda: np.zeros(0))
    max_abs: np.ndarray = field(default_factory=lambda: np.zeros(0))
    sum_xyz: np.ndarray = field(default_factory=lambda: np.zeros((0, 3)))
    min_xyz: np.ndarray = field(default_factory=lambda: np.zeros((0, 3)))
    max_xyz: np.ndarray = field(default_factory=lambda: np.zeros((0, 3)))

    def arrays(self) -> dict[str, np.ndarray]:
        return {k: getattr(self, k) for k in self.__dataclass_fields__}

    @staticmethod
    def merge(parts: Sequence[Cells]) -> Cells:
        parts = [p for p in parts if len(p.count)]
        if not parts:
            return Cells()
        keys = np.vstack([p.keys for p in parts])
        uniq, inv = np.unique(keys, axis=0, return_inverse=True)
        inv = inv.reshape(-1)
        m = len(uniq)

        def cat(name: str) -> np.ndarray:
            return np.concatenate([getattr(p, name) for p in parts])

        out = Cells(keys=uniq)
        out.count = np.bincount(inv, weights=cat("count"), minlength=m).astype(np.int64)
        out.sum_abs = np.bincount(inv, weights=cat("sum_abs"), minlength=m)
        out.sum_signed = np.bincount(inv, weights=cat("sum_signed"), minlength=m)
        out.max_abs = np.zeros(m)
        np.maximum.at(out.max_abs, inv, cat("max_abs"))
        sx, lo, hi = cat("sum_xyz"), cat("min_xyz"), cat("max_xyz")
        out.sum_xyz = np.column_stack([np.bincount(inv, weights=sx[:, a], minlength=m) for a in range(3)])
        out.min_xyz = np.full((m, 3), np.inf)
        out.max_xyz = np.full((m, 3), -np.inf)
        np.minimum.at(out.min_xyz, inv, lo)
        np.maximum.at(out.max_xyz, inv, hi)
        return out


def cell_aggregates(xyz: np.ndarray, d: np.ndarray, *, min_dist: float, cell: float) -> Cells:
    mask = np.abs(d) >= min_dist
    if not mask.any():
        return Cells()
    p = np.asarray(xyz, dtype=np.float64)[mask]
    dd = np.asarray(d, dtype=np.float64)[mask]
    ij = np.floor(p[:, :2] / cell).astype(np.int64)
    keys, inv = np.unique(ij, axis=0, return_inverse=True)
    inv = inv.reshape(-1)
    m = len(keys)
    c = Cells(keys=keys)
    c.count = np.bincount(inv, minlength=m).astype(np.int64)
    c.sum_abs = np.bincount(inv, weights=np.abs(dd), minlength=m)
    c.sum_signed = np.bincount(inv, weights=dd, minlength=m)
    c.max_abs = np.zeros(m)
    np.maximum.at(c.max_abs, inv, np.abs(dd))
    c.sum_xyz = np.column_stack([np.bincount(inv, weights=p[:, a], minlength=m) for a in range(3)])
    c.min_xyz = np.full((m, 3), np.inf)
    c.max_xyz = np.full((m, 3), -np.inf)
    np.minimum.at(c.min_xyz, inv, p)
    np.maximum.at(c.max_xyz, inv, p)
    return c


@dataclass
class Region:
    id: str
    verdict: str
    count: int
    mean_d: float
    max_d: float
    #: File CRS.
    centroid: np.ndarray
    bmin: np.ndarray
    bmax: np.ndarray
    #: Closed ring of ground coordinates (file CRS x, y), first point not repeated.
    outline: np.ndarray
    area_m2: float


def _components(keys: np.ndarray) -> np.ndarray:
    """Label cells joined by an edge or a corner (8-connectivity)."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components

    n = len(keys)
    lo = keys.min(axis=0) - 1
    width = int(keys[:, 1].max() - lo[1]) + 2
    codes = (keys[:, 0] - lo[0]) * width + (keys[:, 1] - lo[1])
    order = np.argsort(codes)
    sorted_codes = codes[order]
    rows: list[np.ndarray] = []
    cols: list[np.ndarray] = []
    for dx, dy in ((1, 0), (0, 1), (1, 1), (1, -1)):
        want = codes + dx * width + dy
        j = np.clip(np.searchsorted(sorted_codes, want), 0, n - 1)
        hit = sorted_codes[j] == want
        rows.append(np.nonzero(hit)[0])
        cols.append(order[j[hit]])
    r, c = np.concatenate(rows), np.concatenate(cols)
    graph = coo_matrix((np.ones(len(r)), (r, c)), shape=(n, n))
    return connected_components(graph, directed=False)[1]


def _outline(lo: np.ndarray, hi: np.ndarray) -> tuple[np.ndarray, float]:
    """Convex outline (x, y) of the changed points of some cells, from each cell's point extent."""
    corners = np.vstack(
        [
            np.column_stack([lo[:, 0], lo[:, 1]]),
            np.column_stack([hi[:, 0], lo[:, 1]]),
            np.column_stack([hi[:, 0], hi[:, 1]]),
            np.column_stack([lo[:, 0], hi[:, 1]]),
        ]
    )
    corners = np.unique(corners, axis=0)
    try:
        from scipy.spatial import ConvexHull

        hull = ConvexHull(corners)
        return corners[hull.vertices], float(hull.volume)
    except Exception:
        a, b = corners.min(axis=0), corners.max(axis=0)
        ring = np.array([[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]])
        return ring, float(np.prod(np.maximum(b - a, 0)))


def find_regions(
    forward: Cells,
    reverse: Cells,
    *,
    cell: float,
    min_points: int = MIN_REGION_POINTS,
    signed: bool = False,
) -> list[Region]:
    """Change regions: changed cells of either pass joined by touching cells, largest first."""
    both = Cells.merge([forward, reverse])
    if not len(both.count):
        return []
    # the share of each cell's points that came from the forward pass
    f_cells = {tuple(k): int(n) for k, n in zip(forward.keys.tolist(), forward.count.tolist(), strict=True)}
    f_count = np.array([f_cells.get(tuple(k), 0) for k in both.keys.tolist()], dtype=np.int64)
    f_signed = np.zeros(len(both.count))
    if len(forward.count):
        signed_of = {
            tuple(k): s for k, s in zip(forward.keys.tolist(), forward.sum_signed.tolist(), strict=True)
        }
        f_signed = np.array([signed_of.get(tuple(k), 0.0) for k in both.keys.tolist()])
    labels = _components(both.keys)
    regions: list[Region] = []
    for lab in np.unique(labels):
        sel = labels == lab
        count = int(both.count[sel].sum())
        if count < min_points:
            continue
        keys = both.keys[sel]
        first = keys[np.lexsort((keys[:, 0], keys[:, 1]))][0]
        share = f_count[sel].sum() / count
        if share >= 0.8:
            mean_signed = f_signed[sel].sum() / max(int(f_count[sel].sum()), 1)
            verdict = "removed" if signed and mean_signed < 0 else "added"
        elif share <= 0.2:
            verdict = "removed"
        else:
            verdict = "changed"
        outline, hull_area = _outline(both.min_xyz[sel], both.max_xyz[sel])
        regions.append(
            Region(
                id=f"region:{int(first[0])}_{int(first[1])}",
                verdict=verdict,
                count=count,
                mean_d=float(both.sum_abs[sel].sum() / count),
                max_d=float(both.max_abs[sel].max()),
                centroid=both.sum_xyz[sel].sum(axis=0) / count,
                bmin=both.min_xyz[sel].min(axis=0),
                bmax=both.max_xyz[sel].max(axis=0),
                outline=outline,
                # the cells overstate a region by their edges; the outline overstates a hollow one
                area_m2=min(float(sel.sum() * cell * cell), hull_area),
            )
        )
    regions.sort(key=lambda r: (-r.area_m2, r.id))
    return regions


# ---------------------------------------------------------------- tiles


def plan_tiles(bounds: Box, *, points: int, max_points: int, cell: float) -> list[Box]:
    """Square-ish tiles over ``bounds`` holding about ``max_points`` each, edges on the cell grid."""
    x0, x1, y0, y1 = bounds
    n = max(1, math.ceil(points / max(max_points, 1)))
    if n == 1:
        return [(x0, x1, y0, y1)]
    w, h = max(x1 - x0, cell), max(y1 - y0, cell)
    nx = max(1, round(math.sqrt(n * w / h)))
    ny = max(1, math.ceil(n / nx))
    gx, gy = math.floor(x0 / cell) * cell, math.floor(y0 / cell) * cell
    sx = math.ceil(((x1 - gx) / nx + cell * 1e-3) / cell) * cell
    sy = math.ceil(((y1 - gy) / ny + cell * 1e-3) / cell) * cell
    return [
        (gx + i * sx, gx + (i + 1) * sx, gy + j * sy, gy + (j + 1) * sy) for j in range(ny) for i in range(nx)
    ]


def in_tile(xyz: np.ndarray, tile: Box) -> np.ndarray:
    return (xyz[:, 0] >= tile[0]) & (xyz[:, 0] < tile[1]) & (xyz[:, 1] >= tile[2]) & (xyz[:, 1] < tile[3])


@dataclass
class TileData:
    xyz: np.ndarray
    las: Las | None = None


class Source(Protocol):
    def read(self, box: Box) -> TileData: ...


class MemorySource:
    """Points held in memory (tests, and small clouds)."""

    def __init__(self, xyz: np.ndarray):
        self.xyz = np.asarray(xyz, dtype=np.float64).reshape(-1, 3)

    def read(self, box: Box) -> TileData:
        x, y = self.xyz[:, 0], self.xyz[:, 1]
        sel = (x >= box[0]) & (x <= box[1]) & (y >= box[2]) & (y <= box[3])
        return TileData(self.xyz[sel])


@dataclass
class TileResult:
    points: int = 0
    changed: int = 0
    far: int = 0
    sum_abs: float = 0.0
    hist: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=np.int64))
    forward: Cells = field(default_factory=Cells)
    reverse: Cells = field(default_factory=Cells)


OnTile = Callable[[int, np.ndarray, np.ndarray, np.ndarray, Las | None], None]


def _bins(cap: float) -> int:
    return math.ceil(cap / HIST_BIN_M) + 1


def compare_tile(
    index: int,
    src_from: Source,
    src_to: Source,
    tile: Box,
    *,
    cap: float,
    min_dist: float,
    cell: float,
    far: float = FAR_M,
    signed: bool = False,
    on_tile: OnTile | None = None,
) -> TileResult:
    grown = (tile[0] - cap, tile[1] + cap, tile[2] - cap, tile[3] + cap)
    a, b = src_from.read(grown), src_to.read(grown)
    in_a, in_b = in_tile(a.xyz, tile), in_tile(b.xyz, tile)
    later = b.xyz[in_b]
    fwd = c2c_distances(a.xyz, later, cap=cap, signed=signed)
    rev = c2c_distances(b.xyz, a.xyz[in_a], cap=cap, signed=signed)
    if on_tile is not None and len(later):
        sub = replace(b.las, records=b.las.records[in_b]) if b.las is not None else None
        on_tile(index, np.nonzero(in_b)[0], later, fwd, sub)
    mag = np.abs(fwd)
    hist = np.bincount(np.minimum((mag / HIST_BIN_M).astype(np.int64), _bins(cap) - 1), minlength=_bins(cap))
    return TileResult(
        points=len(later),
        changed=int((mag >= min_dist).sum()),
        far=int((mag >= far).sum()),
        sum_abs=float(mag.sum()),
        hist=hist,
        forward=cell_aggregates(later, fwd, min_dist=min_dist, cell=cell),
        reverse=cell_aggregates(a.xyz[in_a], rev, min_dist=min_dist, cell=cell),
    )


@dataclass
class TiledResult:
    points: int
    changed: int
    far: int
    sum_abs: float
    hist: np.ndarray
    forward: Cells
    reverse: Cells


def combine(results: Sequence[TileResult], cap: float) -> TiledResult:
    hist = np.zeros(_bins(cap), dtype=np.int64)
    for r in results:
        if len(r.hist):
            hist += r.hist
    return TiledResult(
        points=sum(r.points for r in results),
        changed=sum(r.changed for r in results),
        far=sum(r.far for r in results),
        sum_abs=sum(r.sum_abs for r in results),
        hist=hist,
        forward=Cells.merge([r.forward for r in results]),
        reverse=Cells.merge([r.reverse for r in results]),
    )


def compare_tiled(
    src_from: Source,
    src_to: Source,
    tiles: Sequence[Box],
    *,
    cap: float,
    min_dist: float,
    cell: float,
    far: float = FAR_M,
    signed: bool = False,
    on_tile: OnTile | None = None,
) -> TiledResult:
    return combine(
        [
            compare_tile(
                i,
                src_from,
                src_to,
                t,
                cap=cap,
                min_dist=min_dist,
                cell=cell,
                far=far,
                signed=signed,
                on_tile=on_tile,
            )
            for i, t in enumerate(tiles)
        ],
        cap,
    )


def hist_quantile(hist: np.ndarray, q: float) -> float:
    total = int(hist.sum())
    if not total:
        return 0.0
    i = int(np.searchsorted(np.cumsum(hist), q * total))
    return (i + 0.5) * HIST_BIN_M


# ---------------------------------------------------------------- PDAL


def _pdal(ctx: StepContext, args: list[str], what: str) -> str:
    """Run PDAL, cancellable; its output goes to files (a full pipe would block it)."""
    work = ctx.job.dir / "work"
    work.mkdir(parents=True, exist_ok=True)
    out_path, err_path = work / "pdal.out", work / "pdal.err"
    with open(out_path, "wb") as out_f, open(err_path, "wb") as err_f:
        proc = subprocess.Popen(
            args,
            stdin=subprocess.DEVNULL,
            stdout=out_f,
            stderr=err_f,
            env=pdal_env(args[0]),
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        while proc.poll() is None:
            if ctx.cancel_event.is_set():
                proc.kill()
                proc.wait()
                ctx.check()
            time.sleep(0.05)
    out = out_path.read_text("utf-8", errors="replace")
    if proc.returncode != 0:
        msg = (err_path.read_text("utf-8", errors="replace") or out).strip().splitlines()
        raise JobError(f"PDAL could not {what}: {msg[-1] if msg else f'exit {proc.returncode}'}")
    return out


class PdalSource:
    """One COPC file (or a LAS/LAZ source) read by PDAL a box at a time into a plain LAS 1.4 tile.

    A COPC file is read by its octree (``readers.copc`` with ``bounds``); a LAS or LAZ file is read
    whole and cropped (``readers.las`` and ``filters.crop``), which suits the source clouds of
    viewing layers (``sources/<id>.las``).
    """

    def __init__(
        self,
        ctx: StepContext,
        pdal: str,
        path: Path,
        name: str,
        pdrf: int,
        resolution: float | None,
        copc: bool = True,
    ):
        self.ctx, self.pdal, self.path, self.name, self.pdrf, self.resolution = (
            ctx,
            pdal,
            path,
            name,
            pdrf,
            resolution,
        )
        self.copc = copc
        self.z: tuple[float, float] | None = None

    def read(self, box: Box) -> TileData:
        work = self.ctx.job.dir / "work"
        work.mkdir(parents=True, exist_ok=True)
        tmp = work / f"{self.name}.las"
        bounds = f"([{box[0]!r}, {box[1]!r}], [{box[2]!r}, {box[3]!r}]"
        bounds += f", [{self.z[0]!r}, {self.z[1]!r}])" if self.z else ")"
        stages: list[dict[str, Any]]
        if self.copc:
            reader: dict[str, Any] = {"type": "readers.copc", "filename": str(self.path), "bounds": bounds}
            if self.resolution:
                reader["resolution"] = self.resolution
            stages = [reader]
        else:
            stages = [
                {"type": "readers.las", "filename": str(self.path)},
                {"type": "filters.crop", "bounds": bounds},
            ]
            if self.resolution:
                stages.append({"type": "filters.sample", "radius": self.resolution})
        pipe = work / f"{self.name}.json"
        pipe.write_text(
            json.dumps(
                {
                    "pipeline": [
                        *stages,
                        {
                            "type": "writers.las",
                            "filename": str(tmp),
                            "minor_version": 4,
                            "dataformat_id": self.pdrf,
                            "scale_x": 0.001,
                            "scale_y": 0.001,
                            "scale_z": 0.001,
                            "offset_x": "auto",
                            "offset_y": "auto",
                            "offset_z": "auto",
                        },
                    ]
                }
            ),
            "utf-8",
        )
        _pdal(self.ctx, [self.pdal, "pipeline", str(pipe)], f"read {self.path.name}")
        las = read_las(tmp)
        tmp.unlink(missing_ok=True)
        return TileData(las.xyz, las)


def _info(ctx: StepContext, pdal: str, path: Path) -> dict[str, Any]:
    info = json.loads(_pdal(ctx, [pdal, "info", "--summary", str(path)], f"read {path.name}"))
    s = info.get("summary") or {}
    b = s.get("bounds") or {}
    if not {"minx", "maxx", "miny", "maxy"} <= set(b):
        raise JobError(f"PDAL found no points in {path.name}.")
    return {
        "count": int(s.get("num_points") or 0),
        "bounds": [b["minx"], b["maxx"], b["miny"], b["maxy"], b.get("minz", 0), b.get("maxz", 0)],
    }


#: LAS 1.2 point formats to the LAS 1.4 format of the tiles that keeps their colour (and NIR).
TILE_PDRF = {0: 6, 1: 6, 2: 7, 3: 7, 4: 6, 5: 7, 6: 6, 7: 7, 8: 8, 9: 6, 10: 8}


def _pdrf(ctx: StepContext, pdal: str, path: Path) -> int:
    meta = json.loads(_pdal(ctx, [pdal, "info", "--metadata", str(path)], f"read {path.name}"))
    pdrf = int((meta.get("metadata") or {}).get("dataformat_id") or 6)
    return TILE_PDRF.get(pdrf, 6)


def _cloud_file(project: Path, layer: dict[str, Any]) -> Path:
    """The COPC file of a cloud layer, else the LAS source of a cloud packed for viewing."""
    if layer.get("format") == "copc":
        return layer_file(project, layer)
    name = layer.get("name") or layer.get("id")
    return cloud_source(
        project,
        layer,
        f'The layer "{name}" is not a COPC cloud and has no LAS source (sources/{layer.get("id")}.las); '
        "convert it to COPC first.",
    )


# ---------------------------------------------------------------- the pipeline


def _box(params: dict[str, Any], key: str) -> dict[str, list[float]] | None:
    v = params.get(key)
    if v is None:
        return None
    ok = (
        isinstance(v, dict)
        and set(v) == {"min", "max"}
        and all(
            isinstance(v[k], list) and len(v[k]) == 3 and all(isinstance(x, int | float) for x in v[k])
            for k in ("min", "max")
        )
    )
    if not ok:
        raise JobError(f"{key} must be a box with min and max corners.")
    return {"min": [float(x) for x in v["min"]], "max": [float(x) for x in v["max"]]}


def _captures(params: dict[str, Any]) -> dict[str, str] | None:
    v = params.get("captures")
    if v is None:
        return None
    if not (isinstance(v, dict) and isinstance(v.get("from"), str) and isinstance(v.get("to"), str)):
        raise JobError("captures must name the earlier and the later date (from, to).")
    return {"from": v["from"], "to": v["to"]}


def validate_pair(params: dict[str, Any], name: str, keys: frozenset[str]) -> dict[str, Any]:
    known_keys(params, set(keys), name)
    a = text(params, "layerFrom", required=True)
    b = text(params, "layerTo", required=True)
    if a == b:
        raise JobError("Pick two different layers, one of each date.")
    lo = number(params, "minDistM", SIGNIFICANT_M, 1e-6, 10)
    hi = number(params, "maxDistM", FAR_M, 1e-6, 100)
    assert lo is not None and hi is not None
    if hi <= lo:
        raise JobError("maxDistM (far) must be larger than minDistM (significant).")
    out: dict[str, Any] = {"layerFrom": a, "layerTo": b, "minDistM": lo, "maxDistM": hi}
    captures = _captures(params)
    if captures:
        out["captures"] = captures
    out_dir = text(params, "out")
    if out_dir:
        out["out"] = out_dir.replace("\\", "/").strip("/")
    return out


class ChangeCloud:
    name = "change.cloud"
    title = "Point cloud change"
    description = "Cloud-to-cloud distance as a COPC Distance field, and regions of moved points."
    keys: ClassVar[frozenset[str]] = frozenset(
        {"layerFrom", "layerTo", "captures", "minDistM", "maxDistM", "signed", "spacingM", "region", "out"}
    )

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        out = validate_pair(params, self.name, self.keys)
        signed = params.get("signed", False)
        if not isinstance(signed, bool):
            raise JobError("signed must be true or false.")
        out["signed"] = signed
        spacing = number(params, "spacingM", None, 1e-4, 10)
        if spacing:
            out["spacingM"] = spacing
        region = _box(params, "region")
        if region:
            out["region"] = region
        return out

    def plan(self, params: dict[str, Any]) -> list[Step]:
        lo_d, far_d = float(params["minDistM"]), float(params["maxDistM"])
        cap = max(3.0, 10 * far_d)
        cell = max(CELL_M, 2 * float(params.get("spacingM") or 0))
        signed = bool(params.get("signed"))

        def context(ctx: StepContext) -> dict[str, Any]:
            manifest = read_manifest(ctx.project)
            a = find_layer(manifest, params["layerFrom"], "pointcloud", "point cloud")
            b = find_layer(manifest, params["layerTo"], "pointcloud", "point cloud")
            frm, to = capture_pair(params, a, b)
            files = [_cloud_file(ctx.project, layer) for layer in (a, b)]
            return {"manifest": manifest, "a": a, "b": b, "from": frm, "to": to, "files": files}

        def sources(ctx: StepContext, prep: dict[str, Any]) -> tuple[PdalSource, PdalSource]:
            pdal = find_pdal()
            if not pdal:
                raise JobError(PDAL_MISSING)
            res = params.get("spacingM")
            copc = prep.get("copc") or [True, True]
            sa = PdalSource(ctx, pdal, Path(prep["files"][0]), "from", int(prep["pdrf"][0]), res, copc[0])
            sb = PdalSource(ctx, pdal, Path(prep["files"][1]), "to", int(prep["pdrf"][1]), res, copc[1])
            if prep.get("zRange"):
                sa.z = sb.z = tuple(prep["zRange"])  # type: ignore[assignment]
            return sa, sb

        def prepare(ctx: StepContext) -> dict[str, Any]:
            c = context(ctx)
            pdal = find_pdal()
            if not pdal:
                raise JobError(PDAL_MISSING)
            files = c["files"]
            infos = [_info(ctx, pdal, f) for f in files]
            pdrfs = [_pdrf(ctx, pdal, f) for f in files]
            ba, bb = infos[0]["bounds"], infos[1]["bounds"]
            box = [max(ba[0], bb[0]), min(ba[1], bb[1]), max(ba[2], bb[2]), min(ba[3], bb[3])]
            z_range = None
            if params.get("region"):
                o = origin_of(c["manifest"])
                r = params["region"]
                # local box to the file CRS (x east, y up, z south)
                e0, e1 = o[0] + r["min"][0], o[0] + r["max"][0]
                n0, n1 = o[1] - r["max"][2], o[1] - r["min"][2]
                box = [max(box[0], e0), min(box[1], e1), max(box[2], n0), min(box[3], n1)]
                z_range = [o[2] + r["min"][1], o[2] + r["max"][1]]
            if box[0] >= box[1] or box[2] >= box[3]:
                raise JobError("The two clouds do not overlap, so there is nothing to compare.")
            set_id = change_set_id(c["from"], c["to"], self.name)
            tiles = plan_tiles(
                (box[0], box[1], box[2], box[3]),
                points=max(infos[0]["count"], infos[1]["count"]),
                max_points=MAX_TILE_POINTS,
                cell=cell,
            )
            prep = {
                "files": [str(f) for f in files],
                "pdrf": pdrfs,
                "copc": [c["a"].get("format") == "copc", c["b"].get("format") == "copc"],
                "zRange": z_range,
            }
            # registration on a sample at the centre of the overlap, before the long work
            cx, cy = (box[0] + box[1]) / 2, (box[2] + box[3]) / 2
            half = SAMPLE_SIDE_M / 2
            sample = (
                max(box[0], cx - half),
                min(box[1], cx + half),
                max(box[2], cy - half),
                min(box[3], cy + half),
            )
            sa, sb = sources(ctx, prep)
            ctx.progress(0.3, "Check that the dates line up")
            pa, pb = sa.read(sample), sb.read(sample)
            reg = registration(c2c_distances(pa.xyz, pb.xyz, cap=cap), TOLERANCE_M)
            ctx.log(f"Dates line up within {reg['shiftM']:.3f} m (median over {len(pb.xyz):,} points).")
            if not reg["ok"]:
                raise JobError(reg["message"])
            return {
                **prep,
                "from": c["from"],
                "to": c["to"],
                "setId": set_id,
                "out": params.get("out") or default_out(set_id),
                "tiles": [list(t) for t in tiles],
                "counts": [infos[0]["count"], infos[1]["count"]],
                "registration": reg,
            }

        def distance(ctx: StepContext) -> dict[str, Any]:
            prep = ctx.outputs("prepare")
            sa, sb = sources(ctx, prep)
            tiles = [tuple(t) for t in prep["tiles"]]
            written: list[str] = []

            def keep(i: int, idx: np.ndarray, xyz: np.ndarray, d: np.ndarray, las: Las | None) -> None:
                if las is None:
                    return
                write_las(
                    ctx.stage(f"tiles/{i:05d}.las"),
                    xyz,
                    template=las,
                    extra={"Distance": d},
                    descriptions={"Distance": "Distance to the earlier date, m"},
                )

            for i, tile in enumerate(tiles):
                ctx.check()
                npz = ctx.stage(f"tiles/{i:05d}.npz")
                if not npz.exists():
                    r = compare_tile(
                        i,
                        sa,
                        sb,
                        tile,
                        cap=cap,
                        min_dist=lo_d,
                        cell=cell,
                        far=far_d,
                        signed=signed,
                        on_tile=keep,
                    )
                    _save_tile(npz, r)
                if ctx.stage(f"tiles/{i:05d}.las").exists():
                    written.append(f"tiles/{i:05d}.las")
                ctx.progress((i + 1) / len(tiles), f"Tile {i + 1} of {len(tiles)}")
            if not written:
                raise JobError("The later cloud has no points where the two dates overlap.")
            return {"tiles": written}

        def write(ctx: StepContext) -> dict[str, Any]:
            pdal = find_pdal()
            if not pdal:
                raise JobError(PDAL_MISSING)
            tiles = ctx.outputs("distance")["tiles"]
            staged = ctx.stage("distance.copc.laz")
            pipe = ctx.stage("write.json")
            stages: list[Any] = [{"type": "readers.las", "filename": str(ctx.stage(t))} for t in tiles]
            stages.append(
                {
                    "type": "writers.copc",
                    "filename": str(staged),
                    "extra_dims": "all",
                    "scale_x": 0.001,
                    "scale_y": 0.001,
                    "scale_z": 0.001,
                    "offset_x": "auto",
                    "offset_y": "auto",
                    "offset_z": "auto",
                }
            )
            pipe.write_text(json.dumps({"pipeline": stages}), "utf-8")
            ctx.progress(0.1, "Write the COPC file")
            _pdal(ctx, [pdal, "pipeline", str(pipe)], "write the change cloud")
            if not staged.is_file():
                raise JobError("PDAL finished without writing the change cloud.")
            for t in tiles:
                ctx.stage(t).unlink(missing_ok=True)
            return {"bytes": staged.stat().st_size}

        def regions(ctx: StepContext) -> dict[str, Any]:
            prep = ctx.outputs("prepare")
            manifest = read_manifest(ctx.project)
            n = len(prep["tiles"])
            res = combine([_load_tile(ctx.stage(f"tiles/{i:05d}.npz")) for i in range(n)], cap)
            found = find_regions(res.forward, res.reverse, cell=cell, signed=signed)
            o = origin_of(manifest)
            items = [_region_item(r, o, manifest, far_d, prep["setId"]) for r in found]
            reg = dict(prep["registration"])
            stats = {
                "points": res.points,
                "changedPoints": res.changed,
                "farPoints": res.far,
                "regions": len(found),
                "added": sum(r.verdict == "added" for r in found),
                "removed": sum(r.verdict == "removed" for r in found),
                "changed": sum(r.verdict == "changed" for r in found),
                "meanM": round(res.sum_abs / max(res.points, 1), 4),
                "medianM": round(hist_quantile(res.hist, 0.5), 4),
                "p95M": round(hist_quantile(res.hist, 0.95), 4),
                "shiftM": reg["shiftM"],
            }
            cs = change_set(
                prep["setId"],
                prep["from"],
                prep["to"],
                self.name,
                items,
                layers=[prep["setId"]],
                stats=stats,
                run={"jobId": ctx.job.job_id, "params": dict(params)},
                registration=reg,
            )
            atomic_write_bytes(ctx.stage("changeset.json"), dump_change_set(cs))
            ctx.log(
                f"{res.points:,} points compared, {res.changed:,} moved more than {lo_d:.2f} m; "
                f"{len(found)} change regions."
            )
            return {"points": res.points, "regions": len(found)}

        def commit(ctx: StepContext) -> dict[str, Any]:
            prep = ctx.outputs("prepare")
            manifest = read_manifest(ctx.project)
            set_id, out = prep["setId"], prep["out"]
            copc_rel = f"{out}/distance.copc.laz"
            commit_files(ctx, [("distance.copc.laz", copc_rel)])
            data = json.loads(ctx.stage("changeset.json").read_text("utf-8"))
            write_change_set(ctx.out(f"change/{set_id}.json"), data)
            ctx.artifact(f"change/{set_id}.json")
            frm, to = prep["from"], prep["to"]
            layer = {
                "kind": "pointcloud",
                "id": set_id,
                "name": f"Cloud change {capture_label(manifest, frm)} to {capture_label(manifest, to)}",
                "visible": True,
                "capture": to,
                "derived": {
                    "kind": "change",
                    "from": frm,
                    "to": to,
                    "changeId": set_id,
                    "runId": ctx.job.job_id,
                    "source": [params["layerFrom"], params["layerTo"]],
                },
                "src": {"path": copc_rel},
                "format": "copc",
                "pointCount": int(ctx.outputs("regions").get("points") or 0),
                "scalar": {
                    "dim": "Distance",
                    "label": "Distance",
                    "unit": "m",
                    "range": [-far_d, far_d] if signed else [0, far_d],
                    "diverging": signed,
                },
            }
            upsert_layer(ctx.project, layer)
            ctx.log(f"Added the layer {set_id} ({copc_rel}).")
            return {"layer": set_id, "changeSet": f"change/{set_id}.json"}

        return [
            Step("prepare", "Check the clouds and that the dates line up", prepare, weight=1),
            Step("distance", "Measure the distance between the dates", distance, weight=8),
            Step("write", "Write the change cloud", write, weight=3),
            Step("regions", "Find the change regions", regions, weight=1),
            Step("commit", "Add the layer and the change set", commit, weight=0.5),
        ]


def _save_tile(path: Path, r: TileResult) -> None:
    arrays = {f"f_{k}": v for k, v in r.forward.arrays().items()}
    arrays.update({f"r_{k}": v for k, v in r.reverse.arrays().items()})
    arrays["hist"] = r.hist
    arrays["totals"] = np.array([r.points, r.changed, r.far, r.sum_abs], dtype=np.float64)
    tmp = path.with_name(f".{path.stem}.{os.getpid()}.tmp.npz")
    np.savez(tmp, **arrays)
    os.replace(tmp, path)


def _load_tile(path: Path) -> TileResult:
    with np.load(path) as z:
        fwd = Cells(**{k: z[f"f_{k}"] for k in Cells.__dataclass_fields__})
        rev = Cells(**{k: z[f"r_{k}"] for k in Cells.__dataclass_fields__})
        t = z["totals"]
        return TileResult(int(t[0]), int(t[1]), int(t[2]), float(t[3]), z["hist"], fwd, rev)


VERDICT_TEXT = {
    "added": "New or moved here",
    "removed": "Gone or moved away",
    "changed": "Changed surface",
}


def _region_item(
    r: Region, origin: np.ndarray, manifest: dict[str, Any], far: float, layer: str
) -> dict[str, Any]:
    centre = crs_to_local(r.centroid, origin)[0]
    lo = crs_to_local(r.bmin, origin)[0]
    hi = crs_to_local(r.bmax, origin)[0]
    ring = r.outline
    local = crs_to_local(np.column_stack([ring, np.full(len(ring), r.centroid[2])]), origin)
    item: dict[str, Any] = {
        "kind": "region",
        "id": r.id,
        "verdict": r.verdict,
        "label": f"{VERDICT_TEXT[r.verdict]}: {r.area_m2:.1f} m², up to {r.max_d:.2f} m",
        "score": round(min(1.0, r.mean_d / far), 3),
        "at": rounded(centre),
        "bounds": {"min": rounded(np.minimum(lo, hi)), "max": rounded(np.maximum(lo, hi))},
        "method": "cloud-to-cloud",
        "outlineLocal": [rounded(p) for p in local],
        "areaM2": round(r.area_m2, 3),
        "distance": {"meanM": round(r.mean_d, 4), "maxM": round(r.max_d, 4)},
        "layer": layer,
    }
    ll = lonlat(manifest, ring[:, 0], ring[:, 1])
    if ll and len(ll) >= 3:
        item["outline"] = ll
    return item
