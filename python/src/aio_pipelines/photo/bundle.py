"""Georeferencing maths in numpy and SciPy: similarity fits, triangulation and bundle adjustment.

All of it runs in a metric, rigid frame (``crs.EnuFrame``), never in a projected CRS.

- ``similarity`` (Umeyama) and ``similarity_ransac``: SfM frame to the GNSS or GCP frame.
- ``triangulate``: a point from its marks through calibrated cameras (DLT, then Gauss-Newton).
- ``bundle_adjust``: Levenberg-Marquardt over camera poses, the calibration of each camera group
  and the tie points, with camera position priors (GNSS, weighted by RTK accuracy) and control
  points (weighted by their stated accuracy, observed through their marks). Points are eliminated
  with the Schur complement; the reduced camera system is solved sparse (SuperLU) or dense.
  Robust: Huber weights on image residuals and on GNSS priors (a bad GNSS fix is down-weighted),
  none on control points (a bad control point is found and named by ``gcp.control_outliers``).
- ``refine_points``: every tie point again with the cameras fixed (vectorised per point).

The engine's own bundle adjuster (COLMAP) aligns; this adjuster georeferences. It works on a
subset of well-observed tie points (``select_points``), which is how large blocks stay within
memory on a laptop.
"""

from __future__ import annotations

import itertools
import math
from collections.abc import Callable
from dataclasses import dataclass, field

import numpy as np

from ..runtime import JobError
from .model import (
    CAMERA_MODELS,
    SparseModel,
    canonical_params,
    project_canonical,
    rodrigues,
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


# ------------------------------------------------------------------------------- bundle adjustment

#: Calibration parameters refined per camera model (COLMAP's default: focal and distortion, not
#: the principal point, which is weakly determined by nadir blocks).
REFINE = {
    "SIMPLE_PINHOLE": (0,),
    "PINHOLE": (0, 1),
    "SIMPLE_RADIAL": (0, 3),
    "RADIAL": (0, 3, 4),
    "OPENCV": (0, 1, 4, 5),
    "FULL_OPENCV": (0, 1, 4, 5, 8, 9, 10, 11),
}


@dataclass
class CameraPrior:
    """A GNSS position of a camera centre (ENU metres) with one-sigma accuracy."""

    position: np.ndarray
    sigma_h: float
    sigma_v: float


@dataclass
class ControlPoint:
    """A control point: surveyed position (ENU), one-sigma accuracy and marks ``(image id, px)``."""

    id: str
    position: np.ndarray
    sigma_h: float
    sigma_v: float
    marks: list[tuple[int, tuple[float, float]]]
    mark_sigma_px: float = 1.0


@dataclass
class AdjustResult:
    iterations: int
    initial_cost: float
    final_cost: float
    control: dict[str, np.ndarray] = field(default_factory=dict)
    reprojection_px: float = 0.0
    seconds: float = 0.0


#: Observations the georeferencing adjustment works on at most: about 0.5 GB of working arrays,
#: whatever the size of the flight (a 1,000-photo oblique flight has about 10 million).
MAX_BA_OBSERVATIONS = 400_000
#: Observations per block when every tie point is refined again (bounded memory).
REFINE_BLOCK = 250_000


def select_points(
    model: SparseModel,
    per_image: int = 150,
    min_track: int = 3,
    max_error_px: float = 4.0,
    max_observations: int = MAX_BA_OBSERVATIONS,
) -> np.ndarray:
    """Indices of well-observed tie points, about ``per_image`` per photo (long tracks first),
    with at most ``max_observations`` observations in all."""
    img, pts, _ = model.observations()
    if len(pts) == 0:
        return np.zeros(0, np.int64)
    n = len(model.point_ids)
    tl = np.bincount(pts, minlength=n)
    good = (tl >= min_track) & (model.error <= max_error_px if len(model.error) else True)
    if not good.any():
        good = tl >= 2
    order = np.argsort(-tl, kind="stable")
    order = order[good[order]]
    ids = np.array(sorted(model.images), np.int64)
    img_idx = np.searchsorted(ids, img)
    by = np.argsort(pts, kind="stable")
    img_s = img_idx[by]
    pts_s = pts[by]
    starts = np.searchsorted(pts_s, np.arange(n), "left")
    ends = np.searchsorted(pts_s, np.arange(n), "right")
    need = np.full(len(ids), per_image, np.int64)
    chosen = []
    total = 0
    for p in order.tolist():
        ims = img_s[starts[p] : ends[p]]
        if (need[ims] > 0).any():
            chosen.append(p)
            need[ims] -= 1
            total += len(ims)
            if total >= max_observations or need.max() <= 0:
                break
    return np.array(sorted(chosen), np.int64)


class _Problem:
    def __init__(self, model, point_idx, priors, controls, refine_intrinsics, huber_px, huber_prior):
        self.model = model
        self.image_ids = sorted(model.images)
        self.ipos = {iid: k for k, iid in enumerate(self.image_ids)}
        self.cam_ids = sorted(model.cameras)
        self.cpos = {cid: k for k, cid in enumerate(self.cam_ids)}
        self.huber_px = huber_px
        self.huber_prior = huber_prior
        ni, nc = len(self.image_ids), len(self.cam_ids)
        self.R0 = np.array([model.images[i].R for i in self.image_ids])
        self.omega = np.zeros((ni, 3))
        self.C = np.array([model.images[i].centre for i in self.image_ids])
        models = {model.cameras[c].model for c in self.cam_ids}
        self.cam_params = [model.cameras[c].params.copy() for c in self.cam_ids]
        self.refine = [REFINE[model.cameras[c].model] if refine_intrinsics else () for c in self.cam_ids]
        self.q = max((len(r) for r in self.refine), default=0)
        self.models = models
        # tie points and control points share the point block
        img, pts, xy = model.observations()
        sel = np.zeros(len(model.point_ids), bool)
        sel[point_idx] = True
        keep = sel[pts]
        remap = -np.ones(len(model.point_ids), np.int64)
        remap[point_idx] = np.arange(len(point_idx))
        self.point_idx = np.asarray(point_idx, np.int64)
        self.X = model.xyz[self.point_idx].copy()
        o_img = [np.array([self.ipos[int(i)] for i in img[keep]], np.int64)]
        o_pt = [remap[pts[keep]]]
        o_xy = [xy[keep]]
        o_sig = [np.ones(int(keep.sum()))]
        self.controls = controls
        self.ctrl_start = len(self.X)
        ctrl_X, ctrl_prior, ctrl_sig = [], [], []
        for k, cp in enumerate(controls):
            marks = [(self.ipos[i], xy) for i, xy in cp.marks if i in self.ipos]
            ctrl_X.append(cp.position)
            ctrl_prior.append(cp.position)
            ctrl_sig.append([cp.sigma_h, cp.sigma_h, cp.sigma_v])
            if marks:
                o_img.append(np.array([m[0] for m in marks], np.int64))
                o_pt.append(np.full(len(marks), self.ctrl_start + k, np.int64))
                o_xy.append(np.array([m[1] for m in marks], dtype=np.float64))
                o_sig.append(np.full(len(marks), cp.mark_sigma_px))
        if controls:
            self.X = np.vstack([self.X, np.array(ctrl_X)])
        self.ctrl_prior = np.array(ctrl_prior).reshape(-1, 3)
        self.ctrl_sig = np.array(ctrl_sig).reshape(-1, 3)
        self.obs_img = np.concatenate(o_img)
        self.obs_pt = np.concatenate(o_pt)
        self.obs_xy = np.concatenate(o_xy)
        self.obs_sig = np.concatenate(o_sig)
        self.obs_ctrl = self.obs_pt >= self.ctrl_start
        self.obs_cam = (
            np.array([self.cpos[model.images[self.image_ids[i]].camera_id] for i in range(ni)], np.int64)[
                self.obs_img
            ]
            if ni
            else np.zeros(0, np.int64)
        )
        self.prior_img = np.array([self.ipos[i] for i in priors if i in self.ipos], np.int64)
        self.prior_pos = np.array([priors[i].position for i in priors if i in self.ipos]).reshape(-1, 3)
        self.prior_sig = np.array(
            [[priors[i].sigma_h, priors[i].sigma_h, priors[i].sigma_v] for i in priors if i in self.ipos]
        ).reshape(-1, 3)
        self.ni, self.nc, self.np_ = ni, nc, len(self.X)

    # ---- model state
    def rotations(self, omega=None) -> np.ndarray:
        return rodrigues(self.omega if omega is None else omega) @ self.R0

    def canon(self, params=None) -> np.ndarray:
        params = self.cam_params if params is None else params
        return np.array(
            [
                canonical_params(self.model.cameras[c].model, params[k][None])[0]
                for k, c in enumerate(self.cam_ids)
            ]
        )

    def residuals(self, omega=None, C=None, X=None, params=None):
        omega = self.omega if omega is None else omega
        C = self.C if C is None else C
        X = self.X if X is None else X
        R = rodrigues(omega) @ self.R0
        canon = self.canon(params)
        uv, z = project_canonical(canon[self.obs_cam], R[self.obs_img], C[self.obs_img], X[self.obs_pt])
        r_obs = (uv - self.obs_xy) / self.obs_sig[:, None]
        r_obs[z <= 0] = 0.0
        r_pri = (
            (C[self.prior_img] - self.prior_pos) / self.prior_sig if len(self.prior_img) else np.zeros((0, 3))
        )
        nctl = len(self.controls)
        r_ctl = (X[self.ctrl_start :] - self.ctrl_prior) / self.ctrl_sig if nctl else np.zeros((0, 3))
        return r_obs, r_pri, r_ctl

    def weights(self, r_obs, r_pri):
        e = np.linalg.norm(r_obs, axis=1)
        w_obs = np.where(e <= self.huber_px, 1.0, self.huber_px / np.maximum(e, 1e-12))
        w_obs[self.obs_ctrl] = 1.0
        ep = np.linalg.norm(r_pri, axis=1) if len(r_pri) else np.zeros(0)
        w_pri = np.where(ep <= self.huber_prior, 1.0, self.huber_prior / np.maximum(ep, 1e-12))
        return w_obs, w_pri

    @staticmethod
    def robust_cost(r, w, delta):
        e = np.linalg.norm(r, axis=1) if len(r) else np.zeros(0)
        quad = e <= delta
        return float(np.sum(np.where(quad, 0.5 * e * e, delta * e - 0.5 * delta * delta)))

    def cost(self, res):
        r_obs, r_pri, r_ctl = res
        tie = ~self.obs_ctrl
        c = self.robust_cost(r_obs[tie], None, self.huber_px)
        c += 0.5 * float((r_obs[self.obs_ctrl] ** 2).sum())
        c += self.robust_cost(r_pri, None, self.huber_prior) if len(r_pri) else 0.0
        c += 0.5 * float((r_ctl**2).sum())
        return c

    # ---- jacobians (central differences, grouped: every observation depends on one image,
    # one camera and one point, so one perturbation per parameter kind serves all of them)
    def jacobians(self):
        base = dict(omega=self.omega, C=self.C, X=self.X, params=self.cam_params)
        k = len(self.obs_img)
        A = np.zeros((k, 2, 6))
        B = np.zeros((k, 2, 3))
        K = np.zeros((k, 2, self.q))
        hr = 1e-6
        for a in range(3):
            d = np.zeros(3)
            d[a] = hr
            rp = self.residuals(**{**base, "omega": self.omega + d})[0]
            rm = self.residuals(**{**base, "omega": self.omega - d})[0]
            A[:, :, a] = (rp - rm) / (2 * hr)
        scale = max(1.0, float(np.abs(self.X).max()) * 1e-6) if len(self.X) else 1.0
        ht = 1e-4 * scale
        for a in range(3):
            d = np.zeros(3)
            d[a] = ht
            rp = self.residuals(**{**base, "C": self.C + d})[0]
            rm = self.residuals(**{**base, "C": self.C - d})[0]
            A[:, :, 3 + a] = (rp - rm) / (2 * ht)
            rp = self.residuals(**{**base, "X": self.X + d})[0]
            rm = self.residuals(**{**base, "X": self.X - d})[0]
            B[:, :, a] = (rp - rm) / (2 * ht)
        for j in range(self.q):
            plus, minus, steps = [], [], []
            for c, params in enumerate(self.cam_params):
                pp, pm = params.copy(), params.copy()
                h = 0.0
                if j < len(self.refine[c]):
                    idx = self.refine[c][j]
                    h = 1e-4 * abs(params[idx]) if abs(params[idx]) > 1 else 1e-6
                    pp[idx] += h
                    pm[idx] -= h
                plus.append(pp)
                minus.append(pm)
                steps.append(h)
            rp = self.residuals(**{**base, "params": plus})[0]
            rm = self.residuals(**{**base, "params": minus})[0]
            hs = np.array(steps)[self.obs_cam]
            K[:, :, j] = np.where(hs[:, None] > 0, (rp - rm) / (2 * np.where(hs > 0, hs, 1.0)[:, None]), 0.0)
        return A, B, K

    # ---- one LM step with the Schur complement
    def solve(self, A, B, K, res, w_obs, w_pri, lam):
        r_obs, r_pri, r_ctl = res
        ni, nc, q, npt = self.ni, self.nc, self.q, self.np_
        sw = np.sqrt(w_obs)[:, None, None]
        A, B, K = A * sw, B * sw, K * sw
        r = r_obs * np.sqrt(w_obs)[:, None]
        oi, op, oc = self.obs_img, self.obs_pt, self.obs_cam
        ny = 6 * ni + q * nc
        # point blocks V and gradient
        BtB = np.einsum("kai,kaj->kij", B, B).reshape(-1, 9)
        V = np.stack([np.bincount(op, BtB[:, a], minlength=npt) for a in range(9)], axis=1).reshape(npt, 3, 3)
        Btr = np.einsum("kai,ka->ki", B, r)
        gx = np.stack([np.bincount(op, Btr[:, a], minlength=npt) for a in range(3)], axis=1)
        if len(self.controls):
            s2 = 1.0 / self.ctrl_sig**2
            idx = np.arange(self.ctrl_start, npt)
            for a in range(3):
                V[idx, a, a] += s2[:, a]
            gx[idx] += r_ctl / self.ctrl_sig
        V = V + lam * np.einsum("kii->ki", V)[:, :, None] * np.eye(3)[None] + 1e-12 * np.eye(3)[None]
        Vinv = np.linalg.inv(V)
        # camera-side blocks: poses (6 per image) and calibrations (q per camera group)
        J = np.concatenate([A, K], axis=2)  # (k, 2, 6+q)
        JtJ = np.einsum("kai,kaj->kij", J, J)
        Jtr = np.einsum("kai,ka->ki", J, r)
        E = np.einsum("kai,kaj->kij", J, B)  # (k, m, 3): J_y^T B
        U_pose = np.stack(
            [np.bincount(oi, JtJ[:, :6, :6].reshape(-1, 36)[:, a], minlength=ni) for a in range(36)], axis=1
        )
        U_pose = U_pose.reshape(ni, 6, 6)
        gy = np.zeros(ny)
        gy[: 6 * ni] = np.stack([np.bincount(oi, Jtr[:, a], minlength=ni) for a in range(6)], axis=1).ravel()
        if len(self.prior_img):
            s2 = w_pri[:, None] / self.prior_sig**2
            for a in range(3):
                U_pose[self.prior_img, 3 + a, 3 + a] += s2[:, a]
                gy[6 * self.prior_img + 3 + a] += w_pri * r_pri[:, a] / self.prior_sig[:, a]
        # cross terms with calibrations (dense, small)
        Upc = np.zeros((ni, 6, nc * q))
        Ucc = np.zeros((nc * q, nc * q))
        if q:
            for c in range(nc):
                mc = oc == c
                if not mc.any():
                    continue
                blk = JtJ[mc][:, :6, 6:].reshape(-1, 6 * q)
                upc = np.stack([np.bincount(oi[mc], blk[:, a], minlength=ni) for a in range(6 * q)], axis=1)
                Upc[:, :, c * q : (c + 1) * q] = upc.reshape(ni, 6, q)
                Ucc[c * q : (c + 1) * q, c * q : (c + 1) * q] = JtJ[mc][:, 6:, 6:].sum(axis=0)
                gy[6 * ni + c * q : 6 * ni + (c + 1) * q] = Jtr[mc][:, 6:].sum(axis=0)
        # damping
        dpose = np.einsum("kii->ki", U_pose)
        U_pose = U_pose + lam * dpose[:, :, None] * np.eye(6)[None] + 1e-9 * np.eye(6)[None]
        if q:
            Ucc = Ucc + lam * np.diag(np.diag(Ucc)) + 1e-9 * np.eye(nc * q)
        # Schur complement S = U - W V^-1 W^T, assembled per co-observed image pair
        EV = np.einsum("kij,kjl->kil", E, Vinv[op])  # (k, m, 3)
        order = np.argsort(op, kind="stable")
        op_s = op[order]
        starts = np.flatnonzero(np.r_[True, op_s[1:] != op_s[:-1]])
        lens = np.diff(np.r_[starts, len(op_s)])
        pair_a, pair_b = [], []
        for L in np.unique(lens):
            sel = starts[lens == L]
            idx = order[(sel[:, None] + np.arange(L)[None])]  # (n_pts, L)
            pair_a.append(np.repeat(idx, L, axis=1).ravel())
            pair_b.append(np.tile(idx, (1, L)).ravel())
        pa = np.concatenate(pair_a) if pair_a else np.zeros(0, np.int64)
        pb = np.concatenate(pair_b) if pair_b else np.zeros(0, np.int64)
        # pose-pose part
        key = oi[pa] * ni + oi[pb]
        ukey, inv = np.unique(key, return_inverse=True)
        blocks = np.zeros((len(ukey), 36))
        chunk = 400_000
        for s0 in range(0, len(pa), chunk):
            a_, b_ = pa[s0 : s0 + chunk], pb[s0 : s0 + chunk]
            vals = np.einsum("kil,kjl->kij", EV[a_, :6, :], E[b_, :6, :]).reshape(-1, 36)
            for e in range(36):
                blocks[:, e] += np.bincount(inv[s0 : s0 + chunk], vals[:, e], minlength=len(ukey))
        rows_i, rows_j = ukey // ni, ukey % ni
        # calibration parts: per point sums of E over the observations of each camera group
        S_pc = Upc.copy()
        S_cc = Ucc.copy()
        if q:
            F = np.zeros((npt, nc * q, 3))
            for c in range(nc):
                mc = oc == c
                for a in range(q):
                    for b in range(3):
                        F[:, c * q + a, b] = np.bincount(op[mc], E[mc][:, 6 + a, b], minlength=npt)
            FV = np.einsum("pij,pjk->pik", F, Vinv)  # (npt, ncq, 3)
            S_cc -= np.einsum("pik,pjk->ij", FV, F)
            contrib = np.einsum("kil,kjl->kij", EV[:, :6, :], F[op])  # (k, 6, ncq)
            for e in range(6 * nc * q):
                S_pc.reshape(ni, -1)[:, e] -= np.bincount(
                    oi, contrib.reshape(len(oi), -1)[:, e], minlength=ni
                )
        # right-hand side: -g_y + W V^-1 g_x
        gxv = np.einsum("kij,kj->ki", EV, gx[op])  # (k, m)
        rhs = -gy.copy()
        for a in range(6):
            rhs[a : 6 * ni : 6] += np.bincount(oi, gxv[:, a], minlength=ni)
        if q:
            for c in range(nc):
                mc = oc == c
                rhs[6 * ni + c * q : 6 * ni + (c + 1) * q] += gxv[mc][:, 6:].sum(axis=0)
        # assemble S and solve
        dy = _solve_reduced(ni, nc * q, U_pose, rows_i, rows_j, blocks, S_pc, S_cc, rhs)
        # back-substitute the points: dx = V^-1 (-g_x - W^T dy)
        dyo = np.concatenate(
            [
                dy[: 6 * ni].reshape(ni, 6)[oi],
                dy[6 * ni :].reshape(max(nc, 1), q)[oc] if q else np.zeros((len(oi), 0)),
            ],
            axis=1,
        )
        wt = np.einsum("kij,ki->kj", E, dyo)  # (k, 3)
        wsum = np.stack([np.bincount(op, wt[:, a], minlength=npt) for a in range(3)], axis=1)
        dx = np.einsum("pij,pj->pi", Vinv, -gx - wsum)
        return dy, dx


def _solve_reduced(ni, ncq, U_pose, rows_i, rows_j, blocks, S_pc, S_cc, rhs):
    n = 6 * ni + ncq
    if n <= 3600:
        S = np.zeros((n, n))
        for k in range(ni):
            S[6 * k : 6 * k + 6, 6 * k : 6 * k + 6] += U_pose[k]
        bi = (6 * rows_i)[:, None, None] + np.arange(6)[None, :, None]
        bj = (6 * rows_j)[:, None, None] + np.arange(6)[None, None, :]
        np.subtract.at(
            S,
            (np.broadcast_to(bi, (len(rows_i), 6, 6)), np.broadcast_to(bj, (len(rows_i), 6, 6))),
            blocks.reshape(-1, 6, 6),
        )
        if ncq:
            S[: 6 * ni, 6 * ni :] = S_pc.reshape(6 * ni, ncq)
            S[6 * ni :, : 6 * ni] = S_pc.reshape(6 * ni, ncq).T
            S[6 * ni :, 6 * ni :] = S_cc
        S = 0.5 * (S + S.T)
        try:
            from scipy.linalg import cho_factor, cho_solve

            return cho_solve(cho_factor(S), rhs)
        except Exception:
            return np.linalg.lstsq(S, rhs, rcond=None)[0]
    from scipy import sparse
    from scipy.sparse.linalg import spsolve

    r6, c6 = np.meshgrid(np.arange(6), np.arange(6), indexing="ij")
    rows = [(6 * np.arange(ni))[:, None, None] + r6[None], (6 * rows_i)[:, None, None] + r6[None]]
    cols = [(6 * np.arange(ni))[:, None, None] + c6[None], (6 * rows_j)[:, None, None] + c6[None]]
    vals = [U_pose, -blocks.reshape(-1, 6, 6)]
    if ncq:
        pc = S_pc.reshape(6 * ni, ncq)
        rr, cc = np.nonzero(np.ones_like(pc, bool))
        rows += [rr, 6 * ni + cc, 6 * ni + np.repeat(np.arange(ncq), ncq)]
        cols += [6 * ni + cc, rr, 6 * ni + np.tile(np.arange(ncq), ncq)]
        vals += [pc.ravel(), pc.ravel(), S_cc.ravel()]
    S = sparse.coo_matrix(
        (
            np.concatenate([v.ravel() for v in vals]),
            (np.concatenate([r.ravel() for r in rows]), np.concatenate([c.ravel() for c in cols])),
        ),
        shape=(n, n),
    ).tocsc()
    S = 0.5 * (S + S.T)
    return spsolve(S, rhs, permc_spec="COLAMD")


def bundle_adjust(
    model: SparseModel,
    point_idx: np.ndarray,
    priors: dict[int, CameraPrior] | None = None,
    controls: list[ControlPoint] | None = None,
    refine_intrinsics: bool = True,
    max_iterations: int = 30,
    huber_px: float = 2.0,
    huber_prior: float = 3.0,
    check: Callable[[], None] | None = None,
    progress: Callable[[float], None] | None = None,
) -> AdjustResult:
    """Adjust ``model`` in place (poses, calibrations, the selected points); see the module doc."""
    import time

    t0 = time.monotonic()
    priors = priors or {}
    controls = controls or []
    if not priors and len(controls) < 3:
        raise JobError("Georeferencing needs GNSS positions or at least three control points.")
    pr = _Problem(
        model, np.asarray(point_idx, np.int64), priors, controls, refine_intrinsics, huber_px, huber_prior
    )
    if len(pr.obs_img) == 0:
        raise JobError("The model has no observations to adjust.")
    res = pr.residuals()
    cost = pr.cost(res)
    initial = cost
    lam = 1e-4
    it = 0
    for it in range(1, max_iterations + 1):
        if check:
            check()
        w_obs, w_pri = pr.weights(res[0], res[1])
        A, B, K = pr.jacobians()
        improved = False
        for _ in range(8):
            dy, dx = pr.solve(A, B, K, res, w_obs, w_pri, lam)
            ni = pr.ni
            d_pose = dy[: 6 * ni].reshape(ni, 6)
            new_omega = pr.omega + d_pose[:, :3]
            new_C = pr.C + d_pose[:, 3:]
            new_X = pr.X + dx
            new_params = [p.copy() for p in pr.cam_params]
            if pr.q:
                d_cal = dy[6 * ni :].reshape(pr.nc, pr.q)
                for c, params in enumerate(new_params):
                    for j, idx in enumerate(pr.refine[c]):
                        params[idx] += d_cal[c, j]
            new_res = pr.residuals(new_omega, new_C, new_X, new_params)
            new_cost = pr.cost(new_res)
            if np.isfinite(new_cost) and new_cost < cost:
                pr.omega, pr.C, pr.X, pr.cam_params = new_omega, new_C, new_X, new_params
                rel = (cost - new_cost) / max(cost, 1e-12)
                cost, res = new_cost, new_res
                lam = max(lam / 3, 1e-9)
                improved = True
                break
            lam *= 6
        if progress:
            progress(min(1.0, it / max_iterations))
        if not improved or rel < 1e-7:
            break
    # write back
    R = pr.rotations()
    for k, iid in enumerate(pr.image_ids):
        model.images[iid].set_pose(R[k], pr.C[k])
    for k, cid in enumerate(pr.cam_ids):
        model.cameras[cid].params = pr.cam_params[k]
    model.xyz[pr.point_idx] = pr.X[: pr.ctrl_start]
    out = AdjustResult(it, initial, cost, seconds=time.monotonic() - t0)
    for k, cp in enumerate(controls):
        out.control[cp.id] = pr.X[pr.ctrl_start + k].copy()
    tie = ~pr.obs_ctrl
    out.reprojection_px = (
        float(np.linalg.norm(res[0][tie] * pr.obs_sig[tie, None], axis=1).mean()) if tie.any() else 0.0
    )
    return out


def refine_all_points(model: SparseModel, iterations: int = 5, block: int = REFINE_BLOCK) -> None:
    """Every tie point again through the adjusted cameras, in blocks of about ``block``
    observations (bounded memory on large flights); refreshes ``model.error``."""
    img, pts, xy = model.observations()
    if len(pts) == 0:
        return
    n = len(model.point_ids)
    by = np.argsort(pts, kind="stable")
    img, pts, xy = img[by], pts[by], xy[by]
    err_sum = np.zeros(n)
    # block boundaries on point boundaries
    bounds = [0]
    while bounds[-1] < len(pts):
        end = min(bounds[-1] + block, len(pts))
        if end < len(pts):
            end = int(np.searchsorted(pts, pts[end - 1], "right"))
        bounds.append(end)
    xyz = model.xyz.copy()
    for s0, s1 in itertools.pairwise(bounds):
        p = pts[s0:s1]
        uniq, local = np.unique(p, return_inverse=True)
        X = refine_points(model, xyz[uniq], local, img[s0:s1], xy[s0:s1], iterations=iterations)
        xyz[uniq] = X
        canon, R, C = _per_obs_cameras(model, img[s0:s1])
        uv, _ = project_canonical(canon, R, C, X[local])
        err_sum += np.bincount(p, np.linalg.norm(uv - xy[s0:s1], axis=1), minlength=n)
    model.xyz = xyz
    cnt = np.bincount(pts, minlength=n)
    model.error = err_sum / np.maximum(cnt, 1)


def supported(model: SparseModel) -> bool:
    return all(c.model in CAMERA_MODELS for c in model.cameras.values())
