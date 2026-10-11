"""The array code around the matcher, written once for numpy and for the graphics card.

A depth map spends most of its time not in the matcher but in our own array code: rectifying the
two photos, turning disparities back into depths, and merging the pairs. Fusion is the same kind
of code. This module is that code written against an array library (``Backend``): numpy on the
CPU, CuPy on an NVIDIA card when the GPU add-on is loaded (``aio_pipelines.accel``). The matcher
itself stays the CPU matcher of ``dense.py``, so a depth map made here differs from one made by
``dense.depth_map`` only by rounding.

Two rules keep it runnable on the card with the lean runtime: no matrix products (they would
need cuBLAS; ``mul3`` writes the 3 x 3 products out), and work in row bands so a card with little
free memory still holds it. ``dense.py`` and ``fuse.py`` remain the reference: the tests run this
module on numpy against them, and on the card against numpy where there is one.
"""

from __future__ import annotations

import warnings
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import numpy as np

from . import dense as D
from .fuse import FuseSettings
from .scene import Camera, SparseModel, View

#: Rows worked on at a time; at 20 MP that is about 0.3 GB of working arrays per band.
ROWS = 512
#: Points turned back into depths at a time.
POINTS = 4_000_000


@dataclass(frozen=True)
class Backend:
    """An array library and the few calls that are spelt differently between numpy and CuPy."""

    name: str  # "cpu" or "gpu"
    xp: Any
    ndimage: Any
    scatter_min: Callable[[Any, Any, Any], None]
    to_host: Callable[[Any], np.ndarray]
    #: Give memory the library holds back to the card (nothing to do on the CPU).
    release: Callable[[], None]


def numpy_backend() -> Backend:
    from scipy import ndimage

    return Backend("cpu", np, ndimage, np.minimum.at, np.asarray, lambda: None)


def cupy_backend() -> Backend:
    """CuPy on the first NVIDIA card. Call ``accel.activate`` first; raises what CuPy raises."""
    import cupy as cp  # type: ignore[import-not-found]
    from cupyx.scipy import ndimage  # type: ignore[import-not-found]

    pool = cp.get_default_memory_pool()
    return Backend("gpu", cp, ndimage, cp.minimum.at, cp.asnumpy, pool.free_all_blocks)


def mul3(a0: Any, a1: Any, a2: Any, m: np.ndarray) -> tuple[Any, Any, Any]:
    """Row vectors (a0, a1, a2) times the 3 x 3 host matrix ``m``, written out."""
    return (
        a0 * m[0, 0] + a1 * m[1, 0] + a2 * m[2, 0],
        a0 * m[0, 1] + a1 * m[1, 1] + a2 * m[2, 1],
        a0 * m[0, 2] + a1 * m[1, 2] + a2 * m[2, 2],
    )


def to_cam(b: Backend, view: View, x: Any, y: Any, z: Any) -> Any:
    """World coordinates to the view's camera frame, shape (n, 3)."""
    c0, c1, c2 = mul3(x, y, z, view.r.T)
    return b.xp.stack([c0 + view.t[0], c1 + view.t[1], c2 + view.t[2]], 1)


# ------------------------------------------------------------------------------- depth maps


def _maps(b: Backend, pair: D.RectifiedPair, view: View, cam: Camera, y0: int, y1: int) -> tuple[Any, Any]:
    """``RectifiedPair._maps`` for rows y0 to y1: where each rectified pixel lies in the photo."""
    xp = b.xp
    ys, xs = xp.mgrid[y0:y1, 0 : pair.width].astype(xp.float64)
    dx = (xs + 0.5 - pair.cx) / pair.f
    dy = (ys + 0.5 - pair.cy) / pair.f
    w0, w1, w2 = mul3(dx, dy, xp.ones_like(dx), pair.r)
    c0, c1, c2 = mul3(w0, w1, w2, view.r.T)
    px, py, z = cam.project_cam(xp.stack([c0.ravel(), c1.ravel(), c2.ravel()], 1))
    px[z <= 0] = -1e9
    return px.reshape(y1 - y0, pair.width), py.reshape(y1 - y0, pair.width)


def warp(b: Backend, pair: D.RectifiedPair, img: Any, view: View, cam: Camera) -> tuple[Any, Any]:
    """``RectifiedPair.warp``: the photo on the rectified plane and where it is valid."""
    xp = b.xp
    out = xp.empty((pair.height, pair.width), xp.float32)
    valid = xp.empty((pair.height, pair.width), bool)
    for y0 in range(0, pair.height, ROWS):
        y1 = min(pair.height, y0 + ROWS)
        px, py = _maps(b, pair, view, cam, y0, y1)
        v = (px >= 0) & (py >= 0) & (px <= cam.width) & (py <= cam.height)
        o = b.ndimage.map_coordinates(img, xp.stack([py - 0.5, px - 0.5]), order=1, mode="nearest")
        o = o.astype(xp.float32)
        o[~v] = 0
        out[y0:y1], valid[y0:y1] = o, v
    return out, valid


def depth_of_pair(b: Backend, pair: D.RectifiedPair, cam: Camera, view: View, disp: Any) -> tuple[Any, int]:
    """``RectifiedPair.to_world`` then ``dense.zbuffer``: one pair's disparities as a depth map of
    ``view`` (float32, NaN empty), and how many pixels were matched."""
    xp = b.xp
    depth = xp.full(cam.height * cam.width, xp.inf, xp.float64)
    ys, xs = xp.nonzero(xp.isfinite(disp) & (disp > 0))
    n = int(ys.size)
    centre = pair.left.centre
    for a in range(0, n, POINTS):
        ya, xa = ys[a : a + POINTS], xs[a : a + POINTS]
        d = disp[ya, xa].astype(xp.float64)
        z = pair.f * pair.baseline / d
        w0, w1, w2 = mul3(
            (xa.astype(xp.float64) + 0.5 - pair.cx) * z / pair.f,
            (ya.astype(xp.float64) + 0.5 - pair.cy) * z / pair.f,
            z,
            pair.r,
        )
        px, py, pz = cam.project_cam(to_cam(b, view, w0 + centre[0], w1 + centre[1], w2 + centre[2]))
        ok = (pz > 0) & (px >= 0) & (py >= 0) & (px < cam.width) & (py < cam.height)
        idx = xp.floor(py[ok]).astype(xp.int64) * cam.width + xp.floor(px[ok]).astype(xp.int64)
        b.scatter_min(depth, idx, pz[ok])
    depth[xp.isinf(depth)] = xp.nan
    return depth.reshape(cam.height, cam.width).astype(xp.float32), n


def fill_pinholes(b: Backend, d: Any) -> Any:
    """``dense.fill_pinholes`` in row bands."""
    xp = b.xp
    h, w = d.shape
    pad = xp.pad(d, 1, constant_values=xp.nan)
    out = d.copy()
    for y0 in range(0, h, ROWS):
        n = min(h, y0 + ROWS) - y0
        stack = xp.stack(
            [
                pad[1 + y0 + dy : 1 + y0 + dy + n, 1 + dx : 1 + dx + w]
                for dy in (-1, 0, 1)
                for dx in (-1, 0, 1)
                if dy or dx
            ]
        )
        count = xp.isfinite(stack).sum(0)
        med = xp.nanmedian(stack, axis=0)
        spread = xp.nanmax(stack, axis=0) - xp.nanmin(stack, axis=0)
        hole = ~xp.isfinite(d[y0 : y0 + n]) & (count >= 5) & (spread < 0.02 * med)
        o = out[y0 : y0 + n]
        o[hole] = med[hole]
    return out


def depth_map(
    b: Backend,
    ref: View,
    partners: list[View],
    images: Callable[[View], np.ndarray],
    model: SparseModel,
    matcher: D.Matcher,
    settings: D.DenseSettings,
    check: Callable[[], None],
) -> tuple[np.ndarray, dict]:
    """``dense.depth_map`` with the array code on ``b`` and the matcher on the CPU."""
    xp = b.xp
    cam = ref.camera.scaled(settings.scale)
    maps: list[Any] = []
    info: dict = {"pairs": []}
    pts_ref = model.points[D.visible_points(model, ref)]
    for other in partners:
        check()
        pair = D.RectifiedPair.make(ref, other, settings.scale)
        rng = pair.disparity_range(pts_ref)
        if rng is None:
            continue
        dmin, dmax = rng
        nd = min(D.MAX_DISPARITIES, dmax - dmin + 1)
        left, vl = warp(b, pair, xp.asarray(images(ref)), ref, pair.cam_l)
        right, vr = warp(b, pair, xp.asarray(images(other)), other, pair.cam_r)
        host = [b.to_host(a) for a in (left, right, vl, vr)]
        del left, right, vl, vr
        disp = matcher.match(*host, dmin, nd, check)
        z, n = depth_of_pair(b, pair, cam, ref, xp.asarray(disp))
        maps.append(z)
        info["pairs"].append({"with": other.id, "disparities": [int(dmin), int(dmin + nd - 1)], "matched": n})
    if not maps:
        return np.full((cam.height, cam.width), np.nan, np.float32), info
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        if len(maps) == 1:
            d = maps[0]
        else:
            stack = xp.stack(maps)
            d = xp.nanmedian(stack, axis=0)
            spread = xp.nanmax(stack, axis=0) - xp.nanmin(stack, axis=0)
            d[spread > settings.agree * d] = xp.nan
            del stack, spread
        out = b.to_host(fill_pinholes(b, d.astype(xp.float32)))
    del d, maps
    b.release()
    return out, info


# -------------------------------------------------------------------------------------- fusion


class Rays:
    """The direction through every pixel centre, per camera, kept on the backend (as
    ``scene.pixel_rays`` keeps it on the CPU): float32 values, as the CPU path uses them."""

    def __init__(self, b: Backend):
        self.b = b
        self.kept: dict[Camera, tuple[Any, Any]] = {}

    def __call__(self, cam: Camera) -> tuple[Any, Any]:
        if cam not in self.kept:
            xp = self.b.xp
            while len(self.kept) >= 2:
                self.kept.pop(next(iter(self.kept)))
            ys, xs = xp.mgrid[0 : cam.height, 0 : cam.width].astype(xp.float64)
            u, v = cam.undistort((xs + 0.5 - cam.cx) / cam.fx, (ys + 0.5 - cam.cy) / cam.fy)
            self.kept[cam] = (u.astype(xp.float32), v.astype(xp.float32))
        return self.kept[cam]


def fuse_arrays(
    b: Backend,
    view: View,
    cam: Camera,
    depth: np.ndarray,
    others: list[tuple[View, Camera, np.ndarray]],
    settings: FuseSettings,
    rays: Rays,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """``fuse.consistent`` and ``fuse.normals_of`` for one photo, in row bands.

    Answers what ``products`` keeps of a photo: the world points other photos confirm (n, 3), their
    normals (n, 3) float32, and the (h, w) mask of the pixels they come from, in row order.
    """
    xp = b.xp
    h, w = depth.shape
    d = xp.asarray(depth)
    u, v = rays(cam)
    near = [(ov, oc, xp.asarray(od)) for ov, oc, od in others]
    centre = view.centre
    keep = np.zeros((h, w), bool)
    xyz: list[np.ndarray] = []
    nrm: list[np.ndarray] = []
    for y0 in range(0, h, ROWS):
        y1 = min(h, y0 + ROWS)
        a, z1 = max(0, y0 - 1), min(h, y1 + 1)  # one row more each side for the normals
        z = d[a:z1].astype(xp.float64)
        p0, p1, p2 = mul3(
            u[a:z1].astype(xp.float64) * z - view.t[0],
            v[a:z1].astype(xp.float64) * z - view.t[1],
            z - view.t[2],
            view.r,
        )
        pts = xp.stack([p0, p1, p2], -1)
        ok = xp.isfinite(d[a:z1])
        agree = xp.zeros(ok.shape, xp.int32)
        flat = pts[ok]
        got = xp.zeros(int(flat.shape[0]), xp.int32)
        for ov, oc, od in near:
            x, y, zz = oc.project_cam(to_cam(b, ov, flat[:, 0], flat[:, 1], flat[:, 2]))
            inside = (zz > 0) & (x >= 0) & (y >= 0) & (x < oc.width) & (y < oc.height)
            xi = xp.clip(xp.floor(x).astype(xp.int64), 0, oc.width - 1)
            yi = xp.clip(xp.floor(y).astype(xp.int64), 0, oc.height - 1)
            dz = od[yi, xi]
            got += (inside & xp.isfinite(dz) & (xp.abs(dz - zz) <= settings.tolerance * zz)).astype(xp.int32)
        agree[ok] = got
        # normals from central differences; the photo's first and last row and column have none
        dx = xp.zeros_like(pts)
        dy = xp.zeros_like(pts)
        dx[:, 1:-1] = pts[:, 2:] - pts[:, :-2]
        dy[1:-1, :] = pts[2:, :] - pts[:-2, :]
        n = xp.cross(dx, dy)
        with np.errstate(invalid="ignore", divide="ignore"):
            n = n / xp.sqrt((n * n).sum(-1, keepdims=True))
        flip = ((n * (xp.asarray(centre) - pts)).sum(-1)) < 0
        n[flip] *= -1
        rows = slice(y0 - a, y0 - a + (y1 - y0))
        good = ok[rows] & (agree[rows] >= settings.min_agree) & xp.isfinite(n[rows]).all(-1)
        keep[y0:y1] = b.to_host(good)
        xyz.append(b.to_host(pts[rows][good]))
        nrm.append(b.to_host(n[rows][good].astype(xp.float32)))
        del pts, n, dx, dy, flat, agree, got
    b.release()
    return np.concatenate(xyz), np.concatenate(nrm), keep
