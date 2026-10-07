"""CPU dense matching: one depth map per photo from semi-global matching on rectified pairs.

The G3 spike (plan "CPU dense matching", recorded in ``report/products.json`` ``engines``) chose
semi-global matching (SGM, Hirschmueller 2008) over MVE ``dmrecon``: on nadir grids it matches the
accuracy targets at a fraction of the time, it needs no native build, and it is our own code. Per
reference photo:

1. **Pairs.** Up to ``neighbours`` partners with a useful baseline (5% to 60% of the viewing
   distance), similar viewing directions (under 30 degrees apart) and the most shared sparse points.
2. **Rectification** (Fusiello, Trucco and Verri 2000): both photos are re-sampled, lens
   distortion removed, onto image planes that share a rotation whose x axis is the baseline, so
   matching runs along rows. The disparity range comes from the sparse points both photos see.
3. **Matching.** A 5 x 5 census cost with the Hamming distance, aggregated along 8 paths with the
   SGM penalties ``P1`` and ``P2``; winner takes all with a sub-pixel parabola, a uniqueness test,
   a left-right check and removal of small speckles. ``OpenCvSgbm`` (``cv2.StereoSGBM`` 3-way) does
   the same when the pack's own OpenCV build is installed (G1); ``NumpySgm`` is the pure-numpy
   matcher, always available. Large photos are matched in row bands that fit the memory budget.
4. **Depth map.** Every matched pixel becomes a world point; the points of all pairs are projected
   back into the reference photo (z-buffer), and pixels where the pairs disagree are dropped.

``fuse.py`` then keeps the points that other photos confirm (geometric consistency).
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol

import numpy as np

from .scene import Camera, SparseModel, View

MAX_DISPARITIES = 320
CENSUS = 5


@dataclass(frozen=True)
class DenseSettings:
    #: Photos are matched at this fraction of their size (preset: standard 0.5, high 1.0).
    scale: float = 0.5
    neighbours: int = 2
    p1: int = 2
    p2: int = 20
    #: Percent: the best cost must beat the second best (not adjacent) by this much.
    uniqueness: int = 8
    #: Smallest speckle kept, pixels at the matching size.
    speckle: int = 40
    #: Pairs disagreeing by more than this fraction of the depth are dropped.
    agree: float = 0.015


# ------------------------------------------------------------------------------------- pairs


def visible_points(model: SparseModel, view: View) -> np.ndarray:
    """Indices of the sparse points the view sees (by track, else by projection)."""
    if model.tracks and any(model.tracks):
        return np.array([i for i, t in enumerate(model.tracks) if view.id in t], dtype=np.int64)
    if not len(model.points):
        return np.zeros(0, np.int64)
    x, y, z = view.project(model.points)
    cam = view.camera
    ok = (z > 0) & (x >= 0) & (y >= 0) & (x < cam.width) & (y < cam.height)
    return np.nonzero(ok)[0]


def select_pairs(model: SparseModel, neighbours: int) -> dict[int, list[int]]:
    """For each view id, the ids of its best matching partners (best first)."""
    seen = {v.id: set(visible_points(model, v).tolist()) for v in model.views}
    out: dict[int, list[int]] = {}
    for v in model.views:
        pts = list(seen[v.id])
        depth = float(np.median(v.to_cam(model.points[pts])[:, 2])) if pts else 0.0
        scored: list[tuple[float, int]] = []
        for w in model.views:
            if w.id == v.id:
                continue
            b = float(np.linalg.norm(w.centre - v.centre))
            if depth <= 0 or b <= 0:
                continue
            ratio = b / depth
            angle = math.degrees(math.acos(float(np.clip(np.dot(v.axis, w.axis), -1, 1))))
            if not (0.05 <= ratio <= 0.6) or angle > 30:
                continue
            shared = len(seen[v.id] & seen[w.id]) / max(1, len(seen[v.id]))
            if shared < 0.2:
                continue
            # prefer a baseline near a quarter of the depth: precise but still overlapping
            score = shared * math.exp(-(((ratio - 0.25) / 0.2) ** 2))
            scored.append((score, w.id))
        scored.sort(reverse=True)
        out[v.id] = [wid for _, wid in scored[:neighbours]]
    return out


# ----------------------------------------------------------------------------- rectification


@dataclass
class RectifiedPair:
    left: View
    right: View
    cam_l: Camera  # the photos' cameras at the matching size
    cam_r: Camera
    r: np.ndarray  # world to rectified, shared by both
    f: float
    cx: float
    cy: float
    width: int
    height: int
    baseline: float

    @classmethod
    def make(cls, left: View, right: View, scale: float, max_side: int = 6000) -> RectifiedPair:
        cam_l, cam_r = left.camera.scaled(scale), right.camera.scaled(scale)
        c1, c2 = left.centre, right.centre
        x = c2 - c1
        baseline = float(np.linalg.norm(x))
        x = x / baseline
        y = np.cross(left.axis, x)
        y /= np.linalg.norm(y)
        z = np.cross(x, y)
        r = np.stack([x, y, z])
        f = float((cam_l.fx + cam_l.fy + cam_r.fx + cam_r.fy) / 4)
        # the left photo's outline (with its lens) on the new image plane sets the window
        w, h = cam_l.width, cam_l.height
        t = np.linspace(0, 1, 33)
        edge = np.concatenate(
            [
                np.stack([t * w, np.zeros_like(t)], 1),
                np.stack([t * w, np.full_like(t, h)], 1),
                np.stack([np.zeros_like(t), t * h], 1),
                np.stack([np.full_like(t, w), t * h], 1),
            ]
        )
        rays = cam_l.rays(edge[:, 0], edge[:, 1]) @ left.r  # camera rays to world directions
        rr = rays @ r.T
        good = rr[:, 2] > 1e-6
        u, v = rr[good, 0] / rr[good, 2], rr[good, 1] / rr[good, 2]
        u0, u1, v0, v1 = u.min(), u.max(), v.min(), v.max()
        width, height = math.ceil(f * (u1 - u0)), math.ceil(f * (v1 - v0))
        side = max(width, height)
        if side > max_side:
            f *= max_side / side
            width, height = math.ceil(f * (u1 - u0)), math.ceil(f * (v1 - v0))
        return cls(left, right, cam_l, cam_r, r, f, -f * u0, -f * v0, width, height, baseline)

    def _maps(self, view: View, cam: Camera) -> tuple[np.ndarray, np.ndarray]:
        ys, xs = np.mgrid[0 : self.height, 0 : self.width].astype(np.float64)
        d = np.stack([(xs + 0.5 - self.cx) / self.f, (ys + 0.5 - self.cy) / self.f, np.ones_like(xs)], -1)
        dc = d.reshape(-1, 3) @ self.r @ view.r.T  # rectified ray -> world -> camera
        px, py, z = cam.project_cam(dc)
        px[z <= 0] = -1e9
        return px.reshape(self.height, self.width), py.reshape(self.height, self.width)

    def warp(self, img: np.ndarray, view: View, cam: Camera) -> tuple[np.ndarray, np.ndarray]:
        """The photo (grey, matching size) on the rectified plane, and where it is valid."""
        from scipy import ndimage

        px, py = self._maps(view, cam)
        valid = (px >= 0) & (py >= 0) & (px <= cam.width) & (py <= cam.height)
        out = ndimage.map_coordinates(
            img.astype(np.float32), [py - 0.5, px - 0.5], order=1, mode="nearest"
        ).astype(np.float32)
        out[~valid] = 0
        return out, valid

    def disparity_range(self, points: np.ndarray, margin: float = 0.15) -> tuple[int, int] | None:
        """[dmin, dmax] pixels from sparse points in front of both cameras, or None."""
        if not len(points):
            return None
        z = (points - self.left.centre) @ self.r[2]
        z = z[z > 0]
        if len(z) < 5:
            return None
        lo, hi = np.percentile(z, [1, 99])
        dmin = self.f * self.baseline / (hi * (1 + margin))
        dmax = self.f * self.baseline / (lo * (1 - margin))
        return max(0, math.floor(dmin)), math.ceil(dmax)

    def to_world(self, x: np.ndarray, y: np.ndarray, d: np.ndarray) -> np.ndarray:
        """Rectified left pixels (x, y) with disparity d to world points."""
        z = self.f * self.baseline / d
        pc = np.stack([(x + 0.5 - self.cx) * z / self.f, (y + 0.5 - self.cy) * z / self.f, z], -1)
        return self.left.centre + pc.reshape(-1, 3) @ self.r


# ------------------------------------------------------------------------------------- matchers


class Matcher(Protocol):
    name: str

    def match(
        self,
        left: np.ndarray,
        right: np.ndarray,
        valid_l: np.ndarray,
        valid_r: np.ndarray,
        dmin: int,
        ndisp: int,
        check: Callable[[], None],
    ) -> np.ndarray:
        """Disparity (float32, absolute pixels) of the left image; NaN where unmatched."""
        ...


def census(img: np.ndarray, valid: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """5 x 5 census bits (uint32) and where the full window is inside the valid area."""
    from scipy import ndimage

    h, w = img.shape
    r = CENSUS // 2
    pad = np.pad(img, r, mode="edge")
    out = np.zeros((h, w), np.uint32)
    bit = 0
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            if dy == 0 and dx == 0:
                continue
            nb = pad[r + dy : r + dy + h, r + dx : r + dx + w]
            out |= (nb < img).astype(np.uint32) << np.uint32(bit)
            bit += 1
    ok = ndimage.binary_erosion(valid, structure=np.ones((CENSUS, CENSUS), bool), border_value=0)
    return out, ok


def cost_volume(
    cl: np.ndarray, cr: np.ndarray, okl: np.ndarray, okr: np.ndarray, dmin: int, nd: int
) -> np.ndarray:
    """Hamming cost (uint8, 0..24; 24 where a disparity leaves the right image) of shape (h, w, nd)."""
    h, w = cl.shape
    bad = np.uint8(CENSUS * CENSUS - 1)
    c = np.full((h, w, nd), bad, np.uint8)
    for k in range(nd):
        d = dmin + k
        if d >= w:
            break
        a, b = cl[:, d:], cr[:, : w - d]
        ham = np.bitwise_count(a ^ b).astype(np.uint8)
        ok = okl[:, d:] & okr[:, : w - d]
        c[:, d:, k] = np.where(ok, ham, bad)
    return c


def _step(prev: np.ndarray, cost: np.ndarray, p1: int, p2: int) -> np.ndarray:
    m = prev.min(axis=-1, keepdims=True)
    cand = np.minimum(prev, m + p2)
    cand[..., 1:] = np.minimum(cand[..., 1:], prev[..., :-1] + p1)
    cand[..., :-1] = np.minimum(cand[..., :-1], prev[..., 1:] + p1)
    return cost + cand - m


def aggregate(
    c: np.ndarray, p1: int, p2: int, paths: int = 8, check: Callable[[], None] = lambda: None
) -> np.ndarray:
    """Sum of the SGM path costs (uint16), shape of ``c``."""
    h, w, _ = c.shape
    cost = c.astype(np.int32)
    s = np.zeros(c.shape, np.uint32)
    # along rows, both ways
    for xs in (range(w), range(w - 1, -1, -1)):
        prev = None
        for x in xs:
            cur = cost[:, x] if prev is None else _step(prev, cost[:, x], p1, p2)
            s[:, x] += cur.astype(np.uint32)
            prev = cur
        check()
    # along columns and diagonals, row by row
    shifts = [0] if paths < 8 else [0, 1, -1]
    for ys in (range(h), range(h - 1, -1, -1)):
        for sh in shifts:
            prev = None
            for y in ys:
                if prev is None:
                    cur = cost[y]
                else:
                    if sh == 0:
                        p = prev
                    else:
                        p = np.empty_like(prev)
                        if sh > 0:  # the predecessor is one column to the left
                            p[1:], p[0] = prev[:-1], prev[0]
                        else:
                            p[:-1], p[-1] = prev[1:], prev[-1]
                    cur = _step(p, cost[y], p1, p2)
                s[y] += cur.astype(np.uint32)
                prev = cur
            check()
    return s


def remove_speckles(d: np.ndarray, min_size: int, max_diff: float = 1.0) -> np.ndarray:
    """Drop connected regions smaller than ``min_size`` pixels, where neighbours belong to one
    region when their disparities differ by at most ``max_diff`` (OpenCV's speckle filter)."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components

    ok = np.isfinite(d)
    if min_size <= 1 or not ok.any():
        return d
    h, w = d.shape
    idx = np.arange(h * w).reshape(h, w)
    dd = np.where(ok, d, 0)
    pairs = []
    for a, b, da, db, oa, ob in (
        (idx[:, :-1], idx[:, 1:], dd[:, :-1], dd[:, 1:], ok[:, :-1], ok[:, 1:]),
        (idx[:-1, :], idx[1:, :], dd[:-1, :], dd[1:, :], ok[:-1, :], ok[1:, :]),
    ):
        m = oa & ob & (np.abs(da - db) <= max_diff)
        pairs.append((a[m], b[m]))
    rows = np.concatenate([p[0] for p in pairs])
    cols = np.concatenate([p[1] for p in pairs])
    g = coo_matrix((np.ones(len(rows), np.int8), (rows, cols)), shape=(h * w, h * w))
    _, lab = connected_components(g, directed=False)
    sizes = np.bincount(lab)
    out = d.copy()
    out[(sizes[lab] < min_size).reshape(h, w)] = np.nan
    return out


def select_disparity(s: np.ndarray, dmin: int, uniqueness: int, speckle: int) -> np.ndarray:
    """Winner takes all with sub-pixel refinement, uniqueness and left-right checks, speckles off."""
    h, w, nd = s.shape
    best = np.argmin(s, axis=2)
    yy, xx = np.mgrid[0:h, 0:w]
    c0 = s[yy, xx, best].astype(np.float64)
    # second best away from the minimum's neighbours (in place on a uint32 copy)
    masked = s.copy()
    top = np.iinfo(np.uint32).max
    for off in (-1, 0, 1):
        masked[yy, xx, np.clip(best + off, 0, nd - 1)] = top
    c2 = masked.min(axis=2).astype(np.float64)
    del masked
    unique = c0 * 100 < c2 * (100 - uniqueness)
    km, kp = np.clip(best - 1, 0, nd - 1), np.clip(best + 1, 0, nd - 1)
    cm, cp = s[yy, xx, km].astype(np.float64), s[yy, xx, kp].astype(np.float64)
    den = cm - 2 * c0 + cp
    with np.errstate(divide="ignore", invalid="ignore"):
        sub = np.where((best > 0) & (best < nd - 1) & (den > 0), (cm - cp) / (2 * den), 0.0)
    d = (dmin + best + sub).astype(np.float32)
    # the right image's own winners: right pixel xr at disparity k is left pixel xr + dmin + k
    best_r = np.zeros((h, w), np.int64)
    cost_r = np.full((h, w), top, np.uint32)
    for k in range(nd):
        shift = dmin + k
        if shift >= w:
            break
        col = s[:, shift:, k]
        better = col < cost_r[:, : w - shift]
        cost_r[:, : w - shift] = np.where(better, col, cost_r[:, : w - shift])
        best_r[:, : w - shift] = np.where(better, shift, best_r[:, : w - shift])
    xm = np.round(np.arange(w)[None, :] - d).astype(np.int64)
    okx = (xm >= 0) & (xm < w)
    back = np.where(okx, best_r[yy, np.clip(xm, 0, w - 1)], -9999)
    lr = np.abs(back - d) <= 1.0
    edge = (best == 0) | (best == nd - 1)
    d[~(unique & lr & okx) | edge] = np.nan
    return remove_speckles(d, speckle)


class NumpySgm:
    """Semi-global matching in numpy (census cost, 8 paths), matched in row bands within memory."""

    name = "sgm-numpy"

    def __init__(self, settings: DenseSettings, budget: int):
        self.s = settings
        self.budget = budget

    def match(self, left, right, valid_l, valid_r, dmin, ndisp, check):
        h, w = left.shape
        cl, okl = census(left, valid_l)
        cr, okr = census(right, valid_r)
        # cost (1) + int32 working copy (4) + sums (4) + selection temporaries (~16) bytes per cell
        per_row = w * ndisp * 26
        band = max(32, int(self.budget // max(1, per_row)))
        overlap = 24
        out = np.full((h, w), np.nan, np.float32)
        y = 0
        while y < h:
            check()
            y0 = max(0, y - overlap)
            y1 = min(h, y + band + overlap)
            c = cost_volume(cl[y0:y1], cr[y0:y1], okl[y0:y1], okr[y0:y1], dmin, ndisp)
            s = aggregate(c, self.s.p1, self.s.p2, 8, check)
            del c
            d = select_disparity(s, dmin, self.s.uniqueness, self.s.speckle)
            del s
            keep0 = y - y0
            keep1 = min(h, y + band) - y0
            out[y : y + keep1 - keep0] = d[keep0:keep1]
            y += band
        return out


class OpenCvSgbm:
    """``cv2.StereoSGBM`` (3-way) with the same penalties, from the pack's own OpenCV build (G1)."""

    name = "sgm-opencv"

    def __init__(self, settings: DenseSettings):
        import cv2  # noqa: F401 - checked by available()

        self.s = settings

    @staticmethod
    def available() -> bool:
        try:
            import cv2  # noqa: F401
        except ImportError:
            return False
        return True

    def match(self, left, right, valid_l, valid_r, dmin, ndisp, check):
        import cv2

        nd = int(math.ceil(ndisp / 16) * 16)
        block = 5
        sgbm = cv2.StereoSGBM_create(
            minDisparity=int(dmin),
            numDisparities=nd,
            blockSize=block,
            P1=8 * block * block,
            P2=32 * block * block,
            disp12MaxDiff=1,
            uniquenessRatio=self.s.uniqueness,
            speckleWindowSize=self.s.speckle,
            speckleRange=2,
            mode=cv2.STEREO_SGBM_MODE_SGBM_3WAY,
        )
        a = np.clip(left, 0, 255).astype(np.uint8)
        b = np.clip(right, 0, 255).astype(np.uint8)
        check()
        disp = sgbm.compute(a, b).astype(np.float32) / 16.0
        disp[disp < dmin] = np.nan
        disp[~valid_l] = np.nan
        return disp


def make_matcher(settings: DenseSettings, budget: int, prefer: str = "auto") -> Matcher:
    if prefer in ("auto", "opencv") and OpenCvSgbm.available():
        return OpenCvSgbm(settings)
    return NumpySgm(settings, budget)


# ----------------------------------------------------------------------------------- depth maps


def zbuffer(cam: Camera, view: View, pts: np.ndarray) -> np.ndarray:
    """Depth (float32, NaN empty) of world points seen by ``view`` through ``cam``, nearest wins."""
    depth = np.full(cam.height * cam.width, np.inf, np.float64)
    if len(pts):
        x, y, z = view.project(pts, cam)
        ok = (z > 0) & (x >= 0) & (y >= 0) & (x < cam.width) & (y < cam.height)
        idx = np.floor(y[ok]).astype(np.int64) * cam.width + np.floor(x[ok]).astype(np.int64)
        np.minimum.at(depth, idx, z[ok])
    depth[np.isinf(depth)] = np.nan
    return depth.reshape(cam.height, cam.width).astype(np.float32)


def fill_pinholes(d: np.ndarray) -> np.ndarray:
    """Fill single empty pixels whose neighbours (at least 5 of 8) agree, with their median."""
    h, w = d.shape
    pad = np.pad(d, 1, constant_values=np.nan)
    stack = np.stack(
        [pad[1 + dy : 1 + dy + h, 1 + dx : 1 + dx + w] for dy in (-1, 0, 1) for dx in (-1, 0, 1) if dy or dx]
    )
    n = np.isfinite(stack).sum(0)
    with np.errstate(all="ignore"):
        import warnings

        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            med = np.nanmedian(stack, axis=0)
            spread = np.nanmax(stack, axis=0) - np.nanmin(stack, axis=0)
    hole = ~np.isfinite(d) & (n >= 5) & (spread < 0.02 * med)
    out = d.copy()
    out[hole] = med[hole]
    return out


def depth_map(
    ref: View,
    partners: list[View],
    images: Callable[[View], np.ndarray],
    model: SparseModel,
    matcher: Matcher,
    settings: DenseSettings,
    check: Callable[[], None],
) -> tuple[np.ndarray, dict]:
    """Depth map of ``ref`` (float32 metres along its axis, NaN empty) at the matching size."""
    cam = ref.camera.scaled(settings.scale)
    maps: list[np.ndarray] = []
    info: dict = {"pairs": []}
    pts_ref = model.points[visible_points(model, ref)]
    for other in partners:
        check()
        pair = RectifiedPair.make(ref, other, settings.scale)
        rng = pair.disparity_range(pts_ref)
        if rng is None:
            continue
        dmin, dmax = rng
        nd = min(MAX_DISPARITIES, dmax - dmin + 1)
        left, vl = pair.warp(images(ref), ref, pair.cam_l)
        right, vr = pair.warp(images(other), other, pair.cam_r)
        disp = matcher.match(left, right, vl, vr, dmin, nd, check)
        ys, xs = np.nonzero(np.isfinite(disp) & (disp > 0))
        pts = pair.to_world(xs.astype(np.float64), ys.astype(np.float64), disp[ys, xs].astype(np.float64))
        maps.append(zbuffer(cam, ref, pts))
        info["pairs"].append(
            {"with": other.id, "disparities": [int(dmin), int(dmin + nd - 1)], "matched": len(xs)}
        )
    if not maps:
        return np.full((cam.height, cam.width), np.nan, np.float32), info
    if len(maps) == 1:
        d = maps[0]
    else:
        import warnings

        stack = np.stack(maps)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            d = np.nanmedian(stack, axis=0)
            spread = np.nanmax(stack, axis=0) - np.nanmin(stack, axis=0)
        d[spread > settings.agree * d] = np.nan
    return fill_pinholes(d.astype(np.float32)), info
