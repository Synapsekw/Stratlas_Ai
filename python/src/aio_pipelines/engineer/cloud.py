"""Bounded reading of a point cloud around one asset, and ground removal.

Nothing here holds a whole scan: LAS files are streamed in chunks, each chunk is cropped to the
region and sampled with a seeded, uniform reservoir, so memory follows the region and the cap, not
the file. COPC (and other compressed) files go through PDAL with the region as a reader `bounds`,
so only that part is decompressed, and the result is streamed the same way.

Local frame: x east, y up, z south from the project origin `[E, N, H]`:
`local = (E - ox, H - oz, oy - N)`.
"""

from __future__ import annotations

import struct
from collections.abc import Callable
from dataclasses import dataclass
from itertools import pairwise
from pathlib import Path
from typing import Any

import numpy as np

from ..captures import local_delta
from ..modelfit.segment import ground_surface, read_kit_packed, read_png_packed
from ..runtime import JobError
from ..volumetric.cloud import LasHeader, read_las_chunks
from .axis import Axis
from .members import _components

Region = dict[str, Any]  # {"centre": [x, z], "radiusM": r} or {"min": [x, y, z], "max": [x, y, z]}
PDAL_FORMATS = ("copc", "laz")
LAS_FORMATS = ("las",)
READABLE = (*PDAL_FORMATS, *LAS_FORMATS, "kit-packed", "png-packed")


def _inside(xyz: np.ndarray, region: Region | None) -> np.ndarray:
    if region is None:
        return np.ones(len(xyz), dtype=bool)
    if "radiusM" in region:
        cx, cz = region["centre"]
        return np.hypot(xyz[:, 0] - cx, xyz[:, 2] - cz) <= float(region["radiusM"])
    lo = np.asarray(region["min"], dtype=np.float64)
    hi = np.asarray(region["max"], dtype=np.float64)
    return np.all((xyz >= lo) & (xyz <= hi), axis=1)


def _world_bounds(
    region: Region,
    origin: tuple[float, float, float],
    offset_m: float = 0.0,
    shift: tuple[float, float] = (0.0, 0.0),
) -> str:
    """A PDAL `bounds` string (x east, y north, z up) that contains the region. The region is in the
    drawn frame; `offset_m` is the cloud's height offset, taken off so the query is in file heights,
    and `shift` (east, north) is its date's line-up, taken off so the query is in file coordinates."""
    east, north = shift
    ox, oy, oz = origin[0] - east, origin[1] - north, origin[2]
    if "radiusM" in region:
        cx, cz = region["centre"]
        r = float(region["radiusM"])
        return f"([{ox + cx - r},{ox + cx + r}],[{oy - cz - r},{oy - cz + r}])"
    (x0, y0, z0), (x1, y1, z1) = region["min"], region["max"]
    return f"([{ox + x0},{ox + x1}],[{oy - z1},{oy - z0}],[{oz + y0 - offset_m},{oz + y1 - offset_m}])"


def pdal_translate_args(
    pdal: str,
    src: Path,
    dst: Path,
    fmt: str,
    region: Region | None,
    origin: tuple[float, float, float],
    offset_m: float = 0.0,
    shift: tuple[float, float] = (0.0, 0.0),
) -> list[str]:
    """`pdal translate` to a plain LAS with the region applied at the source: a COPC reader takes
    `bounds` (only that part is decompressed); LAZ and LAS have no spatial index, so `filters.crop`
    with the same bounds runs on the stream and only the region reaches the file. The source
    header (scale, offset, CRS) is forwarded, so the coordinates keep their precision."""
    args = [pdal, "translate", str(src), str(dst), "--writers.las.forward=all"]
    if region is not None:
        bounds = _world_bounds(region, origin, offset_m, shift)
        if fmt == "copc":
            args.append(f"--readers.copc.bounds={bounds}")
        else:
            args += ["crop", f"--filters.crop.bounds={bounds}"]
    return args


def las_crs(path: Path) -> dict[str, Any] | None:
    """The CRS a LAS header declares: `{"epsg": n}` from the GeoTIFF keys, else `{"wkt": ...}`."""
    with open(path, "rb") as f:
        head = f.read(375)
        header_size = struct.unpack_from("<H", head, 94)[0]
        n_vlr = struct.unpack_from("<I", head, 100)[0]
        f.seek(header_size)
        wkt = None
        for _ in range(n_vlr):
            rec = f.read(54)
            if len(rec) < 54:
                break
            user = rec[2:18].split(b"\0")[0]
            rid, length = struct.unpack_from("<HH", rec, 18)
            body = f.read(length)
            if user != b"LASF_Projection":
                continue
            if rid == 34735 and len(body) >= 8:
                nkeys = struct.unpack_from("<H", body, 6)[0]
                for k in range(nkeys):
                    if 8 + 8 * k + 8 > len(body):
                        break
                    key, loc, _count, value = struct.unpack_from("<4H", body, 8 + 8 * k)
                    if key in (3072, 2048) and loc == 0 and value not in (0, 32767):
                        return {"epsg": int(value)}
            elif rid in (2111, 2112):
                text = body.split(b"\0")[0].decode("utf-8", "replace").strip()
                wkt = text or wkt
    return {"wkt": wkt} if wkt and len(wkt) <= 20000 else None


_KEY_STEP_M = 1e-4  # order-free sample keys hash the coordinates rounded to 0.1 mm


def _coord_keys(xyz: np.ndarray, seed: int) -> np.ndarray:
    """A uniform key in [0, 1) per point from its coordinates alone (rounded to `_KEY_STEP_M`,
    mixed with a splitmix64 finaliser), so the same point gets the same key in any read order."""
    q = np.round(np.asarray(xyz, dtype=np.float64) / _KEY_STEP_M).astype(np.int64).view(np.uint64)
    with np.errstate(over="ignore"):
        h = np.uint64(seed & 0xFFFFFFFF) * np.uint64(0x9E3779B97F4A7C15)
        h = h ^ (q[:, 0] * np.uint64(0xBF58476D1CE4E5B9))
        h = h ^ (q[:, 1] * np.uint64(0x94D049BB133111EB))
        h = h ^ (q[:, 2] * np.uint64(0xD6E8FEB86659FD93))
        h = (h ^ (h >> np.uint64(30))) * np.uint64(0xBF58476D1CE4E5B9)
        h = (h ^ (h >> np.uint64(27))) * np.uint64(0x94D049BB133111EB)
        h = h ^ (h >> np.uint64(31))
    return (h >> np.uint64(11)).astype(np.float64) * (1.0 / (1 << 53))


class _Reservoir:
    """A seeded uniform sample of at most `cap` points from a stream, memory bounded by 2 x cap.

    `order_free` keys each point by its coordinates (`_coord_keys`) instead of drawing the keys in
    arrival order: the sample is then the same set of points whatever order the stream brings them
    in (PDAL does not promise one), as the kept set is always the points with the smallest keys."""

    def __init__(self, cap: int, seed: int, order_free: bool = False):
        self.cap = max(1, int(cap))
        self.seed = int(seed)
        self.order_free = order_free
        self.rng = np.random.default_rng(seed)
        self.pts: list[np.ndarray] = []
        self.cols: list[np.ndarray] = []  # uint8 colours, parallel to pts, when the source has them
        self.keys: list[np.ndarray] = []
        self.size = 0
        self.threshold = 1.0
        self.coloured = True

    def add(self, xyz: np.ndarray, rgb: np.ndarray | None = None) -> None:
        if len(xyz) == 0:
            return
        if rgb is None:
            self.coloured = False
        u = _coord_keys(xyz, self.seed) if self.order_free else self.rng.random(len(xyz))
        keep = u < self.threshold
        self.pts.append(xyz[keep])
        if rgb is not None:
            self.cols.append(rgb[keep])
        self.keys.append(u[keep])
        self.size += int(keep.sum())
        while self.size > 2 * self.cap:
            self.threshold *= 0.5
            keys = np.concatenate(self.keys)
            m = keys < self.threshold
            self.pts = [np.concatenate(self.pts)[m]]
            if self.coloured and self.cols:
                self.cols = [np.concatenate(self.cols)[m]]
            self.keys, self.size = [keys[m]], int(m.sum())

    def result(self) -> tuple[np.ndarray, np.ndarray | None]:
        if not self.pts:
            return np.zeros((0, 3)), None
        pts, keys = np.concatenate(self.pts), np.concatenate(self.keys)
        cols = np.concatenate(self.cols) if self.coloured and self.cols else None
        if len(pts) > self.cap:
            order = np.argsort(keys, kind="stable")[: self.cap]
            pts = pts[order]
            cols = cols[order] if cols is not None else None
        return pts, cols


def _stream_las(
    las: Path,
    region: Region | None,
    origin: tuple[float, float, float],
    res: _Reservoir,
    check,
    offset_m: float = 0.0,
    shift: tuple[float, float] = (0.0, 0.0),
) -> int:
    """Crop every chunk of a plain LAS to the region into `res`; return how many points were inside."""
    ox, oy, oz = origin
    dx, dz = local_delta(shift)
    inside = 0
    for x, y, z, rgb in read_las_chunks(las, check):
        local = np.column_stack([x - ox + dx, z - oz + offset_m, oy - y + dz])
        inside_mask = _inside(local, region)
        local = local[inside_mask]
        inside += len(local)
        res.add(local, None if rgb is None else _to_uint8(rgb[inside_mask]))
    return inside


def _to_uint8(rgb: np.ndarray) -> np.ndarray:
    """LAS colours (16-bit; some writers fill only the low 8 bits) as 8-bit channels."""
    c = np.asarray(rgb)
    if len(c) and c.max() > 255:
        c = np.floor(c / 256.0)
    return np.clip(c, 0, 255).astype(np.uint8)


def read_region(
    layer_path: Path,
    fmt: str,
    region: Region | None,
    max_points: int,
    ctx: Any,
    origin: tuple[float, float, float] = (0.0, 0.0, 0.0),
    seed: int = 0,
    offset_m: float = 0.0,
    shift: tuple[float, float] = (0.0, 0.0),
    order_free: bool = False,
) -> tuple[np.ndarray, dict[str, Any]]:
    """The points of a cloud inside `region` (local frame, or all when None), at most `max_points`.

    `offset_m` is the layer's height offset: it is added to every point's y, and the region (drawn
    heights) is turned back into file heights for the PDAL query. `shift` is the cloud's date
    line-up (east, north metres): the points are drawn that far over, so the region is where the
    date is lined up and the PDAL query (file coordinates) takes it back.

    `order_free` samples by coordinates (see `_Reservoir`), so a capped read keeps the same points
    whatever order the reader returns them in.

    `origin` is the project origin `[E, N, H]`. Returns the local xyz and
    `{"read": points inside the region, "kept": points returned, "crs": {...} | None,
    "bounds": {"min", "max"} of the kept points | None, "rgb": uint8 (N, 3) | None}`. `rgb` is the
    colour of the kept points when the source has it (LAS colour formats), None otherwise: absent
    colour is never invented. `read` counts what the region holds, not what the sample keeps. COPC and LAZ need PDAL (the region is the reader's `bounds`, or a
    `filters.crop` for LAZ). kit-packed and png-packed clouds are loaded whole before the crop
    (their readers have no bounded mode), so they are not memory-bounded by the region.
    """
    if fmt not in READABLE:
        raise JobError(f"A {fmt} cloud has an unsupported format; use COPC, LAS, kit-packed or png-packed.")
    check = getattr(ctx, "check", lambda: None)
    origin = (float(origin[0]), float(origin[1]), float(origin[2]))
    res = _Reservoir(max_points, seed, order_free)
    crs: dict[str, Any] | None = None
    if fmt == "las":
        LasHeader(layer_path)  # a clear error for a file that is not an uncompressed LAS
        crs = las_crs(layer_path)
        read = _stream_las(layer_path, region, origin, res, check, offset_m, shift)
    elif fmt in PDAL_FORMATS:
        from ..pointcloud import PDAL_MISSING, _run, find_pdal

        pdal = find_pdal()
        if not pdal:
            raise JobError(PDAL_MISSING)
        out = ctx.job.dir / "region.las"
        _run(
            ctx,
            pdal_translate_args(pdal, layer_path, out, fmt, region, origin, offset_m, shift),
            "Read the asset region",
        )
        try:
            crs = las_crs(out)
            read = _stream_las(out, region, origin, res, check, offset_m, shift)
        finally:
            out.unlink(missing_ok=True)
    else:
        pts = (
            read_kit_packed(layer_path)
            if fmt == "kit-packed"
            else read_png_packed(ctx.project, layer_path, check)
        )
        dx, dz = local_delta(shift)
        if offset_m or dx or dz:
            pts = pts + np.array([dx, offset_m, dz])
        pts = pts[_inside(pts, region)]
        read = len(pts)
        res.add(pts)
    xyz, rgb = res.result()
    bounds = (
        {"min": [float(v) for v in xyz.min(axis=0)], "max": [float(v) for v in xyz.max(axis=0)]}
        if len(xyz)
        else None
    )
    return xyz, {"read": int(read), "kept": len(xyz), "crs": crs, "bounds": bounds, "rgb": rgb}


@dataclass
class GroundSplit:
    kept: np.ndarray  # points at least `dist` above the ground surface
    ground: np.ndarray  # the points removed
    surface: Callable[[np.ndarray], np.ndarray]  # ground height at local (x, z) rows
    mask: np.ndarray | None = None  # over the input rows: True where kept (to carry colours along)

    @property
    def removed(self) -> int:
        return len(self.ground)


def split_ground(xyz: np.ndarray, dist: float) -> GroundSplit:
    """Split a cloud at the ground surface (`modelfit.segment.ground_surface`) plus `dist`."""
    if len(xyz) == 0:
        return GroundSplit(xyz, xyz, lambda xz: np.zeros(len(xz)), np.ones(0, dtype=bool))
    surface = ground_surface(xyz)
    keep = xyz[:, 1] >= surface(xyz[:, [0, 2]]) + dist
    return GroundSplit(xyz[keep], xyz[~keep], surface, keep)


def remove_ground(xyz: np.ndarray, dist: float) -> tuple[np.ndarray, int]:
    """The points at least `dist` above the ground surface, and how many were removed."""
    split = split_ground(xyz, dist)
    return split.kept, split.removed


def region_centre(region: Region | None) -> tuple[float, float] | None:
    """The plan centre (x, z) of a crop region, or None when there is no region."""
    if region is None:
        return None
    if "radiusM" in region:
        return float(region["centre"][0]), float(region["centre"][1])
    (x0, _, z0), (x1, _, z1) = region["min"], region["max"]
    return (x0 + x1) / 2, (z0 + z1) / 2


ATTACH_MARGIN_M = 1.0


def isolate_asset(
    xyz: np.ndarray,
    centre: tuple[float, float] | None,
    voxel: float = 0.3,
    eps: float = 0.5,
    min_share: float = 0.1,
) -> tuple[np.ndarray, dict[str, Any]]:
    """Keep the one connected structure the crop is about; drop neighbours and clutter.

    Call it after ground removal. Points are thinned to `voxel` cells, the cells are chained
    within `eps` (3D), and of the components at least `min_share` the size of the largest, the one
    whose plan bounding box is centred nearest `centre` is kept (the largest when `centre` is None;
    a tie within 1 m goes to the larger). Returns the kept points and
    `{"components", "kept", "dropped": [{"points", "min", "max"}, ...] (at most 8, over 50 points),
    "droppedPoints"}` so the caller can say what was excluded.
    """
    info: dict[str, Any] = {
        "components": 0,
        "kept": len(xyz),
        "dropped": [],
        "droppedPoints": 0,
        "mask": np.ones(len(xyz), dtype=bool),
    }
    if len(xyz) < 10:
        return xyz, info
    keys = np.floor(xyz / voxel).astype(np.int64)
    cells, inv = np.unique(keys, axis=0, return_inverse=True)
    inv = inv.reshape(-1)
    comps = _components((cells + 0.5) * voxel, eps, 1)
    label = np.empty(len(cells), dtype=np.int64)
    for i, c in enumerate(comps):
        label[c] = i
    point_label = label[inv]
    counts = np.bincount(point_label, minlength=len(comps))
    info["components"] = len(comps)
    big = [i for i in range(len(comps)) if counts[i] >= min_share * counts.max()]
    if centre is None:
        chosen = int(np.argmax(counts))
    else:
        cx, cz = centre
        dist = {}
        for i in big:
            p = xyz[point_label == i]
            dist[i] = float(
                np.hypot((p[:, 0].min() + p[:, 0].max()) / 2 - cx, (p[:, 2].min() + p[:, 2].max()) / 2 - cz)
            )
        nearest = min(dist.values())
        chosen = max((i for i in big if dist[i] <= nearest + 1.0), key=lambda i: counts[i])
    mask = point_label == chosen
    # parts that stand apart but belong to the asset (flues floating over an open crown, lights
    # a hand off the wall) lie inside its plan footprint plus a metre: they stay
    main = xyz[mask]
    mid = (main[:, [0, 2]].min(axis=0) + main[:, [0, 2]].max(axis=0)) / 2
    reach = float(np.hypot(main[:, 0] - mid[0], main[:, 2] - mid[1]).max()) + ATTACH_MARGIN_M
    y_top = float(main[:, 1].max()) + max(3.0, 0.1 * float(np.ptp(main[:, 1])))  # a flue over a crown
    near = (np.hypot(xyz[:, 0] - mid[0], xyz[:, 2] - mid[1]) <= reach) & (xyz[:, 1] <= y_top)
    for i in range(len(comps)):
        if i != chosen:
            sel = point_label == i
            if not np.any(sel & ~near):
                mask |= sel
    others = ~mask
    info["kept"] = int(mask.sum())
    info["mask"] = mask  # over the input rows, to carry colours along; not JSON
    info["droppedPoints"] = int(others.sum())
    if others.any():
        # the dropped parts, grouped into structures (parts within 2 m of each other are one)
        rest = xyz[others]
        cells, inv = np.unique(np.floor(rest).astype(np.int64), axis=0, return_inverse=True)
        inv = inv.reshape(-1)
        groups = _components(cells + 0.5, 2.0, 1)
        owner = np.empty(len(cells), dtype=np.int64)
        for g, idx in enumerate(groups):
            owner[idx] = g
        label_of = owner[inv]
        sizes = np.bincount(label_of, minlength=len(groups))
        for g in np.argsort(-sizes)[:8]:
            if sizes[g] < 50:
                break
            p = rest[label_of == g]
            info["dropped"].append(
                {
                    "points": int(sizes[g]),
                    "min": [float(v) for v in p.min(axis=0)],
                    "max": [float(v) for v in p.max(axis=0)],
                }
            )
    return xyz[mask], info


#: A base this far (metres) or less above the ground still counts as seen: ground removal leaves a
#: 0.15 m margin and slabs, plinths and scan noise add a few decimetres.
BASE_GAP_TOLERANCE_M = 1.0


@dataclass
class Base:
    point: tuple[float, float, float]  # on the axis, at the ground (or the lowest point seen)
    observed: bool
    basis: str  # "ground" or "lowest-point"
    gap_m: float  # lowest asset point above the ground; 0 when there is no ground
    note: str | None  # a sentence for the warnings when not observed


def find_base(axis: Axis, kept: np.ndarray, split: GroundSplit | None) -> tuple[Base, Axis]:
    """The asset base and the axis re-anchored there, so heights count from the base.

    With ground found (at least 100 ground points beyond 1.2 times the shaft radius, so the
    ground is not just the asset's own lowest layer) the base is the ground height under the axis.
    When the lowest asset point is more than `BASE_GAP_TOLERANCE_M` above it, the base was not
    scanned: it is flagged unobserved and heights still count from the ground. With no ground the
    base is the lowest observed point, flagged unobserved.
    """
    foot = np.asarray(axis.point)
    u, w, h = axis.to_frame(kept) if len(kept) else (np.zeros(1), np.zeros(1), np.zeros(1))
    # The footprint of connected cabinets/fences is not the shaft radius. Use the middle
    # vertical span, where a monopole's wall is visible, to choose a local terrain annulus.
    middle = (h > 0.2 * h.max()) & (h < 0.7 * h.max())
    radius = (
        float(np.median(np.hypot(u[middle], w[middle])))
        if middle.sum() >= 100
        else (float(np.percentile(np.hypot(u, w), 98)) if len(kept) else 0.0)
    )
    # A tapered shaft is wider at its cropped bottom than halfway up. Extrapolate
    # middle-wall medians so the ground filter cannot mistake that wall for terrain.
    if middle.sum() >= 100:
        bins = np.linspace(0.2 * h.max(), 0.7 * h.max(), 7)
        medians = []
        for lo, hi in pairwise(bins):
            band = (h >= lo) & (h < hi)
            if band.sum() >= 20:
                medians.append(((lo + hi) / 2, np.median(np.hypot(u[band], w[band]))))
        if len(medians) >= 4:
            hh, rr = np.asarray(medians).T
            slope, intercept = np.polyfit(hh, rr, 1)
            if slope < 0 and intercept < 2 * radius:
                radius = max(radius, float(intercept))
    ground = split.ground if split is not None else np.zeros((0, 3))
    far = np.hypot(ground[:, 0] - foot[0], ground[:, 2] - foot[2]) > 1.2 * radius if len(ground) else []
    if split is None or int(np.sum(far)) < 100:
        note = "No ground was found, so heights count from the lowest point seen."
        return Base(tuple(float(v) for v in foot), False, "lowest-point", 0.0, note), axis
    ground_y = float(split.surface(foot[None, [0, 2]])[0])
    distance = np.hypot(ground[:, 0] - foot[0], ground[:, 2] - foot[2])
    local = ground[(distance > max(1.2 * radius, 0.6)) & (distance < max(6 * radius, 3.0))]
    if len(local) >= 100:
        xz = local[:, [0, 2]] - foot[[0, 2]]
        occupied = np.unique((np.arctan2(xz[:, 1], xz[:, 0]) * 6 / np.pi).astype(int))
        # Require surrounding support; a single exposed patch cannot establish a plane.
        if len(occupied) >= 8:
            design = np.c_[xz, np.ones(len(local))]
            keep = np.ones(len(local), dtype=bool)
            for _ in range(3):
                coef = np.linalg.lstsq(design[keep], local[keep, 1], rcond=None)[0]
                residual = local[:, 1] - design @ coef
                lo, hi = np.percentile(residual[keep], [5, 80])
                keep = (residual >= lo - 0.02) & (residual <= hi + 0.02)
            if np.linalg.norm(coef[:2]) < 0.5:
                ground_y = float(coef[2] + np.percentile(residual[keep], 25))
    gap = float(foot[1] - ground_y)
    d = np.asarray(axis.dir)
    point = foot - d * (gap / d[1])
    moved = Axis(tuple(float(v) for v in point), axis.dir, axis.tilt_deg)
    observed = gap <= BASE_GAP_TOLERANCE_M
    note = (
        None
        if observed
        else f"The base was not scanned: the lowest point seen is {gap:.1f} m above the ground. Heights count from the ground."
    )
    return Base(tuple(float(v) for v in point), observed, "ground", max(0.0, gap), note), moved
