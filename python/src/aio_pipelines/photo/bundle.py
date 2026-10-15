"""Georeferencing maths in numpy: similarity fits and triangulation.

All of it runs in a metric, rigid frame (``crs.EnuFrame``), never in a projected CRS.

- ``similarity`` (Umeyama) and ``similarity_ransac``: SfM frame to the GNSS or GCP frame.
- ``triangulate``: a point from its marks through calibrated cameras (DLT, then Gauss-Newton).
- ``refine_points``: points again with the cameras fixed (vectorised per point).

ODM aligns and adjusts the block; these place a model and measure marked points through it.
"""

from __future__ import annotations

import math

import numpy as np

from ..runtime import JobError
from .model import (
    SparseModel,
    project_canonical,
    undistort_pixels,
)

# ------------------------------------------------------------------------------- similarity


def similarity(src: np.ndarray, dst: np.ndarray, weights: np.ndarray | None = None):
    """Least-squares similarity ``dst = s * R @ src + t`` (Umeyama). Returns (s, R, t)."""
    src = np.asarray(src, dtype=np.float64).reshape(-1, 3)
    dst = np.asarray(dst, dtype=np.float64).reshape(-1, 3)
    if len(src) < 3:
        raise JobError("At least three positions are needed to place the model.")
    w = np.ones(len(src)) if weights is None else np.asarray(weights, dtype=np.float64)
    w = w / w.sum()
    ms, md = w @ src, w @ dst
    a, b = src - ms, dst - md
    cov = (b * w[:, None]).T @ a
    u, d, vt = np.linalg.svd(cov)
    e = np.eye(3)
    if np.linalg.det(u) * np.linalg.det(vt) < 0:
        e[2, 2] = -1
    r = u @ e @ vt
    var = float((w * (a * a).sum(axis=1)).sum())
    if var <= 0:
        raise JobError("The positions are all the same point; the model cannot be placed.")
    s = float(np.trace(np.diag(d) @ e) / var)
    t = md - s * r @ ms
    return s, r, t


def apply_similarity(sim, x: np.ndarray) -> np.ndarray:
    s, r, t = sim
    return s * np.asarray(x, dtype=np.float64).reshape(-1, 3) @ r.T + t


def similarity_ransac(
    src: np.ndarray,
    dst: np.ndarray,
    threshold: float,
    iterations: int = 400,
    seed: int = 0,
    sigma: np.ndarray | None = None,
):
    """Robust similarity: random triples, the most inliers within ``threshold`` metres, then a
    least-squares fit on the inliers (weighted by ``1 / sigma^2`` when given). Returns
    ``(s, R, t), inlier mask``."""
    src = np.asarray(src, dtype=np.float64).reshape(-1, 3)
    dst = np.asarray(dst, dtype=np.float64).reshape(-1, 3)
    n = len(src)
    if n < 3:
        raise JobError("At least three photos with GPS must align to place the model.")
    rng = np.random.default_rng(seed)
    best = np.ones(n, bool)
    best_n = -1
    best_err = math.inf
    for _ in range(iterations if n > 3 else 1):
        idx = rng.choice(n, 3, replace=False) if n > 3 else np.arange(3)
        a = src[idx]
        if np.linalg.norm(np.cross(a[1] - a[0], a[2] - a[0])) < 1e-9 * (np.ptp(src) + 1) ** 2:
            continue
        try:
            sim = similarity(a, dst[idx])
        except (JobError, np.linalg.LinAlgError):
            continue
        err = np.linalg.norm(apply_similarity(sim, src) - dst, axis=1)
        inl = err < threshold
        k = int(inl.sum())
        e = float(np.median(err[inl])) if k else math.inf
        if k > best_n or (k == best_n and e < best_err):
            best, best_n, best_err = inl, k, e
    if best_n < 3:
        best = np.ones(n, bool)
    w = None if sigma is None else 1.0 / np.maximum(np.asarray(sigma)[best], 1e-3) ** 2
    sim = similarity(src[best], dst[best], w)
    for _ in range(3):  # local optimisation: refit on the inliers of the refit
        err = np.linalg.norm(apply_similarity(sim, src) - dst, axis=1)
        inl = err < threshold
        if inl.sum() < 3 or (inl == best).all():
            break
        best = inl
        w = None if sigma is None else 1.0 / np.maximum(np.asarray(sigma)[best], 1e-3) ** 2
        sim = similarity(src[best], dst[best], w)
    return sim, best


# ------------------------------------------------------------------------------- triangulation


def triangulate(
    model: SparseModel, observations: list[tuple[int, tuple[float, float]]]
) -> tuple[np.ndarray, float]:
    """A point from ``(image id, pixel)`` observations: DLT on undistorted rays, then Gauss-Newton.

    Returns the point and its mean reprojection error (pixels). Needs two registered images.
    """
    rows = []
    obs = [(iid, xy) for iid, xy in observations if iid in model.images]
    if len(obs) < 2:
        raise JobError("A point needs marks in at least two aligned photos.")
    for iid, xy in obs:
        im = model.images[iid]
        n = undistort_pixels(model.cameras[im.camera_id], np.asarray(xy, dtype=np.float64)[None])[0]
        p = np.hstack([im.R, im.t[:, None]])
        rows.append(n[0] * p[2] - p[0])
        rows.append(n[1] * p[2] - p[1])
    _, _, vt = np.linalg.svd(np.array(rows))
    x = vt[-1]
    if abs(x[3]) < 1e-12:
        raise JobError("The marks of a point do not meet (parallel rays).")
    X = x[:3] / x[3]
    img = np.array([iid for iid, _ in obs])
    xy = np.array([xy for _, xy in obs], dtype=np.float64)
    X = refine_points(model, X[None], np.zeros(len(obs), np.int64), img, xy, iterations=10, robust=False)[0]
    canon, R, C = _per_obs_cameras(model, img)
    uv, _ = project_canonical(canon, R, C, np.repeat(X[None], len(obs), axis=0))
    return X, float(np.linalg.norm(uv - xy, axis=1).mean())


def _per_obs_cameras(model: SparseModel, img_ids: np.ndarray):
    ids = sorted(model.images)
    R_all = np.array([model.images[i].R for i in ids])
    C_all = np.array([model.images[i].centre for i in ids])
    cam_canon = {cid: c.canonical() for cid, c in model.cameras.items()}
    canon_all = np.array([cam_canon[model.images[i].camera_id] for i in ids])
    k = np.searchsorted(np.array(ids, np.int64), np.asarray(img_ids, np.int64))
    return canon_all[k], R_all[k], C_all[k]


def refine_points(
    model: SparseModel,
    X: np.ndarray,
    obs_point: np.ndarray,
    obs_image: np.ndarray,
    obs_xy: np.ndarray,
    iterations: int = 5,
    robust: bool = True,
    huber_px: float = 2.0,
) -> np.ndarray:
    """Gauss-Newton per point with the cameras fixed, all points at once (vectorised)."""
    X = np.array(X, dtype=np.float64).reshape(-1, 3)
    if len(obs_point) == 0:
        return X
    canon, R, C = _per_obs_cameras(model, obs_image)
    n = len(X)
    for _ in range(iterations):
        Xo = X[obs_point]
        uv, z = project_canonical(canon, R, C, Xo)
        r = uv - obs_xy
        h = 1e-4 * np.maximum(1.0, np.linalg.norm(Xo - C, axis=1))
        J = np.empty((len(obs_point), 2, 3))
        for k in range(3):
            d = np.zeros(3)
            d[k] = 1.0
            up, _ = project_canonical(canon, R, C, Xo + h[:, None] * d)
            dn, _ = project_canonical(canon, R, C, Xo - h[:, None] * d)
            J[:, :, k] = (up - dn) / (2 * h[:, None])
        w = np.ones(len(obs_point))
        if robust:
            e = np.linalg.norm(r, axis=1)
            w = np.where(e <= huber_px, 1.0, huber_px / np.maximum(e, 1e-12))
        w = np.where(z > 0, w, 0.0)
        JtJ = np.einsum("kai,kaj->kij", J, J) * w[:, None, None]
        Jtr = np.einsum("kai,ka->ki", J, r) * w[:, None]
        H = np.zeros((n, 9))
        g = np.zeros((n, 3))
        for a in range(9):
            H[:, a] = np.bincount(obs_point, JtJ.reshape(-1, 9)[:, a], minlength=n)
        for a in range(3):
            g[:, a] = np.bincount(obs_point, Jtr[:, a], minlength=n)
        H = H.reshape(n, 3, 3) + 1e-9 * np.eye(3)[None]
        ok = np.linalg.det(H) > 1e-18
        step = np.zeros((n, 3))
        if ok.any():
            step[ok] = np.linalg.solve(H[ok], -g[ok][..., None])[..., 0]
        X = X + step
        if np.abs(step).max() < 1e-7:
            break
    return X
