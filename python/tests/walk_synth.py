"""A synthetic 360 walk with a known path: a two-stream fisheye MP4 plus an Insta360 trailer.

``make_synth_walk`` renders a textured 12 x 8 x 3 m box room through two back-to-back equidistant
195 degree fisheye lenses along a known path, encodes each lens as its own H.264 stream of one MP4
and appends a synthetic trailer (``walk_trailer_synth.write_trailer``) whose motion samples come
from the true orientation. The truth comes back with it, so the ``walk.process`` tests can compare.

Conventions (the pipeline tests compare against these):

- **World frame**: z up, the room spans ``ROOM_MIN`` to ``ROOM_MAX`` (x -6..6, y -4..4, z 0..3 m,
  floor at z = 0). The camera starts at ``START`` = (-4.5, -3, 1.6).
- **Camera frame**: x right, y down, z forward. ``truth_q`` is camera to world, ``(w, x, y, z)``.
  ``R = Rz(yaw) @ R_BASE @ Rx(pitch) @ Rz(roll)`` with ``R_BASE`` the level camera at yaw 0
  (camera x on world x, forward on world +y, down on world -z); yaw about world z (positive turns
  left), pitch about camera x (positive lifts the forward axis), roll about camera z.
- **Path**: stand ``standing_s`` (level, yaw 0, still), then walk at 1.2 m/s (speed eased in over
  ``RAMP_S``): 40 % of the walked length along +y, a right turn of radius up to ``TURN_RADIUS`` to
  +x (yaw 0 to -90 degrees), the rest along +x. While walking the camera bobs up and down at
  ``STEP_HZ`` (0.15 g peak) and pitch and roll wobble ``WOBBLE_DEG`` at ``STEP_HZ``.
- **Lenses**: lens 0 looks along camera +z and is the FIRST video stream; lens 1 looks along -z
  and is the SECOND. Image x right is camera +x for lens 0 and camera -x for lens 1; image y down
  is camera +y for both. Equidistant: ``r = f * theta``, ``f = radius / (fov / 2)``, fov 195
  degrees. Pixel (u, v) (integer column, row) has its centre at (u + 0.5, v + 0.5) in the
  coordinates of ``cx, cy``. Lens 0 is centred (``lens_px / 2``), lens 1 sits ``LENS1_SHIFT``
  pixels off centre; both have ``radius = lens_px / 2``. Outside the circle is black.
- **Offset string**: written for a 5760 x 2880 sensor (two 2880 x 2880 lenses, no window crop) so
  ``calib.parse_offset(offset, lens_px, lens_px)`` gives back the lenses rendered, yaw, pitch and
  roll 0.
- **Motion samples**: 1 kHz from t = 0 (the first frame) to ``seconds``, camera frame. Gyro: the
  true angular rate in the camera frame plus ``gyro_bias`` and noise. Accelerometer (g): the
  specific force (world up + the path's acceleration / 9.81) in the camera frame plus noise, so a
  level camera at rest reads (0, -1, 0). Frame times are ``k / fps``.

Generation is cached under ``python/.pytest_cache/d/walk-synth`` keyed by the parameters and this
file's source; ``build_synth_walk`` always renders afresh.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import shutil
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

from aio_pipelines.walk.trailer import Imu
from walk_trailer_synth import write_trailer

ROOM_MIN = (-6.0, -4.0, 0.0)
ROOM_MAX = (6.0, 4.0, 3.0)
START = (-4.5, -3.0, 1.6)
SPEED = 1.2  # m/s
RAMP_S = 0.6  # speed eased in over this long
TURN_RADIUS = 0.6
STEP_HZ = 1.8
BOUNCE_G = 0.15
WOBBLE_DEG = 4.0
FOV_DEG = 195.0
LENS1_SHIFT = (3.0, -2.0)  # pixels at 640, scaled with lens_px
SENSOR_LENS = 2880.0  # sensor pixels per lens side in the offset string
IMU_HZ = 1000
GYRO_BIAS = (0.01, -0.01, 0.01)  # rad/s
ACC_NOISE = 0.01  # g
GYRO_NOISE = 0.003  # rad/s
PX_PER_M = 64.0  # texture density
CAMERA = "X4"

# Dark boxes standing on the floor, (min corner, max corner): clear of the path. Box 0 stands
# against the +y wall straight ahead of the start.
BOXES = (
    ((-5.0, 3.3, 0.0), (-4.0, 4.0, 1.2)),
    ((4.5, -3.5, 0.0), (5.6, -2.3, 0.9)),
    ((0.5, 3.0, 0.0), (1.5, 4.0, 2.0)),
    ((-5.8, -1.0, 0.0), (-5.2, 0.5, 1.5)),
)
BOX_SHADE = (0.10, 0.16, 0.06)  # by the axis of the face hit (x, y, z)
# Face ids: 0 x-min, 1 x-max, 2 y-min, 3 y-max, 4 floor, 5 ceiling, 6 + i box i, -1 outside.
FLAT_SHADE = (0.55, 0.62, 0.68, 0.74, 0.42, 0.85)
FACE_GAIN = (0.92, 1.0, 0.96, 0.9, 0.8, 1.05)
_FACE_AXES = {0: (1, 2), 1: (0, 2), 2: (0, 1)}  # the two in-face axes of each normal axis

R_BASE = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0]])


@dataclass
class SynthWalk:
    path: Path  # the two-stream .insv-like MP4 with trailer
    truth_t: np.ndarray  # frame times
    truth_pos: np.ndarray  # (n, 3) metres
    truth_q: np.ndarray  # (n, 4) camera to world wxyz
    lens: tuple[float, float, float]  # cx, cy, radius used (lens 0)
    offset: str  # the offset string written
    lenses: tuple[tuple[float, float, float], tuple[float, float, float]] = ((0, 0, 0), (0, 0, 0))
    gyro_bias: tuple[float, float, float] = GYRO_BIAS


# ------------------------------------------------------------------------------------- rotations


def _rz(a: np.ndarray) -> np.ndarray:
    c, s, z, o = np.cos(a), np.sin(a), np.zeros_like(a), np.ones_like(a)
    return np.stack([np.stack([c, -s, z], -1), np.stack([s, c, z], -1), np.stack([z, z, o], -1)], -2)


def _rx(a: np.ndarray) -> np.ndarray:
    c, s, z, o = np.cos(a), np.sin(a), np.zeros_like(a), np.ones_like(a)
    return np.stack([np.stack([o, z, z], -1), np.stack([z, c, -s], -1), np.stack([z, s, c], -1)], -2)


def matrix_to_rotvec(R: np.ndarray) -> np.ndarray:
    """Log map, vectorised over leading axes (angles below pi)."""
    R = np.asarray(R, dtype=np.float64)
    cos = np.clip((np.trace(R, axis1=-2, axis2=-1) - 1.0) / 2.0, -1.0, 1.0)
    angle = np.arccos(cos)
    vee = np.stack(
        [R[..., 2, 1] - R[..., 1, 2], R[..., 0, 2] - R[..., 2, 0], R[..., 1, 0] - R[..., 0, 1]], -1
    )
    sin = np.sin(angle)
    scale = np.where(sin > 1e-9, angle / np.maximum(2.0 * sin, 1e-300), 0.5)
    return vee * scale[..., None]


def rotvec_to_matrix(r: np.ndarray) -> np.ndarray:
    r = np.asarray(r, dtype=np.float64)
    a = float(np.linalg.norm(r))
    k = np.array([[0.0, -r[2], r[1]], [r[2], 0.0, -r[0]], [-r[1], r[0], 0.0]])
    if a < 1e-12:
        return np.eye(3) + k
    k /= a
    return np.eye(3) + math.sin(a) * k + (1.0 - math.cos(a)) * (k @ k)


def matrix_to_quat(R: np.ndarray) -> np.ndarray:
    """(n, 3, 3) to (n, 4) wxyz with w >= 0."""
    R = np.asarray(R, dtype=np.float64).reshape(-1, 3, 3)
    q = np.empty((len(R), 4))
    for i, m in enumerate(R):
        tr = m[0, 0] + m[1, 1] + m[2, 2]
        if tr > 0:
            s = 2.0 * math.sqrt(tr + 1.0)
            q[i] = [0.25 * s, (m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s]
        elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
            s = 2.0 * math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2])
            q[i] = [(m[2, 1] - m[1, 2]) / s, 0.25 * s, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s]
        elif m[1, 1] > m[2, 2]:
            s = 2.0 * math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2])
            q[i] = [(m[0, 2] - m[2, 0]) / s, (m[0, 1] + m[1, 0]) / s, 0.25 * s, (m[1, 2] + m[2, 1]) / s]
        else:
            s = 2.0 * math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1])
            q[i] = [(m[1, 0] - m[0, 1]) / s, (m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, 0.25 * s]
    q /= np.linalg.norm(q, axis=1, keepdims=True)
    q[q[:, 0] < 0] *= -1
    return q


def quat_to_matrix(q: np.ndarray) -> np.ndarray:
    w, x, y, z = np.asarray(q, dtype=np.float64)
    return np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
            [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
            [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
        ]
    )


# ------------------------------------------------------------------------------------------ path


@dataclass(frozen=True)
class Path3:
    """The true motion as functions of time (vectorised)."""

    seconds: float
    standing_s: float

    @property
    def length(self) -> float:
        return float(self.arc(np.array([self.seconds]))[0])

    @property
    def leg1(self) -> float:
        return 0.4 * self.length

    @property
    def radius(self) -> float:
        return max(1e-3, min(TURN_RADIUS, 0.5 * self.leg1))

    def ease(self, t: np.ndarray) -> np.ndarray:
        """0 standing, 1 at full speed; smootherstep over RAMP_S."""
        x = np.clip((np.asarray(t, dtype=np.float64) - self.standing_s) / RAMP_S, 0.0, 1.0)
        return x**3 * (x * (6 * x - 15) + 10)

    def arc(self, t: np.ndarray) -> np.ndarray:
        """Distance walked (horizontal) at t."""
        t = np.asarray(t, dtype=np.float64)
        x = np.clip((t - self.standing_s) / RAMP_S, 0.0, 1.0)
        ramp = RAMP_S * (x**6 - 3 * x**5 + 2.5 * x**4)
        after = np.maximum(t - self.standing_s - RAMP_S, 0.0)
        return SPEED * (ramp + after)

    def pose(self, t: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Positions (n, 3) and camera-to-world rotations (n, 3, 3) at times t."""
        t = np.atleast_1d(np.asarray(t, dtype=np.float64))
        s = self.arc(t)
        rc, l1 = self.radius, self.leg1
        straight1 = l1 - rc
        turn_len = 0.5 * math.pi * rc
        x0, y0, z0 = START
        alpha = np.clip((s - straight1) / rc, 0.0, 0.5 * math.pi)
        after = np.maximum(s - straight1 - turn_len, 0.0)
        on1 = s <= straight1
        px = np.where(on1, x0, x0 + rc - rc * np.cos(alpha) + after)
        py = np.where(on1, y0 + s, y0 + straight1 + rc * np.sin(alpha))
        w = self.ease(t)
        phase = 2 * math.pi * STEP_HZ * np.maximum(t - self.standing_s, 0.0)
        amp = BOUNCE_G * 9.80665 / (2 * math.pi * STEP_HZ) ** 2
        pz = z0 + amp * w * np.sin(phase)
        yaw = np.where(on1, 0.0, -alpha)
        wob = math.radians(WOBBLE_DEG) * w
        pitch = wob * np.sin(phase)
        roll = wob * np.sin(phase + 1.0)
        R = _rz(yaw) @ R_BASE @ _rx(pitch) @ _rz(roll)
        return np.stack([px, py, pz], -1), R


def synth_motion(path: Path3, seconds: float, seed: int) -> Imu:
    """1 kHz motion samples from the true path (camera frame), with noise and the gyro bias."""
    n = round(seconds * IMU_HZ)
    t = np.arange(n) / IMU_HZ
    h = 1e-3
    p_m, R_m = path.pose(t - h)
    p_0, R_0 = path.pose(t)
    p_p, R_p = path.pose(t + h)
    acc_world = (p_p - 2 * p_0 + p_m) / (h * h) / 9.80665
    force = acc_world + np.array([0.0, 0.0, 1.0])
    acc = np.einsum("nji,nj->ni", R_0, force)  # R^T f
    gyro = matrix_to_rotvec(np.swapaxes(R_m, -1, -2) @ R_p) / (2 * h)
    rng = np.random.default_rng([seed, 1])
    acc = acc + rng.normal(0.0, ACC_NOISE, acc.shape)
    gyro = gyro + np.array(GYRO_BIAS) + rng.normal(0.0, GYRO_NOISE, gyro.shape)
    return Imu(t=t, acc=acc, gyro=gyro)


# ----------------------------------------------------------------------------------------- scene


def _noise_texture(rng: np.random.Generator, w_m: float, h_m: float) -> np.ndarray:
    W, H = math.ceil(w_m * PX_PER_M), math.ceil(h_m * PX_PER_M)
    tex = np.zeros((H, W), np.float32)
    amp = 1.0
    for per_m in (0.5, 1, 2, 4, 8, 16):
        gw, gh = max(2, math.ceil(w_m * per_m) + 1), max(2, math.ceil(h_m * per_m) + 1)
        g = rng.random((gh, gw)).astype(np.float32)
        tex += amp * np.asarray(Image.fromarray(g, mode="F").resize((W, H), Image.BICUBIC), np.float32)
        amp *= 0.65
    tex = (tex - tex.min()) / (np.ptp(tex) + 1e-6)
    tex = 0.3 + 0.65 * tex
    for _ in range(int(w_m * h_m * 4)):  # dark blobs and squares: corners at every scale
        cx, cy, r = int(rng.integers(0, W)), int(rng.integers(0, H)), int(rng.integers(3, 15))
        x0, x1, y0, y1 = max(cx - r, 0), min(cx + r + 1, W), max(cy - r, 0), min(cy + r + 1, H)
        if rng.random() < 0.5:
            yy, xx = np.mgrid[y0:y1, x0:x1]
            sel = (xx - cx) ** 2 + (yy - cy) ** 2 <= r * r
            tex[y0:y1, x0:x1][sel] *= 0.3
        else:
            tex[y0:y1, x0:x1] *= 0.35
    return tex


class Scene:
    """The room's faces as grey textures (or flat shades), and the boxes (textured only)."""

    def __init__(self, seed: int = 7, textured: bool = True):
        lo, hi = np.array(ROOM_MIN), np.array(ROOM_MAX)
        size = hi - lo
        self.lo, self.hi = lo, hi
        self.textured = textured
        self.boxes = [(np.array(a), np.array(b)) for a, b in BOXES] if textured else []
        rng = np.random.default_rng(seed)
        self.tex: list[np.ndarray] = []
        for f in range(6):
            a, b = _FACE_AXES[f // 2]
            if textured:
                tex = np.clip(_noise_texture(rng, size[a], size[b]) * FACE_GAIN[f], 0, 1)
            else:
                tex = np.full((2, 2), FLAT_SHADE[f], np.float32)
            self.tex.append(np.round(10 + 235 * tex).astype(np.uint8))

    def shade(self, o: np.ndarray, d: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Grey value and face id along rays from ``o`` (inside the room) in directions ``d``
        ((3, m) float32, one row per world axis)."""
        o = np.asarray(o, dtype=np.float64)
        m = d.shape[1]
        t = np.full(m, np.inf, np.float32)
        face = np.zeros(m, np.int16)
        inv = []
        with np.errstate(divide="ignore", invalid="ignore"):
            for a in range(3):
                inv_a = np.float32(1.0) / d[a]
                inv.append(inv_a)
                pos = d[a] > 0
                ta = np.where(pos, np.float32(self.hi[a] - o[a]), np.float32(self.lo[a] - o[a])) * inv_a
                ta[~(ta > 0)] = np.inf  # zero direction components give nan or inf
                closer = ta < t
                t = np.where(closer, ta, t)
                face = np.where(closer, (2 * a + pos).astype(np.int16), face)
        hit = [np.float32(o[a]) + d[a] * t for a in range(3)]
        val = np.zeros(m, np.uint8)
        scale = PX_PER_M if self.textured else 0.0
        for f in range(6):
            sel = face == f
            if not sel.any():
                continue
            a, b = _FACE_AXES[f // 2]
            tex = self.tex[f]
            u = np.clip(((hit[a][sel] - self.lo[a]) * scale).astype(np.int64), 0, tex.shape[1] - 1)
            v = np.clip(((hit[b][sel] - self.lo[b]) * scale).astype(np.int64), 0, tex.shape[0] - 1)
            val[sel] = tex[v, u]
        shades = np.round(10 + 235 * np.array(BOX_SHADE)).astype(np.uint8)
        for i, (bmin, bmax) in enumerate(self.boxes):
            near = np.full(m, -np.inf, np.float32)
            far = np.full(m, np.inf, np.float32)
            near_ax = np.zeros(m, np.int8)
            with np.errstate(divide="ignore", invalid="ignore"):
                for a in range(3):
                    t1 = np.float32(bmin[a] - o[a]) * inv[a]
                    t2 = np.float32(bmax[a] - o[a]) * inv[a]
                    tn = np.minimum(t1, t2)
                    far = np.minimum(far, np.maximum(t1, t2))
                    later = tn > near
                    near = np.where(later, tn, near)
                    near_ax[later] = a
            sel = (near <= far) & (near > 0) & (near < t)
            if not sel.any():
                continue
            t[sel] = near[sel]
            face[sel] = 6 + i
            val[sel] = shades[near_ax[sel]]
        return val, face


# ----------------------------------------------------------------------------------------- lenses


def lens_rays(lens: tuple[float, float, float], which: int, size: int) -> tuple[np.ndarray, np.ndarray]:
    """Flat indices of the pixels inside the 195 degree circle and their rays in the camera frame
    ((3, m), one row per camera axis)."""
    cx, cy, radius = lens
    f = radius / math.radians(FOV_DEG / 2)
    v, u = np.mgrid[0:size, 0:size]
    dx, dy = u.ravel() + 0.5 - cx, v.ravel() + 0.5 - cy
    r = np.hypot(dx, dy)
    theta = r / f
    inside = theta <= math.radians(FOV_DEG / 2)
    idx = np.flatnonzero(inside)
    r, theta, dx, dy = r[idx], theta[idx], dx[idx], dy[idx]
    sin_over_r = np.where(r > 0, np.sin(theta) / np.maximum(r, 1e-12), 1.0 / f)
    lx, ly, lz = dx * sin_over_r, dy * sin_over_r, np.cos(theta)
    rays = np.stack([lx, ly, lz] if which == 0 else [-lx, ly, -lz])
    return idx, rays.astype(np.float32)  # (3, m)


def project(lens: tuple[float, float, float], which: int, v_cam: np.ndarray) -> tuple[float, float]:
    """Pixel coordinates (continuous, centre of pixel u at u + 0.5) of a camera-frame direction;
    index the image with ``round(u - 0.5)`` or approximately ``round(u)``."""
    cx, cy, radius = lens
    x, y, z = np.asarray(v_cam, dtype=np.float64)
    if which == 1:
        x, z = -x, -z
    theta = math.atan2(math.hypot(x, y), z)
    phi = math.atan2(y, x)
    r = radius / math.radians(FOV_DEG / 2) * theta
    return cx + r * math.cos(phi), cy + r * math.sin(phi)


def render_lens(
    scene: Scene,
    lens: tuple[float, float, float],
    which: int,
    size: int,
    pos: np.ndarray,
    R: np.ndarray,
    rays: tuple[np.ndarray, np.ndarray] | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """One lens image (size x size uint8 grey) and its face ids (-1 outside the circle)."""
    idx, cam = rays if rays is not None else lens_rays(lens, which, size)
    d = np.asarray(R, dtype=np.float32) @ cam
    val, face = scene.shade(np.asarray(pos, dtype=np.float64), d)
    img = np.zeros(size * size, np.uint8)
    img[idx] = val
    ids = np.full(size * size, -1, np.int16)
    ids[idx] = face
    return img.reshape(size, size), ids.reshape(size, size)


def lens_params(lens_px: int) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
    c, r = lens_px / 2.0, lens_px / 2.0
    k = lens_px / 640.0
    return (c, c, r), (c + LENS1_SHIFT[0] * k, c + LENS1_SHIFT[1] * k, r)


def offset_string(lens_px: int) -> str:
    """The offset string of the lenses, for a 2 x 2880 by 2880 sensor (no window crop)."""
    k = SENSOR_LENS / lens_px
    parts = ["2"]
    for i, (cx, cy, r) in enumerate(lens_params(lens_px)):
        parts += [
            f"{r * k:.3f}",
            f"{cx * k + i * SENSOR_LENS:.3f}",
            f"{cy * k:.3f}",
            "0.000",
            "0.000",
            "0.000",
        ]
    parts += [f"{2 * SENSOR_LENS:.0f}", f"{SENSOR_LENS:.0f}", "0"]
    return "_".join(parts)


# ----------------------------------------------------------------------------------------- ffmpeg


def find_ffmpeg() -> str | None:
    env = os.environ.get("QUADRION_FFMPEG")
    if env and Path(env).is_file():
        return env
    return shutil.which("ffmpeg")


def _encoder(ffmpeg: str, size: int, fps: int, out: Path) -> subprocess.Popen:
    cmd = [
        ffmpeg, "-v", "error", "-y",
        "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{size}x{size}", "-r", str(fps), "-i", "-",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-g", str(fps), "-pix_fmt", "yuv420p",
        "-threads", "2", "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact",
        str(out),
    ]  # fmt: skip
    return subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)


def _finish(proc: subprocess.Popen) -> None:
    assert proc.stdin is not None and proc.stderr is not None
    proc.stdin.close()
    err = proc.stderr.read()
    if proc.wait() != 0:
        raise RuntimeError(f"ffmpeg failed: {err.decode(errors='replace')[-2000:]}")


# ------------------------------------------------------------------------------------------ build


def build_synth_walk(
    out_dir: Path,
    *,
    seconds: float = 12.0,
    fps: int = 15,
    lens_px: int = 640,
    textured: bool = True,
    standing_s: float = 2.0,
    trailer: bool = True,
    seed: int = 7,
) -> SynthWalk:
    """Render, encode and write the walk into ``out_dir`` (no cache)."""
    ffmpeg = find_ffmpeg()
    if ffmpeg is None:
        raise RuntimeError("ffmpeg not found (QUADRION_FFMPEG or PATH)")
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    path3 = Path3(seconds=seconds, standing_s=standing_s)
    n = round(seconds * fps)
    truth_t = np.arange(n) / fps
    truth_pos, truth_R = path3.pose(truth_t)
    lo, hi = np.array(ROOM_MIN), np.array(ROOM_MAX)
    if np.any(truth_pos < lo + 0.5) or np.any(truth_pos > hi - 0.5):
        raise ValueError(f"a {seconds} s walk leaves the room; shorten it")
    lenses = lens_params(lens_px)
    scene = Scene(seed=seed, textured=textured)
    rays = [lens_rays(lenses[i], i, lens_px) for i in range(2)]

    target = out_dir / "VID_20261012_120000_00_001.insv"
    with tempfile.TemporaryDirectory(dir=out_dir) as tmp:
        parts = [Path(tmp) / f"lens{i}.mp4" for i in range(2)]
        encoders = [_encoder(ffmpeg, lens_px, fps, p) for p in parts]

        def frame(k: int) -> list[bytes]:
            return [
                render_lens(scene, lenses[i], i, lens_px, truth_pos[k], truth_R[k], rays[i])[0].tobytes()
                for i in range(2)
            ]

        try:
            with ThreadPoolExecutor(max_workers=min(4, os.cpu_count() or 1)) as pool:
                for images in pool.map(frame, range(n)):  # numpy releases the GIL; order is kept
                    for enc, img in zip(encoders, images, strict=True):
                        assert enc.stdin is not None
                        enc.stdin.write(img)
        finally:
            for enc in encoders:
                _finish(enc)
        muxed = Path(tmp) / "walk.mp4"
        subprocess.run(
            [
                ffmpeg, "-v", "error", "-y", "-i", str(parts[0]), "-i", str(parts[1]),
                "-map", "0:v", "-map", "1:v", "-c", "copy", "-map_metadata", "-1",
                "-fflags", "+bitexact", str(muxed),
            ],
            check=True,
            capture_output=True,
        )  # fmt: skip
        offset = offset_string(lens_px)
        if trailer:
            imu = synth_motion(path3, seconds, seed)
            with muxed.open("ab") as f:
                write_trailer(f, camera=CAMERA, offset=offset, imu=imu, frame_times=truth_t)
        os.replace(muxed, target)

    return SynthWalk(
        path=target,
        truth_t=truth_t,
        truth_pos=truth_pos,
        truth_q=matrix_to_quat(truth_R),
        lens=lenses[0],
        offset=offset,
        lenses=lenses,
        gyro_bias=GYRO_BIAS,
    )


def _cache_root(out_dir: Path) -> Path:
    root = Path(__file__).resolve().parent.parent / ".pytest_cache" / "d" / "walk-synth"
    try:
        root.mkdir(parents=True, exist_ok=True)
        return root
    except OSError:
        return Path(out_dir) / ".walk-synth-cache"


def _cache_key(params: dict) -> str:
    h = hashlib.sha256(json.dumps(params, sort_keys=True).encode())
    here = Path(__file__).resolve().parent
    for name in ("walk_synth.py", "walk_trailer_synth.py"):
        h.update((here / name).read_bytes())
    return h.hexdigest()[:16]


def make_synth_walk(
    out_dir: Path,
    *,
    seconds: float = 12.0,
    fps: int = 15,
    lens_px: int = 640,
    textured: bool = True,
    standing_s: float = 2.0,
    trailer: bool = True,
    seed: int = 7,
) -> SynthWalk:
    """The walk, rendered once per parameter set (cached) and copied into ``out_dir``."""
    params = {
        "seconds": seconds,
        "fps": fps,
        "lens_px": lens_px,
        "textured": textured,
        "standing_s": standing_s,
        "trailer": trailer,
        "seed": seed,
    }
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    entry = _cache_root(out_dir) / _cache_key(params)
    video, truth = entry / "walk.insv", entry / "truth.npz"
    if not (video.is_file() and truth.is_file()):
        entry.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=entry) as tmp:
            w = build_synth_walk(Path(tmp), **params)
            np.savez(Path(tmp) / "truth.npz", t=w.truth_t, pos=w.truth_pos, q=w.truth_q)
            os.replace(Path(tmp) / "truth.npz", truth)
            os.replace(w.path, video)
    target = out_dir / "VID_20261012_120000_00_001.insv"
    shutil.copyfile(video, target)
    with np.load(truth) as z:
        t, pos, q = z["t"], z["pos"], z["q"]
    lenses = lens_params(lens_px)
    return SynthWalk(
        path=target,
        truth_t=t,
        truth_pos=pos,
        truth_q=q,
        lens=lenses[0],
        offset=offset_string(lens_px),
        lenses=lenses,
        gyro_bias=GYRO_BIAS,
    )


__all__ = ["SynthWalk", "build_synth_walk", "find_ffmpeg", "make_synth_walk"]
