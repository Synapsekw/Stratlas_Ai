"""Orientation, standing and steps from a walk's motion data (walk.process).

Inputs are plain arrays shaped like the trailer's ``Imu``: ``t`` (n,) in seconds, ``acc`` (n, 3) in g
and ``gyro`` (n, 3) in rad/s, both in the camera frame.

Conventions:

- **Camera frame**: x right, y down, z forward at the picture centre (yaw 0).
- **Gravity frame** ("world"): z up; x and y horizontal. A level camera at yaw 0 has its x axis on
  world x, its forward (z) axis on world y and its down (y) axis on world -z.
- **Quaternions** are ``(w, x, y, z)`` and rotate camera-frame vectors into the gravity frame:
  ``v_world = q v_cam q*``.
- **Accelerometer sign**: it measures specific force, the reaction to gravity, so a camera at rest
  reads +1 g pointing **up**: a level camera at rest reads ``(0, -1, 0)`` (up is -y). The filter
  compares the measured direction with the estimated up, ``R^T (0, 0, 1)``.
- **Yaw**: the first output's heading is zero, whatever way the camera faced: its forward axis
  (projected on the horizontal) starts on world +y. Later yaw is relative to that.

The orientation filter (decision 4) is a complementary filter: the gyro is integrated exactly per
sample (rate held at the interval's mean), and once per ~10 ms block the accelerometer, low-passed
in the gravity frame, pulls the estimated up towards the measured one with a small gain, reduced
while the acceleration magnitude is far from 1 g (steps, bumps). Gyro bias is not removed here: the caller subtracts
:func:`gyro_bias` (first standing stretch, else the walk's median rate) before calling
:func:`orientation`.
"""

from __future__ import annotations

import bisect
import math
from pathlib import Path

import numpy as np

# Level camera at yaw 0, camera to gravity frame.
R_BASE = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0]])
Q_BASE = np.array([math.sqrt(0.5), -math.sqrt(0.5), 0.0, 0.0])  # the same as a quaternion

STANDING_WINDOW_S = 0.5  # moving window of the acceleration magnitude's spread
BLOCK_S = 0.01  # gravity correction step of the filter
INIT_S = 1.0  # accelerometer average that sets the first tilt
GATE_G = 0.5  # magnitude error (g) at which the gravity correction is off
LOWPASS_S = 0.5  # time constant of the measured up, gravity frame
STEP_BAND_HZ = (1.2, 3.0)


# --- quaternion helpers (vectorised over leading axes) --------------------------------------


def quat_mul(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    aw, ax, ay, az = np.moveaxis(np.asarray(a, dtype=np.float64), -1, 0)
    bw, bx, by, bz = np.moveaxis(np.asarray(b, dtype=np.float64), -1, 0)
    return np.stack(
        [
            aw * bw - ax * bx - ay * by - az * bz,
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
        ],
        axis=-1,
    )


def quat_from_rotvec(r: np.ndarray) -> np.ndarray:
    r = np.asarray(r, dtype=np.float64)
    a = np.linalg.norm(r, axis=-1, keepdims=True)
    half = 0.5 * a
    # sin(a/2)/a, with its series near zero
    k = np.where(a > 1e-8, np.sin(half) / np.where(a > 1e-8, a, 1.0), 0.5 - a * a / 48.0)
    return np.concatenate([np.cos(half), r * k], axis=-1)


def quat_to_matrix(q: np.ndarray) -> np.ndarray:
    q = np.asarray(q, dtype=np.float64)
    w, x, y, z = np.moveaxis(q, -1, 0)
    m = np.empty((*q.shape[:-1], 3, 3))
    m[..., 0, 0] = 1 - 2 * (y * y + z * z)
    m[..., 0, 1] = 2 * (x * y - w * z)
    m[..., 0, 2] = 2 * (x * z + w * y)
    m[..., 1, 0] = 2 * (x * y + w * z)
    m[..., 1, 1] = 1 - 2 * (x * x + z * z)
    m[..., 1, 2] = 2 * (y * z - w * x)
    m[..., 2, 0] = 2 * (x * z - w * y)
    m[..., 2, 1] = 2 * (y * z + w * x)
    m[..., 2, 2] = 1 - 2 * (x * x + y * y)
    return m


def quat_from_matrix(m: np.ndarray) -> np.ndarray:
    """Rotation matrices (..., 3, 3) to unit quaternions (..., 4), w >= 0."""
    m = np.asarray(m, dtype=np.float64)
    flat = m.reshape(-1, 3, 3)
    out = np.empty((len(flat), 4))
    for i, r in enumerate(flat):
        tr = r[0, 0] + r[1, 1] + r[2, 2]
        if tr > 0:
            s = math.sqrt(tr + 1.0) * 2
            q = (0.25 * s, (r[2, 1] - r[1, 2]) / s, (r[0, 2] - r[2, 0]) / s, (r[1, 0] - r[0, 1]) / s)
        elif r[0, 0] > r[1, 1] and r[0, 0] > r[2, 2]:
            s = math.sqrt(1.0 + r[0, 0] - r[1, 1] - r[2, 2]) * 2
            q = ((r[2, 1] - r[1, 2]) / s, 0.25 * s, (r[0, 1] + r[1, 0]) / s, (r[0, 2] + r[2, 0]) / s)
        elif r[1, 1] > r[2, 2]:
            s = math.sqrt(1.0 + r[1, 1] - r[0, 0] - r[2, 2]) * 2
            q = ((r[0, 2] - r[2, 0]) / s, (r[0, 1] + r[1, 0]) / s, 0.25 * s, (r[1, 2] + r[2, 1]) / s)
        else:
            s = math.sqrt(1.0 + r[2, 2] - r[0, 0] - r[1, 1]) * 2
            q = ((r[1, 0] - r[0, 1]) / s, (r[0, 2] + r[2, 0]) / s, (r[1, 2] + r[2, 1]) / s, 0.25 * s)
        out[i] = q
    out /= np.linalg.norm(out, axis=1, keepdims=True)
    out[out[:, 0] < 0] *= -1
    return out.reshape(*m.shape[:-2], 4)


# --- resampling helpers ---------------------------------------------------------------------


def _uniform(t: np.ndarray) -> tuple[np.ndarray, float]:
    dt = float(np.median(np.diff(t))) if len(t) > 1 else 1.0
    n = max(1, math.floor((t[-1] - t[0]) / dt + 1e-9) + 1)
    return t[0] + np.arange(n) * dt, dt


def _moving_mean(x: np.ndarray, w: int) -> np.ndarray:
    """Centred moving mean over ``w`` samples (shrinking at the ends), along axis 0."""
    if w <= 1:
        return x.astype(np.float64)
    c = np.concatenate([np.zeros((1, *x.shape[1:])), np.cumsum(x, axis=0, dtype=np.float64)])
    n = len(x)
    i = np.arange(n)
    lo = np.clip(i - w // 2, 0, n)
    hi = np.clip(i - w // 2 + w, 0, n)
    cnt = (hi - lo).reshape(-1, *([1] * (x.ndim - 1)))
    return (c[hi] - c[lo]) / cnt


# --- standing, bias, steps ------------------------------------------------------------------


def standing_stretches(
    t: np.ndarray, acc: np.ndarray, min_s: float = 1.5, thresh_g: float = 0.03
) -> list[tuple[float, float]]:
    """Stretches ``(from, to)`` in seconds where the acceleration magnitude's moving standard
    deviation (0.5 s window) stays under ``thresh_g`` for ``min_s`` or longer."""
    t = np.asarray(t, dtype=np.float64)
    if len(t) < 3:
        return []
    mag = np.linalg.norm(np.asarray(acc, dtype=np.float64), axis=1) - 1.0
    dt = float(np.median(np.diff(t)))
    w = max(3, round(STANDING_WINDOW_S / dt))
    mean = _moving_mean(mag, w)
    var = np.maximum(_moving_mean(mag * mag, w) - mean * mean, 0.0)
    still = np.sqrt(var) < thresh_g
    # A centred window sees motion up to half a window away: grow each still run back by that.
    edges = np.diff(np.concatenate([[0], still.astype(np.int8), [0]]))
    starts = np.flatnonzero(edges == 1)
    ends = np.flatnonzero(edges == -1) - 1
    half = (w // 2) * dt
    out: list[tuple[float, float]] = []
    for s, e in zip(starts, ends, strict=True):
        a = max(float(t[0]), float(t[s]) - (half if s > 0 else 0.0))
        b = min(float(t[-1]), float(t[e]) + (half if e < len(t) - 1 else 0.0))
        if out and a <= out[-1][1]:
            a = out.pop()[0]
        out.append((a, b))
    return [(a, b) for a, b in out if b - a >= min_s]


def gyro_bias(t: np.ndarray, gyro: np.ndarray, standing: list[tuple[float, float]]) -> np.ndarray:
    """Gyro bias (3,) in rad/s: the median rate over the first standing stretch (its ends trimmed
    by 0.25 s when long enough); without one, the median rate over the whole walk (a walk's turns
    and sway roughly cancel, so the median is a usable estimate)."""
    t = np.asarray(t, dtype=np.float64)
    gyro = np.asarray(gyro, dtype=np.float64)
    for a, b in standing:
        if b - a > 1.0:
            a, b = a + 0.25, b - 0.25
        sel = (t >= a) & (t <= b)
        if np.count_nonzero(sel) >= 10:
            return np.median(gyro[sel], axis=0)
    return np.median(gyro, axis=0)


def step_times(t: np.ndarray, acc: np.ndarray) -> np.ndarray:
    """Step times in seconds: peaks of the acceleration magnitude band-passed to 1.2 to 3 Hz, at
    least 1/3.2 s apart, outside standing stretches."""
    t = np.asarray(t, dtype=np.float64)
    if len(t) < 4:
        return np.empty(0)
    acc = np.asarray(acc, dtype=np.float64)
    tu, dt = _uniform(t)
    mag = np.interp(tu, t, np.linalg.norm(acc, axis=1))
    mag -= np.median(mag)
    n = len(mag)
    pad = 1 << math.ceil(math.log2(n + int(4.0 / dt) + 1))
    spec = np.fft.rfft(mag, pad)
    f = np.fft.rfftfreq(pad, dt)
    lo, hi = STEP_BAND_HZ
    taper = 0.3  # Hz of raised-cosine edge on each side, so onsets do not ring
    gain = np.ones_like(f)
    gain[f < lo - taper] = 0
    gain[f > hi + taper] = 0
    rise = (f >= lo - taper) & (f < lo)
    gain[rise] = 0.5 - 0.5 * np.cos(np.pi * (f[rise] - (lo - taper)) / taper)
    fall = (f > hi) & (f <= hi + taper)
    gain[fall] = 0.5 + 0.5 * np.cos(np.pi * (f[fall] - hi) / taper)
    y = np.fft.irfft(spec * gain, pad)[:n]
    thr = max(0.02, 0.3 * float(np.percentile(y, 95)))
    cand = np.flatnonzero((y[1:-1] > y[:-2]) & (y[1:-1] >= y[2:]) & (y[1:-1] > thr)) + 1
    min_gap = 1.0 / (hi + 0.2)
    kept: list[float] = []  # sorted step times; the highest peaks claim their neighbourhood first
    for i in cand[np.argsort(-y[cand], kind="stable")]:
        ti = float(tu[i])
        k = bisect.bisect_left(kept, ti)
        if (k == 0 or ti - kept[k - 1] >= min_gap) and (k == len(kept) or kept[k] - ti >= min_gap):
            kept.insert(k, ti)
    steps = np.array(kept)
    for a, b in standing_stretches(t, acc):
        steps = steps[(steps < a) | (steps > b)]
    return steps


# --- orientation ----------------------------------------------------------------------------


def _initial(up: np.ndarray) -> np.ndarray:
    """Camera-to-gravity quaternion with ``up`` (camera frame) on world z and the camera's forward
    axis, projected on the horizontal, on world +y."""
    z = up / np.linalg.norm(up)
    y = np.array([0.0, 0.0, 1.0]) - z[2] * z
    if np.linalg.norm(y) < 1e-3:  # looking straight up or down: use the camera's up axis instead
        y = np.array([0.0, -1.0, 0.0]) - (-z[1]) * z
    y /= np.linalg.norm(y)
    x = np.cross(y, z)
    return quat_from_matrix(np.array([x, y, z]))  # rows: world axes in camera coordinates


def orientation(
    t: np.ndarray, acc: np.ndarray, gyro: np.ndarray, out_t: np.ndarray, gain: float = 0.02
) -> np.ndarray:
    """Camera-to-gravity-frame quaternions (len(out_t), 4), wxyz, at ``out_t`` (clamped to the
    data's span, interpolated between filter steps).

    ``gyro`` should already have its bias removed (:func:`gyro_bias`). ``gain`` is the classic
    complementary-filter weight of the accelerometer at 50 Hz: tilt errors decay with a time
    constant of ``0.02 / gain`` seconds (1 s at the default). The measured up is low-passed in the
    gravity frame (0.5 s) so walking accelerations, which average out there, barely tilt the
    estimate, and blocks whose acceleration magnitude is 0.5 g or more away from 1 g are ignored.
    The first tilt is the accelerometer averaged over the first second, each sample brought back
    to the first sample's camera frame by the gyro, so a swaying start does not skew it."""
    t = np.asarray(t, dtype=np.float64)
    acc = np.asarray(acc, dtype=np.float64)
    gyro = np.asarray(gyro, dtype=np.float64)
    out_t = np.asarray(out_t, dtype=np.float64)
    n = len(t)
    if n == 0:
        raise ValueError("no motion samples")
    if n == 1:
        up = acc[0] if np.linalg.norm(acc[0]) > 1e-6 else np.array([0.0, -1.0, 0.0])
        return np.tile(_initial(up), (len(out_t), 1))

    dt = float(np.median(np.diff(t)))
    blk = max(1, round(BLOCK_S / dt))
    m = n - 1  # intervals
    nb = -(-m // blk)
    # Per-interval rotation increments, rate held at the interval's mean.
    rates = 0.5 * (gyro[:-1] + gyro[1:])
    rv = np.zeros((nb * blk, 3))
    rv[:m] = rates * np.diff(t)[:, None]
    d = quat_from_rotvec(rv).reshape(nb, blk, 4)
    # Compose each block's increments (body frame, right multiplication), vectorised over blocks.
    while d.shape[1] > 1:
        if d.shape[1] % 2:
            d = np.concatenate([d, np.tile([1.0, 0.0, 0.0, 0.0], (nb, 1, 1))], axis=1)
        d = quat_mul(d[:, 0::2], d[:, 1::2])
    deltas = d[:, 0]

    starts = np.arange(nb) * blk
    ends = np.minimum(starts + blk, m)
    span = t[ends] - t[starts]
    a_mean = np.add.reduceat(acc, starts, axis=0) / np.diff(np.append(starts, n))[:, None]
    a_norm = np.linalg.norm(a_mean, axis=1)
    weight = np.clip(1.0 - np.abs(a_norm - 1.0) / GATE_G, 0.0, 1.0)
    a_unit = a_mean / np.where(a_norm > 1e-9, a_norm, 1.0)[:, None]

    # First tilt: block accelerations rotated back to the first block's camera frame.
    n_init = max(1, int(np.searchsorted(t[starts], t[0] + INIT_S)))
    rel = np.array([1.0, 0.0, 0.0, 0.0])
    up0 = np.zeros(3)
    for k in range(n_init):
        up0 += weight[k] * (quat_to_matrix(rel) @ a_unit[k])
        rel = quat_mul(rel, deltas[k])
    if np.linalg.norm(up0) < 1e-6:
        up0 = a_mean[:n_init].sum(axis=0)
    q0 = _initial(up0 if np.linalg.norm(up0) > 1e-6 else np.array([0.0, -1.0, 0.0]))

    kp = gain / 0.02
    lp = np.minimum(1.0, weight * span / LOWPASS_S).tolist()
    ck = (kp * span).tolist()
    dl = deltas.tolist()
    au = a_unit.tolist()

    qs = np.empty((nb + 1, 4))
    w, x, y, z = (float(v) for v in q0)
    qs[0] = w, x, y, z
    gx, gy, gz = 0.0, 0.0, 1.0  # low-passed measured up, gravity frame
    sqrt = math.sqrt
    sin = math.sin
    cos = math.cos
    for k in range(nb):
        # q <- q * delta (gyro, camera frame)
        bw, bx, by, bz = dl[k]
        w, x, y, z = (
            w * bw - x * bx - y * by - z * bz,
            w * bx + x * bw + y * bz - z * by,
            w * by - x * bz + y * bw + z * bx,
            w * bz + x * by - y * bx + z * bw,
        )
        a = lp[k]
        if a > 0.0:
            ax, ay, az = au[k]
            # measured up in the gravity frame: R a
            ux = (1 - 2 * (y * y + z * z)) * ax + 2 * (x * y - w * z) * ay + 2 * (x * z + w * y) * az
            uy = 2 * (x * y + w * z) * ax + (1 - 2 * (x * x + z * z)) * ay + 2 * (y * z - w * x) * az
            uz = 2 * (x * z - w * y) * ax + 2 * (y * z + w * x) * ay + (1 - 2 * (x * x + y * y)) * az
            gx += a * (ux - gx)
            gy += a * (uy - gy)
            gz += a * (uz - gz)
        # q <- r * q, r about the horizontal axis g x z that turns the measured up towards z
        c = ck[k]
        ex, ey = gy * c, -gx * c
        ang = sqrt(ex * ex + ey * ey)
        if ang > 1e-12:
            s = sin(0.5 * ang) / ang
            rw, rx_, ry_ = cos(0.5 * ang), ex * s, ey * s
            w, x, y, z = (
                rw * w - rx_ * x - ry_ * y,
                rw * x + rx_ * w + ry_ * z,
                rw * y - rx_ * z + ry_ * w,
                rw * z + rx_ * y - ry_ * x,
            )
        nrm = sqrt(w * w + x * x + y * y + z * z)
        w, x, y, z = w / nrm, x / nrm, y / nrm, z / nrm
        qs[k + 1] = w, x, y, z

    tb = np.append(t[starts], t[-1])
    # The block steps hold whole blocks; between them, interpolate (nlerp; steps are ~10 ms).
    ot = np.clip(out_t, t[0], t[-1])
    j = np.clip(np.searchsorted(tb, ot, side="right") - 1, 0, nb - 1)
    gap = tb[j + 1] - tb[j]
    f = np.where(gap > 0, (ot - tb[j]) / np.where(gap > 0, gap, 1.0), 0.0)
    qa, qb = qs[j], qs[j + 1]
    qb = np.where((np.sum(qa * qb, axis=1) < 0)[:, None], -qb, qb)
    q = qa * (1 - f)[:, None] + qb * f[:, None]
    return q / np.linalg.norm(q, axis=1, keepdims=True)


def level_rotation(q: np.ndarray) -> np.ndarray:
    """Per-sample (n, 3, 3) rotations that take camera-frame directions to the levelled frame: the
    same camera with pitch and roll removed and yaw kept (decision 3). A levelled picture samples
    the source at ``L.T @ d`` for each of its own directions ``d``.

    Yaw is the twist about world z of the camera's rotation relative to a level camera
    (swing-twist), so it stays defined when the camera points up or down."""
    q = np.atleast_2d(np.asarray(q, dtype=np.float64))
    rel = quat_mul(q, Q_BASE * np.array([1.0, -1.0, -1.0, -1.0]))  # q * base^-1, world rotation
    twist = np.zeros_like(rel)
    twist[:, 0] = rel[:, 0]
    twist[:, 3] = rel[:, 3]
    tn = np.linalg.norm(twist, axis=1, keepdims=True)
    twist = np.where(tn > 1e-9, twist / np.where(tn > 1e-9, tn, 1.0), [1.0, 0.0, 0.0, 0.0])
    r_level = quat_to_matrix(quat_mul(twist, Q_BASE))
    r = quat_to_matrix(q)
    return np.einsum("nji,njk->nik", r_level, r)  # R_level^T R


# --- rows -----------------------------------------------------------------------------------


def decimate(t: np.ndarray, acc: np.ndarray, gyro: np.ndarray, rate_hz: int = 200) -> np.ndarray:
    """(m, 7) float32 rows ``t, ax, ay, az, gx, gy, gz`` at ``rate_hz`` from the first sample,
    box-filtered over one output step before resampling."""
    t = np.asarray(t, dtype=np.float64)
    data = np.hstack([np.asarray(acc, dtype=np.float64), np.asarray(gyro, dtype=np.float64)])
    if len(t) == 0:
        return np.empty((0, 7), dtype=np.float32)
    src_dt = float(np.median(np.diff(t))) if len(t) > 1 else 1.0 / rate_hz
    w = max(1, round(1.0 / (rate_hz * src_dt)))
    smooth = _moving_mean(data, w)
    m = math.floor((t[-1] - t[0]) * rate_hz + 1e-6) + 1
    tt = t[0] + np.arange(m) / rate_hz
    rows = np.empty((m, 7), dtype=np.float64)
    rows[:, 0] = tt
    for c in range(6):
        rows[:, c + 1] = np.interp(tt, t, smooth[:, c])
    return rows.astype(np.float32)


def write_rows(path: Path, rows: np.ndarray) -> None:
    """Rows as float32 little endian, row-major, no header."""
    np.ascontiguousarray(rows, dtype="<f4").tofile(Path(path))
