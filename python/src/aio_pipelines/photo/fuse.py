"""Fusion: depth maps to one dense cloud with colours and normals, in bounded memory.

Each photo's depth map is turned into world points; a point is kept when at least ``min_agree``
(two) of its neighbouring photos see the same surface there (fusion v2: their depths agree within
``min(1 % of the depth, 3 x the matching GSD)``, see ``agree_limit``; geometric consistency, as
COLMAP's fusion does). The rule is edge aware: two agreeing photos where two or more others can
check the pixel, one where only one can (the block's edge), so the edge of the block is kept; a
pixel no other photo confirms is never kept. Kept points carry the photo's colour and a normal from the depth map's
neighbours, turned towards the camera.

Points go to square ground tiles on disk (``PointTiles``) as they come, one chunk (chunk format 2,
18 bytes a point) per photo and tile. ``merge`` (merge v2) then makes each tile's share of the
cloud in two passes: ``merge_tile`` averages the points per voxel (the point spacing asked for),
collapses each xy column to one point per two voxels of height in each of its clusters, so a
surface seen by ten photos is one clean layer, not ten noisy ones, and drops the points seen fewer
than twice in all (counted per collapsed bin, so depth noise that spreads a surface over two voxels
of height does not empty its columns); ``filter_tile`` then drops statistical outliers, judged over the tile and a one-voxel margin
of its neighbours so the seams are not thinned. Only a tile and its margin are ever in memory,
whatever the size of the site.
"""

from __future__ import annotations

import json
import math
import shutil
from collections.abc import Callable, Iterator, Mapping
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import numpy as np

from ..runtime import JobError, atomic_write_json, replace_over
from .scene import Camera, View, pixel_rays


@dataclass(frozen=True)
class FuseSettings:
    """When photos agree (fusion v2, 13 Oct 2026): a pixel is kept when at least ``min_agree`` of
    its ``neighbours`` see the same surface there, within ``tolerance`` of the depth and at most
    ``abs_tol`` metres (3 x the matching GSD on a run; infinite when not set). Where fewer than
    ``min_agree`` neighbours can check the pixel (the block's edge), one agreeing is enough: two
    agreeing photos where two others can check it, one where only one can."""

    tolerance: float = 0.01
    min_agree: int = 2
    neighbours: int = 6
    abs_tol: float = math.inf

    @classmethod
    def for_run(cls, gsd: float, scale: float) -> FuseSettings:
        """The settings of a run matched at ``scale`` (a fraction of the photo) with photo GSD ``gsd``."""
        return cls(abs_tol=3.0 * gsd / scale) if scale else cls()


def agree_limit(z: np.ndarray, settings: FuseSettings) -> np.ndarray:
    """How far apart two depths may be and still agree, at depth ``z``."""
    return np.minimum(settings.tolerance * z, settings.abs_tol)


CHUNK_FORMAT = 2


def pack_chunk(
    xyz: np.ndarray, rgb: np.ndarray, normal: np.ndarray, corner: tuple[float, float]
) -> dict[str, np.ndarray]:
    """One tile's points as chunk format 2, 18 bytes a point: x and y as float32 offsets from the
    tile's corner, z as float32 above the chunk's whole-metre base (so float32 keeps 0.1 mm at any
    elevation), normals as int8 x 127, colours as uint8."""
    z0 = math.floor(float(xyz[:, 2].min())) if len(xyz) else 0.0
    base = np.array([corner[0], corner[1], z0], np.float64)
    n = np.nan_to_num(np.asarray(normal, np.float64))
    return {
        "format": np.array(CHUNK_FORMAT, np.int16),
        "base": base,
        "xy": (xyz[:, :2] - base[:2]).astype(np.float32),
        "z": (xyz[:, 2] - base[2]).astype(np.float32),
        "normal": np.clip(np.round(n * 127.0), -127, 127).astype(np.int8),
        "rgb": np.asarray(rgb, np.uint8),
    }


def unpack_chunk(f: Mapping[str, np.ndarray]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """A chunk back as world xyz (float64), colours (uint8) and normals (float32)."""
    if "format" not in f or int(f["format"]) != CHUNK_FORMAT:
        raise JobError("A fusion chunk of an older format was found; start the processing again.")
    base = np.asarray(f["base"], np.float64)
    z = f["z"]
    xyz = np.empty((len(z), 3))
    xyz[:, :2] = f["xy"].astype(np.float64) + base[:2]
    xyz[:, 2] = z.astype(np.float64) + base[2]
    return xyz, np.asarray(f["rgb"], np.uint8), f["normal"].astype(np.float32) / 127.0


def world_points(view: View, cam: Camera, depth: np.ndarray, rays: np.ndarray | None = None) -> np.ndarray:
    """(h, w, 3) world points of a depth map (NaN where empty)."""
    r = pixel_rays(cam) if rays is None else rays
    pc = r.astype(np.float64) * depth[..., None].astype(np.float64)
    return (pc - view.t) @ view.r


def normals_of(points: np.ndarray, centre: np.ndarray) -> np.ndarray:
    """Unit normals (h, w, 3) from central differences of a point map, facing ``centre``."""
    dx = np.zeros_like(points)
    dy = np.zeros_like(points)
    dx[:, 1:-1] = points[:, 2:] - points[:, :-2]
    dy[1:-1, :] = points[2:, :] - points[:-2, :]
    n = np.cross(dx, dy)
    ln = np.linalg.norm(n, axis=-1, keepdims=True)
    with np.errstate(invalid="ignore", divide="ignore"):
        n = n / ln
    flip = np.sum(n * (centre - points), axis=-1) < 0
    n[flip] *= -1
    return n


def consistent(
    view: View,
    cam: Camera,
    depth: np.ndarray,
    others: list[tuple[View, Camera, np.ndarray]],
    settings: FuseSettings,
) -> tuple[np.ndarray, np.ndarray]:
    """World points (h, w, 3) of a depth map and how many other photos agree with each pixel."""
    pts = world_points(view, cam, depth)
    ok = np.isfinite(depth)
    agree = np.zeros(depth.shape, np.int32)
    flat = pts[ok]
    got = np.zeros(len(flat), np.int32)
    avail = np.zeros(len(flat), np.int32)
    for ov, oc, od in others:
        x, y, z = ov.project(flat, oc)
        inside = (z > 0) & (x >= 0) & (y >= 0) & (x < oc.width) & (y < oc.height)
        xi = np.clip(np.floor(x).astype(np.int64), 0, oc.width - 1)
        yi = np.clip(np.floor(y).astype(np.int64), 0, oc.height - 1)
        dz = od[yi, xi]
        with np.errstate(invalid="ignore"):
            good = inside & np.isfinite(dz) & (np.abs(dz - z) <= agree_limit(z, settings))
        got += good.astype(np.int32)
        avail += (inside & np.isfinite(dz)).astype(np.int32)
    # edge-aware: where fewer than ``min_agree`` neighbours can check a pixel (the block's edge),
    # one agreeing neighbour is enough; a pixel nobody confirms is never kept
    got[(avail < settings.min_agree) & (got >= 1)] = settings.min_agree
    agree[ok] = got
    return pts, agree


@dataclass(frozen=True)
class MergeRule:
    """How a tile's fused points become the cloud (merge v2, 13 Oct 2026; ``version`` 3 counts
    after the collapse): with ``collapse``, each xy column keeps one point per ``2 x voxel`` of
    height in each of its clusters; then the points seen fewer than ``min_count`` times in all go
    (counted per collapsed bin, or per voxel without ``collapse``); then, with ``outliers``, points whose mean distance to their
    ``k`` nearest neighbours is more than ``sigma`` standard deviations above the tile's mean go."""

    min_count: int = 2
    outliers: bool = True
    k: int = 16
    sigma: float = 2.5
    version: int = 3
    collapse: bool = True


DENSE_RULE = MergeRule()
#: The Fast preset's sparse points: one point a voxel, already few and clean, so every one stays
#: (no count filter, no column collapse, no outlier filter).
SPARSE_RULE = MergeRule(min_count=1, outliers=False, collapse=False)


def remove_tree(path: Path) -> None:
    """Delete a folder, or refuse naming a file that stayed (on Windows, one another program
    holds open): a merge or fusion that carried on would take what is left as its own."""
    shutil.rmtree(path, ignore_errors=True)
    if not path.exists():
        return
    left = next((q for q in sorted(path.rglob("*")) if q.is_file()), path)
    raise JobError(
        f"Could not delete {left}; it may be open in another program. Close it, then run the "
        "processing again."
    )


class ChunksDropped(JobError):
    """The fusion chunks a merge needs were deleted after an earlier, complete merge (perhaps
    under another merge key): the photos must be fused again before this merge can run."""


class PointTiles:
    """Points in square ground tiles. Fusion writes chunks (chunk format 2) to
    ``chunks/<tile>/<name>.npz`` under ``chunks`` (``root/chunks`` unless given); ``merge`` writes
    ``fused/<tile>.npz`` under ``root``. Coordinates are model (grid frame) metres."""

    def __init__(self, root: Path, tile: float, chunks: Path | None = None):
        self.root = root
        self.tile = float(tile)
        self.chunks_dir = chunks if chunks is not None else root / "chunks"

    def key(self, x: float, y: float) -> tuple[int, int]:
        return math.floor(x / self.tile), math.floor(y / self.tile)

    def add(self, name: str, xyz: np.ndarray, rgb: np.ndarray, normal: np.ndarray) -> int:
        if not len(xyz):
            return 0
        tx = np.floor(xyz[:, 0] / self.tile).astype(np.int64)
        ty = np.floor(xyz[:, 1] / self.tile).astype(np.int64)
        order = np.lexsort((ty, tx))
        tx, ty = tx[order], ty[order]
        xyz, rgb, normal = xyz[order], rgb[order], normal[order]
        cut = np.nonzero((np.diff(tx) != 0) | (np.diff(ty) != 0))[0] + 1
        for a, b in zip(np.r_[0, cut], np.r_[cut, len(tx)], strict=True):
            d = self.chunks_dir / f"{tx[a]}_{ty[a]}"
            d.mkdir(parents=True, exist_ok=True)
            tmp = d / f".{name}.tmp.npz"
            corner = (float(tx[a]) * self.tile, float(ty[a]) * self.tile)
            np.savez(tmp, **pack_chunk(xyz[a:b], rgb[a:b], normal[a:b], corner))
            replace_over(tmp, d / f"{name}.npz")
        return len(xyz)

    def chunk_tiles(self) -> list[str]:
        base = self.chunks_dir
        if not base.is_dir():
            return []
        return sorted(p.name for p in base.iterdir() if p.is_dir() and not p.name.startswith("."))

    def merge(
        self,
        voxel: float,
        keep: Callable[[np.ndarray], np.ndarray] | None = None,
        check: Callable[[], None] = lambda: None,
        progress: Callable[[float, str | None], None] = lambda f, m=None: None,
        rule: MergeRule = DENSE_RULE,
        run_tiles: Callable[..., None] | None = None,
    ) -> dict:
        """Merge every tile in two passes, ``merge_tile`` then ``filter_tile`` (the filter reads
        its neighbours' first passes), and write ``fused/index.json``. ``run_tiles(kind, names,
        voxel, rule, keep, done)`` runs one pass (``kind`` ``merge`` or ``filter``) elsewhere,
        such as in worker processes, calling ``done(name, result)`` for each tile; by default the
        tiles run here. A merge at another spacing than the one in progress starts over.

        Once the chunks are marked dropped (``drop_chunks``, even part way through deleting them)
        nothing is merged again: a complete merge at ``voxel`` is answered as it is, and anything
        else raises ``ChunksDropped``, the tiles left alone."""
        if self.chunks_dropped():
            done = self.info()
            if done.get("complete") and self.merging_voxel() == voxel:
                return done
            raise ChunksDropped(
                "The fused chunks were already removed after an earlier merge, so this cloud "
                "cannot be merged again; start the processing again."
            )
        names = self.chunk_tiles()
        self.begin_merge(voxel)
        total = max(1, len(names))
        results: dict[str, dict] = {}
        for kind, offset, word in (("merge", 0, "Merging"), ("filter", total, "Cleaning")):
            count = [0]

            def done(name: str, res: dict, offset: int = offset, word: str = word, count=count) -> None:
                count[0] += 1
                results[name] = res
                progress((offset + count[0]) / (2 * total), f"{word} tile {count[0]} of {total}")

            if run_tiles is not None:
                run_tiles(kind, names, voxel, rule, keep, done)
                continue
            for name in names:
                check()
                if kind == "merge":
                    done(name, merge_tile(self, name, voxel, rule, keep))
                else:
                    done(name, filter_tile(self, name, voxel, rule))
        lo, hi = np.full(3, np.inf), np.full(3, -np.inf)
        counts: dict[str, int] = {}
        for name in names:
            r = results[name]
            counts[name] = int(r["n"])
            if r["n"]:
                lo, hi = np.minimum(lo, r["lo"]), np.maximum(hi, r["hi"])
        points = sum(counts.values())
        info = {
            "points": int(points),
            "tiles": len(names),
            "counts": counts,
            "voxel": voxel,
            "bounds": [lo.tolist(), hi.tolist()] if points else None,
            "rule": asdict(rule),
        }
        (self.root / "fused").mkdir(parents=True, exist_ok=True)
        atomic_write_json(self.root / "fused" / "index.json", info)
        shutil.rmtree(self.root / "collapsed", ignore_errors=True)
        return info

    def begin_merge(self, voxel: float, **state: Any) -> None:
        """Start, or carry on, a merge at ``voxel``: what a merge at another spacing left goes.
        ``state`` (such as the re-merge count) is kept beside the spacing (``merge_state``)."""
        mark = self.root / "merge.json"
        if mark.is_file() and json.loads(mark.read_text("utf-8")).get("voxel") == voxel:
            return
        for d in ("collapsed", "fused"):
            remove_tree(self.root / d)
        self.root.mkdir(parents=True, exist_ok=True)
        atomic_write_json(mark, {**state, "voxel": voxel})

    def merge_state(self) -> dict:
        """What ``begin_merge`` recorded for the merge in progress or done (``voxel`` and more)."""
        mark = self.root / "merge.json"
        return json.loads(mark.read_text("utf-8")) if mark.is_file() else {}

    def merging_voxel(self) -> float | None:
        """The spacing of the merge in progress or done, or None."""
        mark = self.root / "merge.json"
        return json.loads(mark.read_text("utf-8")).get("voxel") if mark.is_file() else None

    def fused(self) -> Iterator[tuple[str, dict[str, np.ndarray]]]:
        base = self.root / "fused"
        for p in sorted(base.glob("*.npz")) if base.is_dir() else []:
            if p.name.startswith("."):
                continue
            with np.load(p) as z:
                yield p.stem, {k: z[k] for k in z.files}

    def fused_in(self, x0: float, y0: float, x1: float, y1: float) -> dict[str, np.ndarray]:
        """Fused points inside a ground box (tiles that touch it are read, then clipped)."""
        kx0, ky0 = self.key(x0, y0)
        kx1, ky1 = self.key(x1, y1)
        parts: list[dict[str, np.ndarray]] = []
        for kx in range(kx0, kx1 + 1):
            for ky in range(ky0, ky1 + 1):
                p = self.root / "fused" / f"{kx}_{ky}.npz"
                if p.is_file():
                    with np.load(p) as z:
                        xyz = z["xyz"]
                        m = (xyz[:, 0] >= x0) & (xyz[:, 0] < x1) & (xyz[:, 1] >= y0) & (xyz[:, 1] < y1)
                        parts.append({k: z[k][m] for k in z.files})
        if not parts:
            return {
                "xyz": np.zeros((0, 3)),
                "rgb": np.zeros((0, 3), np.uint8),
                "normal": np.zeros((0, 3), np.float32),
                "count": np.zeros(0, np.int32),
            }
        return {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}

    def info(self) -> dict:
        p = self.root / "fused" / "index.json"
        return json.loads(p.read_text("utf-8")) if p.is_file() else {"points": 0, "bounds": None}

    def finish_merge(self, **extra: Any) -> dict:
        """Mark the merge complete (after any re-merge), with ``extra`` fields in the index:
        nothing will change the tiles now."""
        info = {**self.info(), **extra, "complete": True}
        atomic_write_json(self.root / "fused" / "index.json", info)
        return info

    def counts(self) -> list[int]:
        """Points per fused tile, as ``fused/index.json`` lists them."""
        return [int(n) for n in (self.info().get("counts") or {}).values()]

    def drop_chunks(self) -> int:
        """Delete the fusion chunks (after a complete merge, founder decision of 13 Oct 2026).
        Answers the bytes freed."""
        base = self.chunks_dir
        if not base.is_dir():
            return 0
        freed = sum(p.stat().st_size for p in base.rglob("*") if p.is_file())
        # marked first, so a cancel or a partial delete still reads as dropped
        atomic_write_json(self._dropped_mark(), {"bytes": freed})
        shutil.rmtree(base, ignore_errors=True)
        return freed

    def _dropped_mark(self) -> Path:
        """Beside the chunk folder, not in the merge folder: every merge key shares the chunks."""
        return self.chunks_dir.with_name(f"{self.chunks_dir.name}.dropped.json")

    def chunks_dropped(self) -> bool:
        """Whether ``drop_chunks`` deleted (or began deleting) the chunks."""
        return self._dropped_mark().is_file()

    def clear_chunks(self) -> None:
        """Before fusing again: what is left of the chunks goes, then the dropped mark (a chunk
        or fusion mark that cannot be deleted is refused, the mark kept)."""
        remove_tree(self.chunks_dir)
        self._dropped_mark().unlink(missing_ok=True)


def voxel_mean(
    xyz: np.ndarray, rgb: np.ndarray, nrm: np.ndarray, voxel: float
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Average points per voxel; returns positions, colours, unit normals and point counts."""
    if not len(xyz):
        return xyz, rgb, nrm, np.zeros(0, np.int32)
    base = np.floor(xyz.min(0) / voxel)
    q = np.floor(xyz / voxel) - base
    q = q.astype(np.int64)
    span = q.max(0) + 1
    key = (q[:, 0] * span[1] + q[:, 1]) * span[2] + q[:, 2]
    _, inv, cnt = np.unique(key, return_inverse=True, return_counts=True)
    n = len(cnt)

    def mean(a: np.ndarray) -> np.ndarray:
        return (
            np.stack([np.bincount(inv, weights=a[:, k], minlength=n) for k in range(a.shape[1])], 1)
            / cnt[:, None]
        )

    p = mean(xyz)
    c = np.clip(np.round(mean(rgb.astype(np.float64))), 0, 255).astype(np.uint8)
    nn = mean(np.nan_to_num(nrm.astype(np.float64)))
    ln = np.linalg.norm(nn, axis=1, keepdims=True)
    nn = np.where(ln > 1e-9, nn / np.maximum(ln, 1e-12), [0.0, 0.0, 1.0]).astype(np.float32)
    return p, c, nn, cnt.astype(np.int32)


# ------------------------------------------------------------------------------------- merge v2


def collapse_columns(
    xyz: np.ndarray, rgb: np.ndarray, nrm: np.ndarray, cnt: np.ndarray, voxel: float
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """One point per ``2 x voxel`` of height in each xy column of voxels: a column's points,
    sorted by height, split into clusters where they are more than ``2 x voxel`` apart (a roof
    over the ground); each cluster is averaged per ``2 x voxel`` from its lowest point, so a wall
    keeps its height and stacked noise layers merge. Weighted by the points each input holds."""
    if not len(xyz):
        return xyz, rgb, nrm, cnt
    step = 2.0 * voxel
    q = np.floor(xyz[:, :2] / voxel).astype(np.int64)
    q -= q.min(0)
    col = q[:, 0] * (int(q[:, 1].max()) + 1) + q[:, 1]
    order = np.lexsort((xyz[:, 2], col))
    xyz, rgb, nrm, cnt, col = xyz[order], rgb[order], nrm[order], cnt[order], col[order]
    z = xyz[:, 2]
    new_cluster = np.r_[True, (col[1:] != col[:-1]) | (np.diff(z) > step)]
    cluster = np.cumsum(new_cluster) - 1
    sub = np.floor((z - z[new_cluster][cluster]) / step).astype(np.int64)
    new_bin = new_cluster | np.r_[True, sub[1:] != sub[:-1]]
    b = np.cumsum(new_bin) - 1
    nb = int(b[-1]) + 1
    w = cnt.astype(np.float64)
    tot = np.bincount(b, weights=w, minlength=nb)

    def mean(a: np.ndarray) -> np.ndarray:
        cols = [np.bincount(b, weights=a[:, k] * w, minlength=nb) for k in range(a.shape[1])]
        return np.stack(cols, 1) / tot[:, None]

    p = mean(xyz)
    c = np.clip(np.round(mean(rgb.astype(np.float64))), 0, 255).astype(np.uint8)
    nn = mean(np.nan_to_num(nrm.astype(np.float64)))
    ln = np.linalg.norm(nn, axis=1, keepdims=True)
    nn = np.where(ln > 1e-9, nn / np.maximum(ln, 1e-12), [0.0, 0.0, 1.0]).astype(np.float32)
    return p, c, nn, tot.astype(np.int32)


#: Points the outlier filter asks the KD-tree about at once: the answer holds ``k + 1`` distances
#: (float64) and indices (int64) a point, 272 MB a block at ``k = 16`` (``pool.MERGE_FILTER_BYTES``).
OUTLIER_BLOCK = 1_000_000


def outlier_mask(
    pts: np.ndarray, margin: np.ndarray, k: int = 16, sigma: float = 2.5, block: int = OUTLIER_BLOCK
) -> np.ndarray:
    """True for the points of ``pts`` to keep: those whose mean distance to their ``k`` nearest
    neighbours (among ``pts`` and ``margin``) is at most the mean over ``pts`` plus ``sigma``
    standard deviations. With ``k`` points or fewer everything is kept. The neighbours are asked
    for ``block`` points at a time, so the working memory stays bounded whatever the tile."""
    from scipy.spatial import cKDTree

    allp = np.concatenate([pts, margin]) if len(margin) else pts
    if len(allp) <= k:
        return np.ones(len(pts), bool)
    tree = cKDTree(allp)
    m = np.empty(len(pts))
    step = max(1, int(block))
    for a in range(0, len(pts), step):
        d, _ = tree.query(pts[a : a + step], k=k + 1)
        m[a : a + step] = d[:, 1:].mean(1)
    return m <= m.mean() + sigma * m.std()


def _tile_result(xyz: np.ndarray) -> dict:
    if not len(xyz):
        return {"n": 0, "lo": None, "hi": None}
    return {"n": len(xyz), "lo": xyz.min(0).tolist(), "hi": xyz.max(0).tolist()}


def _save_tile(dst: Path, **arrays: np.ndarray) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(f".{dst.stem}.tmp.npz")
    np.savez(tmp, **arrays)
    replace_over(tmp, dst)


def _xyz_of(path: Path) -> np.ndarray:
    with np.load(path) as z:
        return z["xyz"]


def merge_tile(
    store: PointTiles,
    name: str,
    voxel: float,
    rule: MergeRule,
    keep: Callable[[np.ndarray], np.ndarray] | None = None,
) -> dict:
    """First pass for one tile: its chunks, clipped by ``keep``, averaged per voxel, the columns
    collapsed (with ``rule.collapse``), then the points seen fewer than ``rule.min_count`` times
    dropped, counted per collapsed bin (the raw points summed over its voxels); into ``collapsed/<tile>.npz``. A tile whose first or second pass is on
    disk is not done again."""
    dst = store.root / "collapsed" / f"{name}.npz"
    for done in (dst, store.root / "fused" / f"{name}.npz"):
        if done.exists():
            return _tile_result(_xyz_of(done))
    parts = []
    for p in sorted((store.chunks_dir / name).glob("*.npz")):
        if p.name.startswith("."):
            continue
        with np.load(p) as f:
            parts.append(unpack_chunk(f))
    if parts:
        xyz = np.concatenate([a for a, _, _ in parts])
        rgb = np.concatenate([c for _, c, _ in parts])
        nrm = np.concatenate([n for _, _, n in parts])
    else:
        xyz, rgb, nrm = np.zeros((0, 3)), np.zeros((0, 3), np.uint8), np.zeros((0, 3), np.float32)
    if keep is not None and len(xyz):
        m = keep(xyz)
        xyz, rgb, nrm = xyz[m], rgb[m], nrm[m]
    p, c, n, cnt = voxel_mean(xyz, rgb, nrm, voxel)
    if rule.collapse:
        p, c, n, cnt = collapse_columns(p, c, n, cnt, voxel)
    ok = cnt >= rule.min_count
    p, c, n, cnt = p[ok], c[ok], n[ok], cnt[ok]
    _save_tile(dst, xyz=p, rgb=c, normal=n, count=cnt)
    return _tile_result(p)


def _margin(store: PointTiles, name: str, voxel: float) -> np.ndarray:
    """The first-pass points of the eight neighbouring tiles within one voxel of this tile."""
    tx, ty = (int(v) for v in name.split("_"))
    x0, y0 = tx * store.tile - voxel, ty * store.tile - voxel
    x1, y1 = (tx + 1) * store.tile + voxel, (ty + 1) * store.tile + voxel
    out = []
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            p = store.root / "collapsed" / f"{tx + dx}_{ty + dy}.npz"
            if (dx or dy) and p.is_file():
                q = _xyz_of(p)
                m = (q[:, 0] >= x0) & (q[:, 0] < x1) & (q[:, 1] >= y0) & (q[:, 1] < y1)
                out.append(q[m])
    return np.concatenate(out) if out else np.zeros((0, 3))


def filter_tile(store: PointTiles, name: str, voxel: float, rule: MergeRule) -> dict:
    """Second pass for one tile: the outlier filter over the tile and a one-voxel margin of its
    neighbours' first-pass points; into ``fused/<tile>.npz``."""
    dst = store.root / "fused" / f"{name}.npz"
    if dst.exists():
        return _tile_result(_xyz_of(dst))
    with np.load(store.root / "collapsed" / f"{name}.npz") as z:
        d = {k: z[k] for k in z.files}
    if rule.outliers and len(d["xyz"]):
        keep = outlier_mask(d["xyz"], _margin(store, name, voxel), rule.k, rule.sigma)
        d = {k: v[keep] for k, v in d.items()}
    _save_tile(dst, **d)
    return _tile_result(d["xyz"])
