"""Seed, match and adjust of ``pano.stitch`` (spec section 2; P0 findings, 13 Oct 2026).

The gimbal angles put every frame within a degree or two of the truth (the seed). Features are
matched only between frames whose seeds overlap; a rotation-only bundle adjustment with one shared
focal length then pulls the sphere tight and is re-anchored to the seeds, so north and level come
from the gimbal and the fine alignment from the features. A frame without matches keeps its seed.
The whole sphere falls back to the seeds (``aligned: 'metadata'``) when the median residual or a
frame's turn from its seed is too large, or the adjustment does not converge.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass, field

import cv2
import numpy as np
from scipy.optimize import least_squares

from .geometry import angle_deg, nearest_rotation, principal, rotvecs_to_matrices

#: Working copies for features are at most this wide (spec: about 1600 px).
WORK_WIDTH = 1600
SIFT_FEATURES = 4000
#: Lowe's ratio test.
RATIO = 0.8
#: A match must land within this angle of where the seeds put it (tuned by P0).
SEED_TOLERANCE_DEG = 8.0
#: RANSAC reprojection threshold of the homography check, working-copy pixels (tuned by P0).
RANSAC_PX = 3.0
MIN_MATCHES = 15
MIN_INLIERS = 20
MAX_PER_PAIR = 300
#: Weight of the pull towards the seed, per focal pixel per radian (tuned by P0).
PRIOR_WEIGHT = 0.05
HUBER_PX = 2.0
MAX_EVALUATIONS = 200
#: Fallback limits (spec, P0 findings): median residual at the working width, turn from the seed.
MAX_MEDIAN_RESIDUAL_PX = 2.0
MAX_DRIFT_DEG = 5.0


@dataclass
class Features:
    pts: np.ndarray  # (n, 2) float32, working-copy pixels
    desc: np.ndarray | None


@dataclass
class PairMatch:
    i: int
    j: int
    a: np.ndarray  # (m, 2) points in frame i, working-copy pixels
    b: np.ndarray  # (m, 2) the same points in frame j


@dataclass
class Alignment:
    rotations: list[np.ndarray]
    aligned: str  # 'features' | 'metadata'
    focal_scale: float
    residual_px: float | None
    max_drift_deg: float | None
    unmatched: list[int] = field(default_factory=list)
    reason: str | None = None


def work_scale(width: int) -> float:
    return min(1.0, WORK_WIDTH / width)


def detect(gray: np.ndarray) -> Features:
    sift = cv2.SIFT_create(nfeatures=SIFT_FEATURES)
    kps, desc = sift.detectAndCompute(gray, None)
    return Features(np.float32([k.pt for k in kps]).reshape(-1, 2), desc)


def overlap_pairs(seeds: list[np.ndarray], hfov_deg: float) -> list[tuple[int, int]]:
    """Pairs whose seed view directions are closer than the horizontal field of view."""
    pairs = []
    for i in range(len(seeds)):
        for j in range(i + 1, len(seeds)):
            if angle_between(seeds[i][:, 2], seeds[j][:, 2]) <= hfov_deg:
                pairs.append((i, j))
    return pairs


def angle_between(a: np.ndarray, b: np.ndarray) -> float:
    return math.degrees(math.acos(float(np.clip(a @ b / np.linalg.norm(a) / np.linalg.norm(b), -1, 1))))


def camera_matrix(f: float, width: int, height: int) -> np.ndarray:
    cx, cy = principal(width, height)
    return np.array([[f, 0, cx], [0, f, cy], [0, 0, 1]], float)


def match_pair(
    fa: Features,
    fb: Features,
    seed_a: np.ndarray,
    seed_b: np.ndarray,
    k: np.ndarray,
    rng: np.random.Generator,
) -> tuple[np.ndarray, np.ndarray] | None:
    """Matches between two frames that agree with the seeds and with one homography (a pure
    rotation between views), or None."""
    if fa.desc is None or fb.desc is None or len(fa.desc) < 10 or len(fb.desc) < 10:
        return None
    knn = cv2.BFMatcher(cv2.NORM_L2).knnMatch(fa.desc, fb.desc, k=2)
    good = [m[0] for m in knn if len(m) == 2 and m[0].distance < RATIO * m[1].distance]
    if len(good) < MIN_MATCHES:
        return None
    a = fa.pts[[m.queryIdx for m in good]]
    b = fb.pts[[m.trainIdx for m in good]]
    # where the seeds put a's points in b: H = K Rb^T Ra K^-1 (camera-to-world rotations)
    hs = k @ seed_b.T @ seed_a @ np.linalg.inv(k)
    pa = cv2.perspectiveTransform(a[None].astype(np.float64), hs)[0]
    keep = np.linalg.norm(pa - b, axis=1) < math.radians(SEED_TOLERANCE_DEG) * k[0, 0]
    a, b = a[keep], b[keep]
    if len(a) < MIN_MATCHES:
        return None
    hm, inl = cv2.findHomography(a, b, cv2.RANSAC, RANSAC_PX)
    if hm is None:
        return None
    inl = inl.ravel().astype(bool)
    if inl.sum() < MIN_INLIERS:
        return None
    a, b = a[inl], b[inl]
    if len(a) > MAX_PER_PAIR:
        sel = rng.choice(len(a), MAX_PER_PAIR, replace=False)
        a, b = a[sel], b[sel]
    return a, b


def match_frames(
    grays: list[np.ndarray],
    seeds: list[np.ndarray],
    focal_work: float,
    check: Callable[[], None] = lambda: None,
    progress: Callable[[float], None] = lambda f: None,
) -> list[PairMatch]:
    """Features of every working copy, then matches between overlapping pairs."""
    h, w = grays[0].shape[:2]
    feats = []
    for n, g in enumerate(grays):
        check()
        feats.append(detect(g))
        progress(0.6 * (n + 1) / len(grays))
    hfov = 2 * math.degrees(math.atan(w / 2 / focal_work))
    k = camera_matrix(focal_work, w, h)
    rng = np.random.default_rng(0)
    pairs = overlap_pairs(seeds, hfov)
    out = []
    for n, (i, j) in enumerate(pairs):
        check()
        m = match_pair(feats[i], feats[j], seeds[i], seeds[j], k, rng)
        if m is not None:
            out.append(PairMatch(i, j, m[0], m[1]))
        progress(0.6 + 0.4 * (n + 1) / max(1, len(pairs)))
    return out


def _residuals(x: np.ndarray, seeds: np.ndarray, f0: float, c: np.ndarray, data) -> np.ndarray:
    n = len(seeds)
    rots = seeds @ rotvecs_to_matrices(x[: 3 * n])  # R_k = S_k exp(w_k): turn in the camera frame
    f = f0 * x[-1]
    ii, jj, a, b = data

    def reproject(src, si, dst, di):
        ray = np.column_stack([(src - c) / f, np.ones(len(src))])
        world = np.einsum("nij,nj->ni", rots[si], ray)
        q = np.einsum("nji,nj->ni", rots[di], world)
        return f * q[:, :2] / q[:, 2:3] + c - dst

    r1 = reproject(a, ii, b, jj)
    r2 = reproject(b, jj, a, ii)
    return np.concatenate([r1.ravel(), r2.ravel(), PRIOR_WEIGHT * f0 * x[: 3 * n]])


def adjust(
    seeds: list[np.ndarray], matches: list[PairMatch], focal_work: float, size: tuple[int, int]
) -> tuple[list[np.ndarray], float, float, bool]:
    """Rotation-only bundle adjustment with one shared focal scale, re-anchored to the seeds.
    Gives rotations, focal scale, median residual (working pixels) and whether it converged."""
    n = len(seeds)
    s = np.stack(seeds)
    c = np.array(principal(*size))
    data = (
        np.concatenate([np.full(len(m.a), m.i) for m in matches]),
        np.concatenate([np.full(len(m.a), m.j) for m in matches]),
        np.concatenate([m.a for m in matches]).astype(float),
        np.concatenate([m.b for m in matches]).astype(float),
    )
    x0 = np.zeros(3 * n + 1)
    x0[-1] = 1.0
    sol = least_squares(
        _residuals,
        x0,
        args=(s, focal_work, c, data),
        loss="huber",
        f_scale=HUBER_PX,
        x_scale="jac",
        max_nfev=MAX_EVALUATIONS,
    )
    m2 = len(data[0])
    res = sol.fun[: 4 * m2].reshape(-1, 2)
    median_px = float(np.median(np.linalg.norm(res, axis=1)))
    rots = s @ rotvecs_to_matrices(sol.x[: 3 * n])
    # re-anchor: the world turn G that best maps the adjusted frames onto their seeds
    g = nearest_rotation(sum(seeds[k] @ rots[k].T for k in range(n)))
    return [g @ r for r in rots], float(sol.x[-1]), median_px, bool(sol.success)


def align(
    seeds: list[np.ndarray], matches: list[PairMatch], focal_work: float, size: tuple[int, int]
) -> Alignment:
    """The rotations to compose with, and how they were found."""
    n = len(seeds)
    matched = sorted({m.i for m in matches} | {m.j for m in matches})
    unmatched = [k for k in range(n) if k not in matched]
    if not matches:
        return Alignment(
            list(seeds), "metadata", 1.0, None, None, unmatched, "No features matched between frames."
        )
    rots, scale, median_px, ok = adjust(seeds, matches, focal_work, size)
    for k in unmatched:  # no features: the seed stands (P0)
        rots[k] = seeds[k]
    drift = max(angle_deg(rots[k], seeds[k]) for k in matched)
    reason = None
    if not ok:
        reason = "The adjustment did not converge."
    elif median_px > MAX_MEDIAN_RESIDUAL_PX:
        reason = f"Features disagree by {median_px:.1f} px."
    elif drift > MAX_DRIFT_DEG:
        reason = f"A frame turned {drift:.1f} degrees from its gimbal angles."
    if reason:
        return Alignment(list(seeds), "metadata", 1.0, round(median_px, 3), None, unmatched, reason)
    return Alignment(rots, "features", scale, round(median_px, 3), round(drift, 3), unmatched)
