"""Point cloud input and segmentation for model fitting: read a cloud layer into the local frame,
keep a region, thin it, remove the ground and split what stands on it into clusters.

Bounded memory: LAS is read in chunks and thinned per chunk to the voxel size, so a large scan
becomes a few million points before any fitting.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np

from ..runtime import JobError, StepContext

READABLE = ("copc", "kit-packed", "png-packed")


def voxel_thin(pts: np.ndarray, size: float) -> np.ndarray:
    """One point (the mean) per occupied voxel of `size` metres."""
    if len(pts) == 0 or size <= 0:
        return pts
    keys = np.floor(pts / size).astype(np.int64)
    _, inv, counts = np.unique(keys, axis=0, return_inverse=True, return_counts=True)
    inv = inv.reshape(-1)
    out = np.zeros((len(counts), 3))
    for k in range(3):
        out[:, k] = np.bincount(inv, weights=pts[:, k]) / counts
    return out


def read_kit_packed(path: Path) -> np.ndarray:
    """Planar little-endian: int16 x, y, z in millimetres per point, then one uint8 intensity each."""
    raw = path.read_bytes()
    if len(raw) % 7:
        raise JobError(f"{path.name} is not a kit-packed cloud (its size is not 7 bytes per point).")
    n = len(raw) // 7
    xyz = np.frombuffer(raw, dtype="<i2", count=3 * n).reshape(n, 3).astype(np.float64) / 1000.0
    return xyz


def read_png_packed(project: Path, index_path: Path, check: Callable[[], None]) -> np.ndarray:
    """An ``aio.pngcloud/1`` cloud (packages/pointcloud/README.md): every chunk's points, local frame.

    Each chunk PNG carries a byte stream in the R, G, B bytes of its pixels: nine planes of N bytes
    (x, y, z as uint16 low and high bytes, then r, g, b). Position = offset + scale * u per axis,
    from the chunk's ``quant``, else from its bounds over 0..65535. The chunks are disjoint (each
    level adds points), so all of them together are the cloud.
    """
    import json

    from PIL import Image

    from ..inspection.frame import asset_path

    try:
        index = json.loads(index_path.read_text("utf-8"))
        chunks = list(index["chunks"])
    except (ValueError, KeyError, TypeError) as e:
        raise JobError(f"{index_path.name} is not a png-packed cloud index.") from e
    parts = []
    for c in chunks:
        check()
        path = asset_path(project, {"path": c["file"]})
        if path is None or not path.is_file():
            raise JobError(f"The cloud chunk {c['file']} is missing.")
        n = int(c["points"])
        with Image.open(path) as im:
            stream = np.asarray(im.convert("RGB"), dtype=np.uint8).reshape(-1)
        if len(stream) < 9 * n:
            raise JobError(f"The cloud chunk {c['file']} is too small for its {n} points.")
        planes = stream[: 9 * n].reshape(9, n).astype(np.uint32)
        u = np.column_stack([planes[2 * a] | (planes[2 * a + 1] << 8) for a in range(3)]).astype(np.float64)
        q = c.get("quant")
        if isinstance(q, dict) and "offset" in q:
            offset = np.asarray(q["offset"], dtype=np.float64)
            scale = np.broadcast_to(np.asarray(q["scale"], dtype=np.float64), (3,))
        else:
            lo = np.asarray(c["bounds"]["min"], dtype=np.float64)
            hi = np.asarray(c["bounds"]["max"], dtype=np.float64)
            offset, scale = lo, (hi - lo) / 65535.0
        parts.append(offset + u * scale)
    return np.concatenate(parts) if parts else np.zeros((0, 3))


def load_layer_points(ctx: StepContext, manifest: dict[str, Any], layer_id: str, voxel: float) -> np.ndarray:
    """The points of a point cloud layer in the local frame (x east, y up, z south), thinned."""
    layer = next((lay for lay in manifest.get("layers", []) if lay.get("id") == layer_id), None)
    if layer is None:
        raise JobError(f'The project has no layer "{layer_id}".')
    if layer.get("kind") != "pointcloud":
        raise JobError(f'"{layer.get("name", layer_id)}" is not a point cloud layer.')
    fmt = layer.get("format")
    if fmt not in READABLE:
        raise JobError(
            f'"{layer.get("name", layer_id)}" is a {fmt} cloud; fitting reads COPC, kit-packed and '
            "png-packed clouds. "
            "Convert it to COPC first."
        )
    from ..inspection.frame import asset_path

    path = asset_path(ctx.project, layer.get("src"))
    if path is None or not path.is_file():
        raise JobError(f'The file of "{layer.get("name", layer_id)}" is missing.')
    if fmt == "kit-packed":
        return voxel_thin(read_kit_packed(path), voxel)
    if fmt == "png-packed":
        return voxel_thin(read_png_packed(ctx.project, path, ctx.check), voxel)
    # COPC: PDAL writes a plain LAS into the job folder, read here in chunks
    from ..pointcloud import PDAL_MISSING, _run, find_pdal
    from ..volumetric.cloud import read_las_chunks

    pdal = find_pdal()
    if not pdal:
        raise JobError(PDAL_MISSING)
    las = ctx.job.dir / "cloud.las"
    if not las.is_file():
        _run(ctx, [pdal, "translate", str(path), str(las)], "Read the point cloud")
    origin = manifest.get("origin") or [0, 0, 0]
    parts = []
    for x, y, z, _rgb in read_las_chunks(las, ctx.check):
        local = np.column_stack([x - origin[0], z - origin[2], origin[1] - y])
        parts.append(voxel_thin(local, voxel))
    return voxel_thin(np.concatenate(parts), voxel) if parts else np.zeros((0, 3))


def region_mask(pts: np.ndarray, region: Any, manifest: dict[str, Any]) -> np.ndarray:
    """Points inside a local box `{min, max}` or a lon/lat ring."""
    if region is None:
        return np.ones(len(pts), dtype=bool)
    if isinstance(region, dict):
        lo = np.asarray(region["min"], dtype=float)
        hi = np.asarray(region["max"], dtype=float)
        return np.all((pts >= lo) & (pts <= hi), axis=1)
    crs = manifest.get("crs") or {}
    if not isinstance(crs.get("epsg"), int):
        raise JobError("A lon/lat region needs a project coordinate system (EPSG). Use a box instead.")
    import shapely
    from rasterio.warp import transform

    origin = manifest.get("origin") or [0, 0, 0]
    lon = [float(p[0]) for p in region]
    lat = [float(p[1]) for p in region]
    E, N = transform("EPSG:4326", f"EPSG:{crs['epsg']}", lon, lat)
    poly = shapely.Polygon([(e - origin[0], origin[1] - n) for e, n in zip(E, N, strict=True)])
    return shapely.contains_xy(poly, pts[:, 0], pts[:, 2])


def ground_surface(
    pts: np.ndarray, cell: float = 1.0, max_window_m: float = 41.0, slope: float = 0.1
) -> Callable[[np.ndarray], np.ndarray]:
    """Ground height at local (x, z): a progressive morphological filter (Zhang et al. 2003) on
    the lowest point per cell. Openings with growing windows flag cells that stand higher than the
    allowed slope (objects of that size); the ground under them is filled from the nearest ground
    cells. Slopes up to `slope` and objects up to `max_window_m` across are handled."""
    from scipy import ndimage

    if len(pts) == 0:
        return lambda xz: np.zeros(len(xz))
    x0, z0 = pts[:, 0].min(), pts[:, 2].min()
    ix = np.floor((pts[:, 0] - x0) / cell).astype(int)
    iz = np.floor((pts[:, 2] - z0) / cell).astype(int)
    grid = np.full((ix.max() + 1, iz.max() + 1), np.inf)
    np.minimum.at(grid, (ix, iz), pts[:, 1])
    empty = ~np.isfinite(grid)
    if empty.all():
        return lambda xz: np.zeros(len(xz))
    if empty.any():
        _, (ni, nj) = ndimage.distance_transform_edt(empty, return_indices=True)
        grid = grid[ni, nj]
    z = grid.copy()
    objects = np.zeros(grid.shape, dtype=bool)
    w = 3
    while True:
        opened = ndimage.grey_opening(z, size=(w, w), mode="nearest")
        threshold = 0.3 + slope * (w - 1) * cell
        objects |= (z - opened) > threshold
        z = opened
        if w * cell >= max_window_m:
            break
        w = min(2 * w - 1, int(np.ceil(max_window_m / cell)) | 1)
    if objects.all():
        ground = opened
    elif objects.any():
        _, (ni, nj) = ndimage.distance_transform_edt(objects, return_indices=True)
        ground = grid[ni, nj]
    else:
        ground = grid
    ground = ndimage.uniform_filter(ground, size=3, mode="nearest")

    def at(xz: np.ndarray) -> np.ndarray:
        i = np.clip(np.floor((xz[:, 0] - x0) / cell).astype(int), 0, ground.shape[0] - 1)
        j = np.clip(np.floor((xz[:, 1] - z0) / cell).astype(int), 0, ground.shape[1] - 1)
        return ground[i, j]

    return at


def clusters(pts: np.ndarray, radius: float, min_size: int) -> list[np.ndarray]:
    """Euclidean clusters: index arrays of point groups linked within `radius`, largest first."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    from scipy.spatial import cKDTree

    n = len(pts)
    if n == 0:
        return []
    pairs = cKDTree(pts).query_pairs(radius, output_type="ndarray")
    graph = coo_matrix((np.ones(len(pairs), dtype=np.int8), (pairs[:, 0], pairs[:, 1])), shape=(n, n))
    count, labels = connected_components(graph, directed=False)
    sizes = np.bincount(labels, minlength=count)
    order = np.argsort(-sizes)
    return [np.flatnonzero(labels == c) for c in order if sizes[c] >= min_size]
