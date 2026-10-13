"""The dense cloud's point budget (founder decision of 13 Oct 2026) and the disk a run needs.

Each preset has a budget of points: Fast stays sparse, Standard about 150 M, High about 400 M.
The spacing starts at the matching GSD (``gsd / scale``) and widens only when the site would hold
more points than that: ``voxel = max(gsd / scale, sqrt(area / (0.9 * budget)))``. The area is
where the sparse points are: 2 m cells with at least two points, dilated by two cells, clipped to
the processing region. A merge that still ends above 1.2 x the budget is merged again at
``voxel * sqrt(points / budget)``.
"""

from __future__ import annotations

import math

import numpy as np

BUDGET = {"fast": 0, "standard": 150_000_000, "high": 400_000_000}
AREA_CELL_M = 2.0
AREA_MIN_POINTS = 2
AREA_DILATE = 2
BUDGET_FILL = 0.9
REMERGE_OVER = 1.2
#: Bytes on disk per point: a fusion chunk (format 2), a fused tile (xyz float64, colour, float32
#: normal, int32 count), a LAS record (format 7) and a COPC point (LAZ, measured about 15).
CHUNK_BYTES = 18
FUSED_BYTES = 43
LAS_BYTES = 36
COPC_BYTES = 15
#: untwine's temporary files, bytes per point, while it runs: measured 277 MB for 3 M points
#: (92 a point, about 16x the COPC and 2.7x the LAS), with untwine 1.5.1 from the pipeline pack.
UNTWINE_TEMP_BYTES = 100
#: Raw fused points per point at the matching spacing: about how many photos see a spot.
RAW_PER_POINT = 4


def site_area(xy: np.ndarray, region=None, cell: float = AREA_CELL_M) -> float:
    """Square metres the sparse points ``xy`` (n, 2) cover; ``region`` a shapely polygon in the
    same coordinates."""
    xy = np.asarray(xy, float)
    xy = xy[np.isfinite(xy).all(axis=1)] if len(xy) else xy
    if len(xy) and region is not None:
        x0, y0, x1, y1 = region.bounds
        m = (AREA_DILATE + 1) * cell
        keep = (xy[:, 0] >= x0 - m) & (xy[:, 0] <= x1 + m)
        keep &= (xy[:, 1] >= y0 - m) & (xy[:, 1] <= y1 + m)
        xy = xy[keep]
    if not len(xy):
        return 0.0
    # Sparse: memory follows the occupied cells, not the bounding box of a stray point.
    cells = np.floor(xy / cell).astype(np.int64)
    lo = cells.min(0) - AREA_DILATE
    cells -= lo
    w = int(cells[:, 0].max()) + 1 + 2 * AREA_DILATE
    keys, counts = np.unique(cells[:, 1] * w + cells[:, 0], return_counts=True)
    keys = keys[counts >= AREA_MIN_POINTS]
    if not len(keys):
        return 0.0
    cy, cx = np.divmod(keys, w)
    d = np.arange(-AREA_DILATE, AREA_DILATE + 1)
    dy, dx = np.meshgrid(d, d, indexing="ij")
    occ = np.unique(
        (cy[:, None] + dy.ravel()) * w + (cx[:, None] + dx.ravel()),
    )
    if region is not None:
        import shapely

        oy, ox = np.divmod(occ, w)
        px = (ox + lo[0] + 0.5) * cell
        py = (oy + lo[1] + 0.5) * cell
        occ = occ[shapely.contains_xy(region, px, py)]
    return float(len(occ)) * cell * cell


def budget_voxel(gsd: float, scale: float, area: float, budget: int) -> float:
    """The cloud's spacing: the matching GSD, wider when the site would pass the budget."""
    base = gsd / scale if scale else gsd
    if budget <= 0 or area <= 0:
        return base
    return max(base, math.sqrt(area / (BUDGET_FILL * budget)))


def needs_remerge(points: int, budget: int) -> bool:
    return budget > 0 and points > REMERGE_OVER * budget


def remerge_voxel(voxel: float, points: int, budget: int) -> float:
    if budget <= 0:
        return voxel
    return voxel * math.sqrt(points / budget)


def disk_need(
    *,
    photos: int,
    pixels: int,
    scale: float,
    area: float,
    gsd: float,
    ortho_res: float,
    dsm_res: float,
    voxel: float,
    budget: int,
    sparse_points: int,
    cloud: bool,
) -> int:
    """Bytes a run needs free: depth maps (and their points), fusion chunks, fused tiles, the
    rasters and, for a cloud, the LAS, the COPC and untwine's temporary files; with 30 % and
    64 MB to spare."""
    depth = photos * pixels * scale**2 * 4 * 3 if scale else 0.0
    raw = area / (gsd / max(scale, 0.25)) ** 2 * RAW_PER_POINT if scale else float(sparse_points)
    merged = area / voxel**2
    if budget:
        merged = min(merged, REMERGE_OVER * budget)
    if not scale:
        merged = min(merged, float(sparse_points))
    need = (
        depth
        + raw * CHUNK_BYTES
        + merged * FUSED_BYTES
        + area / ortho_res**2 * 4 * 3
        + area / dsm_res**2 * 4 * 6
    )
    if cloud:
        need += merged * (LAS_BYTES + COPC_BYTES + UNTWINE_TEMP_BYTES)
    return int(need * 1.3 + 64 * 1024**2)
