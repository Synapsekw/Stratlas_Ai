"""Light of ``pano.stitch``: one exposure for the whole sphere.

A drone shoots a sphere on auto exposure, so its frames differ by several stops (a real sphere:
1/240 s at f/5 to 1/1250 s at f/8, 3.7 stops), and every frame is darker towards its corners. One
gain per frame on the gamma-encoded JPEG (OpenCV's ``GAIN`` compensator) cannot even that out: it
leaves blocks and bars at the seams over water and sky, where the seam finder has no texture to
hide them in.

So the light is modelled in linear light, as ``I_k(x) = g_k * V(r) * L(x)``: the scene radiance
``L``, a gain per frame and colour channel ``g_k`` and one vignetting falloff ``V`` of the radius
from the image centre, shared by every frame (one lens). Both are fitted by least squares from the
colours where overlapping frames see the same direction, sampled on small blurred copies placed by
the adjusted rotations, so frames without feature matches (open water) are fitted too. The EXIF
exposure is a weak prior on each gain, which decides a frame that overlaps nothing usable.

Composing divides every frame by its gain and the falloff. Evened radiance alone loses what the
camera's auto exposure was for: the sky towards the sun turns a broad white. So part of the
camera's choice is given back as an exposure that varies smoothly with the view direction (the
frames' gains, averaged over neighbouring view directions); every frame sees the same exposure
in the same direction, so it cannot make a seam. One tone curve for the whole sphere then maps it
back to 8 bits: identity up to a knee, then a soft shoulder that brings the brightest radiance to
white instead of clipping it.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass

import cv2
import numpy as np
from scipy.optimize import least_squares

from .geometry import principal

#: Small copies for the fit are this wide.
FIT_WIDTH = 320
#: Their blur (Gaussian sigma, small-copy pixels) hides a residual misalignment of a pixel or two.
FIT_BLUR = 2.0
#: Samples on a grid of this many small-copy pixels; at most this many per pair.
SAMPLE_STEP = 6
MAX_PER_PAIR = 400
MIN_PER_PAIR = 30
#: Samples darker or brighter than this (8-bit) in either frame are left out: noise and clipping.
DARK = 10
BRIGHT = 245
#: Samples on edges are left out (gradient of the blurred grey copy, 8-bit per pixel).
MAX_GRADIENT = 6.0
#: Robust loss scale on log radiance (about 5 percent).
LOSS_SCALE = 0.05
#: Weights of the priors, per log unit: each gain towards its EXIF exposure, the three channel
#: gains of a frame towards each other (white balance hardly moves within a sphere).
EXPOSURE_PRIOR = 0.3
CHANNEL_PRIOR = 1.0
#: The fitted falloff is clamped to this much light loss at the corner.
MAX_FALLOFF = 0.6
#: Tone curve: radiance up to the knee keeps its value; above it, the range to the brightest
#: radiance (this percentile of the samples) is compressed into what is left to white.
KNEE = 0.6
WHITE_PERCENTILE = 99.95
#: Share of the camera's own exposure given back, smoothly over the sphere (0: one exposure for
#: the sphere; 1: each frame's own, less its seams), and the angular width of that smoothing.
LOCAL_EXPOSURE = 0.6
FIELD_SIGMA_DEG = 30.0
#: The exposure field and falloff are computed on a grid of this many cells across a frame, then
#: resized (at 128 the falloff is within 0.3 percent of its exact value, under one 8-bit level).
FIELD_GRID = 128

_LIN = None


def _to_linear_lut() -> np.ndarray:
    global _LIN
    if _LIN is None:
        c = np.arange(256, dtype=np.float64) / 255.0
        _LIN = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4).astype(np.float32)
    return _LIN


def to_linear(img: np.ndarray) -> np.ndarray:
    """sRGB 8-bit to linear float32 in [0, 1]."""
    return _to_linear_lut()[img]


def to_srgb(lin: np.ndarray) -> np.ndarray:
    """Linear [0, 1] (float32) to sRGB 8-bit."""
    lin = np.clip(lin, 0.0, 1.0)
    s = np.where(lin <= 0.0031308, lin * 12.92, 1.055 * np.power(lin, 1 / 2.4) - 0.055)
    return np.clip(s * 255.0 + 0.5, 0, 255).astype(np.uint8)


@dataclass
class Light:
    """The fitted light model: log gains (n, 3, BGR), log falloff coefficients of r^2, r^4, r^6
    (r = 1 at the image corner), every frame's view direction (world, unit), the tone curve's
    white radiance, and how many samples and pairs it was fitted from."""

    log_gains: list[list[float]]
    falloff: list[float]
    views: list[list[float]]
    white: float
    samples: int
    pairs: int

    def to_json(self) -> dict:
        return asdict(self)

    @staticmethod
    def from_json(d: dict) -> Light:
        return Light(**d)

    def exposure(self, dirs: np.ndarray) -> np.ndarray:
        """The smooth log exposure given back at world directions (..., 3)."""
        views = np.asarray(self.views, np.float32)
        g = np.asarray(self.log_gains, np.float32).mean(axis=1)
        cosang = np.clip(dirs @ views.T, -1.0, 1.0)
        wt = np.exp(-((np.degrees(np.arccos(cosang)) / FIELD_SIGMA_DEG) ** 2)) + 1e-12
        return LOCAL_EXPOSURE * (wt @ g) / wt.sum(axis=-1)


def exposure_log_gains(evs: list[float | None]) -> np.ndarray:
    """Log gains from EXIF exposure values (EV100), zero mean over the frames that have one:
    a frame shot one stop shorter records half the light. Frames without one get 0."""
    known = [e for e in evs if e is not None]
    ref = float(np.median(known)) if known else 0.0
    return np.array([-(e - ref) * math.log(2) if e is not None else 0.0 for e in evs])


def _radius2(pts: np.ndarray, w: int, h: int) -> np.ndarray:
    cx, cy = principal(w, h)
    return ((pts[:, 0] - cx) ** 2 + (pts[:, 1] - cy) ** 2) / (cx * cx + cy * cy)


def _log_falloff(c: np.ndarray, r2: np.ndarray) -> np.ndarray:
    return c[0] * r2 + c[1] * r2**2 + c[2] * r2**3


def exposure_map(
    light: Light, rot: np.ndarray, f: float, w: int, h: int, falloff: bool = False
) -> np.ndarray:
    """exp(the smooth exposure) over a w x h frame with this rotation and focal length (float32);
    with `falloff`, divided by the lens falloff too. Both are smooth, so they are computed on a
    grid and resized: one full-size map, not three, for a 16K frame."""
    n = FIELD_GRID
    cx, cy = principal(w, h)
    xs = np.linspace(0, w - 1, n)
    ys = np.linspace(0, h - 1, max(2, round(n * h / w)))
    gx, gy = np.meshgrid(xs, ys)
    rays = np.stack([(gx - cx) / f, (gy - cy) / f, np.ones_like(gx)], axis=-1) @ rot.T
    rays /= np.linalg.norm(rays, axis=-1, keepdims=True)
    log = light.exposure(rays.astype(np.float32))
    if falloff:
        r2 = ((gx - cx) ** 2 + (gy - cy) ** 2) / (cx * cx + cy * cy)
        log = log - _log_falloff(np.asarray(light.falloff), r2)
    return cv2.resize(np.exp(log).astype(np.float32), (w, h), interpolation=cv2.INTER_LINEAR)


def falloff_map(light: Light, w: int, h: int) -> np.ndarray:
    """V(r) over a w x h frame (float32), 1 at the centre."""
    cx, cy = principal(w, h)
    xs = (np.arange(w, dtype=np.float32) - cx) ** 2
    ys = (np.arange(h, dtype=np.float32) - cy) ** 2
    r2 = (ys[:, None] + xs[None]) / np.float32(cx * cx + cy * cy)
    c = np.asarray(light.falloff, np.float32)
    return np.exp(c[0] * r2 + c[1] * r2 * r2 + c[2] * r2 * r2 * r2).astype(np.float32)


@dataclass
class _Copy:
    lin: np.ndarray  # (h, w, 3) float32, blurred linear light
    ok: np.ndarray  # (h, w) bool: usable for a sample
    f: float


def fit_copy(img: np.ndarray, focal: float) -> _Copy:
    """A frame's small copy for the fit (img: a colour copy at any scale, focal at that scale)."""
    h, w = img.shape[:2]
    s = min(1.0, FIT_WIDTH / w)
    if s < 1.0:
        img = cv2.resize(img, (round(w * s), round(h * s)), interpolation=cv2.INTER_AREA)
    blur = cv2.GaussianBlur(img, (0, 0), FIT_BLUR)
    grey = cv2.cvtColor(blur, cv2.COLOR_BGR2GRAY).astype(np.float32)
    grad = (
        np.hypot(cv2.Sobel(grey, cv2.CV_32F, 1, 0, ksize=3), cv2.Sobel(grey, cv2.CV_32F, 0, 1, ksize=3)) / 8
    )
    ok = (blur.min(axis=2) > DARK) & (blur.max(axis=2) < BRIGHT) & (grad < MAX_GRADIENT)
    ok = cv2.erode(ok.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
    return _Copy(to_linear(blur), ok, focal * s)


def _bilinear(img: np.ndarray, pts: np.ndarray) -> np.ndarray:
    m = pts.astype(np.float32).reshape(-1, 1, 2)
    return cv2.remap(img, m[..., 0], m[..., 1], cv2.INTER_LINEAR).reshape(len(pts), -1)


def pair_samples(a: _Copy, b: _Copy, ra: np.ndarray, rb: np.ndarray, rng: np.random.Generator):
    """Where frame a and frame b see the same direction: points in each (small-copy pixels) and the
    linear colours there, or None when they share too little usable overlap."""
    h, w = a.ok.shape
    ys, xs = np.mgrid[SAMPLE_STEP // 2 : h : SAMPLE_STEP, SAMPLE_STEP // 2 : w : SAMPLE_STEP]
    pa = np.column_stack([xs.ravel(), ys.ravel()]).astype(np.float64)
    pa = pa[a.ok[pa[:, 1].astype(int), pa[:, 0].astype(int)]]
    if len(pa) == 0:
        return None
    cxa, cya = principal(w, h)
    ray = np.column_stack([(pa[:, 0] - cxa) / a.f, (pa[:, 1] - cya) / a.f, np.ones(len(pa))])
    q = ray @ (rb.T @ ra).T
    hb, wb = b.ok.shape
    cxb, cyb = principal(wb, hb)
    with np.errstate(divide="ignore", invalid="ignore"):
        pb = np.column_stack([b.f * q[:, 0] / q[:, 2] + cxb, b.f * q[:, 1] / q[:, 2] + cyb])
    inside = (q[:, 2] > 0) & (pb[:, 0] >= 1) & (pb[:, 0] <= wb - 2) & (pb[:, 1] >= 1) & (pb[:, 1] <= hb - 2)
    pa, pb = pa[inside], pb[inside]
    if len(pa) == 0:
        return None
    keep = b.ok[np.rint(pb[:, 1]).astype(int), np.rint(pb[:, 0]).astype(int)]
    pa, pb = pa[keep], pb[keep]
    if len(pa) < MIN_PER_PAIR:
        return None
    if len(pa) > MAX_PER_PAIR:
        sel = rng.choice(len(pa), MAX_PER_PAIR, replace=False)
        pa, pb = pa[sel], pb[sel]
    return pa, pb, _bilinear(a.lin, pa), _bilinear(b.lin, pb)


def fit(
    copies: list[_Copy],
    rotations: list[np.ndarray],
    evs: list[float | None],
    pairs: list[tuple[int, int]],
) -> Light:
    """The light model of a sphere from the small copies of its frames."""
    n = len(copies)
    rng = np.random.default_rng(0)
    h, w = copies[0].ok.shape
    ii, jj, r2i, r2j, ci, cj = [], [], [], [], [], []
    used = 0
    for i, j in pairs:
        s = pair_samples(copies[i], copies[j], rotations[i], rotations[j], rng)
        if s is None:
            continue
        pa, pb, ca, cb = s
        used += 1
        ii.append(np.full(len(pa), i))
        jj.append(np.full(len(pa), j))
        r2i.append(_radius2(pa, w, h))
        r2j.append(_radius2(pb, w, h))
        ci.append(ca)
        cj.append(cb)
    prior = exposure_log_gains(evs)
    views = [[round(float(v), 6) for v in r[:, 2]] for r in rotations]
    if not ii:
        light = Light([[float(p)] * 3 for p in prior], [0.0, 0.0, 0.0], views, 1.0, 0, 0)
        light.white = _white(light, copies, rotations)
        return light
    ii_, jj_ = np.concatenate(ii), np.concatenate(jj)
    r2i_, r2j_ = np.concatenate(r2i), np.concatenate(r2j)
    li = np.log(np.maximum(np.concatenate(ci), 1e-4))
    lj = np.log(np.maximum(np.concatenate(cj), 1e-4))
    # basis of the falloff difference, (m, 3)
    dv = np.column_stack([r2i_ - r2j_, r2i_**2 - r2j_**2, r2i_**3 - r2j_**3])

    def residuals(x):
        g = x[: 3 * n].reshape(n, 3)
        c = x[3 * n :]
        # log I_i - log g_i - log V_i = log I_j - log g_j - log V_j  (= log L)
        r = (li - g[ii_]) - (lj - g[jj_]) - (dv @ c)[:, None]
        rp = EXPOSURE_PRIOR * (g.mean(axis=1) - prior)
        rc = CHANNEL_PRIOR * (g - g.mean(axis=1, keepdims=True)).ravel()
        return np.concatenate([r.ravel(), rp, rc])

    x0 = np.concatenate([np.repeat(prior, 3), np.zeros(3)])
    sol = least_squares(residuals, x0, loss="soft_l1", f_scale=LOSS_SCALE, x_scale=1.0, max_nfev=100)
    g = sol.x[: 3 * n].reshape(n, 3)
    c = sol.x[3 * n :]
    # a falloff that brightens the corners, or darkens them past the clamp, is no lens: drop it
    corner = float(np.exp(_log_falloff(c, np.array([1.0])))[0])
    if not (1 - MAX_FALLOFF) <= corner <= 1.0 + 1e-3:
        c = np.zeros(3)
    g -= np.median(g.mean(axis=1) - prior)  # the median frame keeps its EXIF exposure
    light = Light(g.round(5).tolist(), [round(float(v), 5) for v in c], views, 1.0, len(ii_), used)
    light.white = _white(light, copies, rotations)
    return light


def _evened(lin: np.ndarray, light: Light, k: int, rot: np.ndarray, f: float) -> np.ndarray:
    """In place: linear light of frame k divided by its gain and the falloff, times the smooth
    exposure of where it looks."""
    h, w = lin.shape[:2]
    lin *= exposure_map(light, rot, f, w, h, falloff=True)[..., None]
    lin *= np.exp(-np.asarray(light.log_gains[k], np.float32))[None, None]
    return lin


def _white(light: Light, copies: list[_Copy], rotations: list[np.ndarray]) -> float:
    """The radiance the tone curve brings to white: a high percentile of the evened luminance of
    every frame, never below 1 (a sphere that fits keeps its exposure)."""
    vals = []
    for k, cp in enumerate(copies):
        even = _evened(cp.lin.copy(), light, k, rotations[k], cp.f)
        vals.append(even.max(axis=2).ravel())
    if not vals:
        return 1.0
    return max(1.0, float(np.percentile(np.concatenate(vals), WHITE_PERCENTILE)))


def tone(lin: np.ndarray, white: float) -> np.ndarray:
    """In place where it can: radiance above the knee is compressed so `white` lands on 1."""
    if white <= 1.0 + 1e-6:
        return lin
    k = KNEE
    over = lin > k
    if over.any():
        x = (lin[over] - k) / (white - k)  # 0..1 over the compressed range (more above white)
        # a smooth shoulder with slope 1 at the knee: y = k + (1 - k) * (1 - exp(-a x)) / (1 - exp(-a))
        a = _shoulder(white)
        lin[over] = k + (1 - k) * (1 - np.exp(-a * x)) / (1 - math.exp(-a))
    return lin


def _shoulder(white: float) -> float:
    """The shoulder's steepness a, so that the curve leaves the knee with slope 1."""
    k = KNEE
    target = (white - k) / (1 - k)  # slope 1 at x = 0 means a / (1 - e^-a) == target
    lo, hi = 1e-6, 50.0
    for _ in range(60):
        mid = (lo + hi) / 2
        if mid / (1 - math.exp(-mid)) < target:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def apply(img: np.ndarray, light: Light, k: int, rot: np.ndarray, f: float) -> np.ndarray:
    """A frame (8-bit BGR, any scale; f its focal length at that scale) evened to the sphere's
    exposure and mapped back to 8 bits."""
    return to_srgb(tone(_evened(to_linear(img), light, k, rot, f), light.white))
