"""Synthetic photogrammetry set for M10 (stream G8): drone photos of a known scene, with truth.

Everything here is seeded and procedural; no client file, name, place, camera serial or path. The
fictional site is open desert in UTM zone 39N (Rub' al Khali, hundreds of kilometres from any
surveyed site), see ``SITE``.

The scene (``Scene``) is a textured 2.5D terrain (gentle slopes, a stockpile of known volume, a
pit, a road), boxes (buildings, containers), two vertical cylinders (tanks) and a pipe rack. The
ground texture is seeded multi-scale hash noise with scattered pebbles, so features match like real
ground; a water-like low-texture area and rows of solar panels (a repetitive texture) test the
failure handling. Ten black-and-white checker targets are painted into the ground: five control
points, four checkpoints and a planted blunder (``GCP6``, its stated coordinate 1 m off).

The camera (``CAMERA``) is a 20 MP-class pinhole with radial-tangential distortion (OpenCV
``k1 k2 p1 p2 k3``), rendered at 1600 x 1200 for the quick set and 5280 x 3960 for the full set.
Flights: a nadir grid at 60 m with 80 % forward and 70 % side overlap, an oblique ring around the
large tank, and five deliberately bad images (motion blur, a duplicate, one from another place, a
corrupt JPEG, one without GPS).

Rendering is a vectorised CPU ray caster in numpy (no GPU, no OpenGL): analytic geometry (the
terrain is marched with a Lipschitz bound, so the first hit is exact; boxes and cylinders are solved
in closed form), Lambert shading with object shadows, 2 x 2 supersampling, then a seeded exposure
gain, vignetting and sensor noise, written as JPEG at a fixed quality. The same scene renders the
same pixels on Windows and macOS up to floating point in the last bits; ``truth.json`` is rounded so
it is identical everywhere.

Conventions (also written into ``truth.json``):

- World: the project CRS (EPSG:32639, easting and northing in metres) and ellipsoidal heights
  (WGS 84). The local frame used by ``Scene`` is ``x`` east, ``y`` north, ``z`` up, metres from
  ``SITE.origin``.
- Cameras: ``rotation`` is world-to-camera (rows are the camera axes in the local frame, OpenCV
  camera: x right, y down, z forward), ``X_cam = R (X - centre)``.
- Pixels: (0, 0) is the top-left corner of the top-left pixel, so its centre is (0.5, 0.5) (COLMAP
  and OPF).
- Gimbal angles (DJI): yaw clockwise from north, pitch from the horizon (-90 looks straight down),
  roll positive clockwise as seen from behind the camera.

Use it from tests through the session fixtures at the end of this module (``photo_set``,
``photo_set_rtk``, ``photo_mini``; registered in ``conftest.py``) or from the command line:

    uv run python tests/photo_synth.py --out <dir> [--seed 20261007] [--full] [--variant rtk]
                                       [--workers N] [--cache <dir>]
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import os
import struct
import sys
from collections.abc import Callable, Iterable
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image
from PIL.TiffImagePlugin import IFDRational

GENERATOR = "photo_synth/1"
RENDER_END = "# " + "=" * 69 + " end of the rendered part"
DEFAULT_SEED = 20261007
JPEG_QUALITY = 90
#: The mini set (the bundled demo) is stored smaller: its photos count against the installer budget.
MINI_JPEG_QUALITY = 75

# ----------------------------------------------------------------------------------------- site


@dataclass(frozen=True)
class Site:
    """The fictional site: open desert in UTM 39N. Heights are ellipsoidal (WGS 84)."""

    epsg: int = 32639
    origin: tuple[float, float, float] = (550000.0, 2330000.0, 142.0)
    name: str = "Synthetic photo site (fictional, open desert)"


SITE = Site()

# ------------------------------------------------------------------ UTM (Krueger series, WGS 84)

_A = 6378137.0
_F = 1 / 298.257223563
_K0 = 0.9996
_N = _F / (2 - _F)
_AA = _A / (1 + _N) * (1 + _N**2 / 4 + _N**4 / 64)
_ALPHA = (
    _N / 2 - 2 * _N**2 / 3 + 5 * _N**3 / 16 + 41 * _N**4 / 180,
    13 * _N**2 / 48 - 3 * _N**3 / 5 + 557 * _N**4 / 1440,
    61 * _N**3 / 240 - 103 * _N**4 / 140,
    49561 * _N**4 / 161280,
)
_BETA = (
    _N / 2 - 2 * _N**2 / 3 + 37 * _N**3 / 96 - _N**4 / 360,
    _N**2 / 48 + _N**3 / 15 - 437 * _N**4 / 1440,
    17 * _N**3 / 480 - 37 * _N**4 / 840,
    4397 * _N**4 / 161280,
)
_DELTA = (
    2 * _N - 2 * _N**2 / 3 - 2 * _N**3 + 116 * _N**4 / 45,
    7 * _N**2 / 3 - 8 * _N**3 / 5 - 227 * _N**4 / 45,
    56 * _N**3 / 15 - 136 * _N**4 / 35,
    4279 * _N**4 / 630,
)


def _zone(epsg: int) -> tuple[int, bool]:
    if 32601 <= epsg <= 32660:
        return epsg - 32600, False
    if 32701 <= epsg <= 32760:
        return epsg - 32700, True
    raise ValueError(f"EPSG:{epsg} is not a WGS 84 UTM zone")


def utm_to_lonlat(epsg: int, e: float, n: float) -> tuple[float, float]:
    """UTM to (longitude, latitude) in degrees, Krueger series to fourth order (sub-millimetre)."""
    zone, south = _zone(epsg)
    xi = (n - (10000000.0 if south else 0.0)) / (_K0 * _AA)
    eta = (e - 500000.0) / (_K0 * _AA)
    xp, ep = xi, eta
    for j, b in enumerate(_BETA, 1):
        xp -= b * math.sin(2 * j * xi) * math.cosh(2 * j * eta)
        ep -= b * math.cos(2 * j * xi) * math.sinh(2 * j * eta)
    chi = math.asin(math.sin(xp) / math.cosh(ep))
    lat = chi + sum(d * math.sin(2 * j * chi) for j, d in enumerate(_DELTA, 1))
    lon0 = math.radians(zone * 6 - 183)
    lon = lon0 + math.atan2(math.sinh(ep), math.cos(xp))
    return math.degrees(lon), math.degrees(lat)


def lonlat_to_utm(epsg: int, lon: float, lat: float) -> tuple[float, float]:
    """(longitude, latitude) in degrees to UTM easting and northing (Krueger series)."""
    zone, south = _zone(epsg)
    phi = math.radians(lat)
    dl = math.radians(lon) - math.radians(zone * 6 - 183)
    c = 2 * math.sqrt(_N) / (1 + _N)
    t = math.sinh(math.atanh(math.sin(phi)) - c * math.atanh(c * math.sin(phi)))
    xi_p = math.atan2(t, math.cos(dl))
    eta_p = math.atanh(math.sin(dl) / math.sqrt(1 + t * t))
    xi, eta = xi_p, eta_p
    for j, a in enumerate(_ALPHA, 1):
        xi += a * math.sin(2 * j * xi_p) * math.cosh(2 * j * eta_p)
        eta += a * math.cos(2 * j * xi_p) * math.sinh(2 * j * eta_p)
    return 500000.0 + _K0 * _AA * eta, (10000000.0 if south else 0.0) + _K0 * _AA * xi


def local_to_world(p: Iterable[float], site: Site = SITE) -> list[float]:
    x, y, z = p
    return [site.origin[0] + x, site.origin[1] + y, site.origin[2] + z]


def world_to_local(p: Iterable[float], site: Site = SITE) -> list[float]:
    e, n, h = p
    return [e - site.origin[0], n - site.origin[1], h - site.origin[2]]


# --------------------------------------------------------------------------------------- camera


@dataclass(frozen=True)
class Camera:
    """A pinhole camera with OpenCV radial-tangential distortion. Pixel (0, 0) is the top-left
    corner of the top-left pixel."""

    width: int
    height: int
    fx: float
    fy: float
    cx: float
    cy: float
    k1: float
    k2: float
    p1: float
    p2: float
    k3: float
    focal_mm: float  # nominal, as written in EXIF (fx is the calibrated truth)
    sensor_w_mm: float
    sensor_h_mm: float

    def scaled(self, width: int) -> Camera:
        """The same lens and sensor read out at another resolution (same aspect)."""
        s = width / self.width
        return replace(
            self,
            width=width,
            height=round(self.height * s),
            fx=self.fx * s,
            fy=self.fy * s,
            cx=self.cx * s,
            cy=self.cy * s,
        )

    def distort(self, x, y):
        r2 = x * x + y * y
        radial = 1 + r2 * (self.k1 + r2 * (self.k2 + r2 * self.k3))
        xd = x * radial + 2 * self.p1 * x * y + self.p2 * (r2 + 2 * x * x)
        yd = y * radial + self.p1 * (r2 + 2 * y * y) + 2 * self.p2 * x * y
        return xd, yd

    def undistort(self, xd, yd, iterations: int = 12):
        """Normalised distorted to undistorted coordinates (fixed point; the lens is mild)."""
        x, y = xd, yd
        for _ in range(iterations):
            dx, dy = self.distort(x, y)
            x = x + (xd - dx)
            y = y + (yd - dy)
        return x, y

    def r2_max(self) -> float:
        """Largest squared undistorted radius inside the frame (from the corners), beyond which the
        distortion polynomial folds back; projections past it are not in the photo."""
        us = np.array([0.0, self.width, 0.0, self.width, self.width / 2, 0.0])
        vs = np.array([0.0, 0.0, self.height, self.height, 0.0, self.height / 2])
        x, y = self.undistort((us - self.cx) / self.fx, (vs - self.cy) / self.fy)
        return float((x * x + y * y).max())

    def gsd_cm(self, distance_m: float) -> float:
        return 100 * distance_m / self.fx

    def to_json(self) -> dict[str, Any]:
        return {
            "model": "OPENCV_FULL_RADIAL",
            "note": "OpenCV k1 k2 p1 p2 k3; COLMAP FULL_OPENCV with k4..k6 = 0; OPF perspective",
            "width": self.width,
            "height": self.height,
            "fx": _r(self.fx, 6),
            "fy": _r(self.fy, 6),
            "cx": _r(self.cx, 6),
            "cy": _r(self.cy, 6),
            "k1": self.k1,
            "k2": self.k2,
            "p1": self.p1,
            "p2": self.p2,
            "k3": self.k3,
            "focalMm": self.focal_mm,
            "sensorWidthMm": self.sensor_w_mm,
            "sensorHeightMm": self.sensor_h_mm,
        }


# A 20 MP-class 4:3 drone camera (1-inch-type sensor read 4:3, 8.8 mm lens), full resolution.
CAMERA = Camera(
    width=5280,
    height=3960,
    fx=3527.4,
    fy=3527.4,
    cx=2640.0 + 9.9,
    cy=1980.0 - 6.6,
    k1=-0.0118,
    k2=0.0183,
    p1=0.00041,
    p2=-0.00027,
    k3=-0.0042,
    focal_mm=8.8,
    sensor_w_mm=13.2,
    sensor_h_mm=9.9,
)
QUICK_WIDTH = 1600
MINI_WIDTH = 960
MAKE = "Stratlas Synthetic"
MODEL = "SYN-20"

# ---------------------------------------------------------------------------------------- shots


def _r(v: float, d: int = 4) -> float:
    """Round for truth files, with -0.0 written as 0.0."""
    x = round(float(v), d)
    return 0.0 if x == 0 else x


def gimbal_rotation(yaw: float, pitch: float, roll: float) -> np.ndarray:
    """World-to-camera rotation (rows: camera x right, y down, z forward in the local frame) from
    DJI gimbal angles in degrees."""
    ps, th, ph = math.radians(yaw), math.radians(pitch), math.radians(roll)
    fwd = np.array([math.sin(ps) * math.cos(th), math.cos(ps) * math.cos(th), math.sin(th)])
    right = np.array([math.cos(ps), -math.sin(ps), 0.0])
    down = np.cross(fwd, right)
    r2 = math.cos(ph) * right + math.sin(ph) * down
    d2 = -math.sin(ph) * right + math.cos(ph) * down
    return np.array([r2, d2, fwd])


@dataclass
class Shot:
    """One photo: where the camera was (local frame) and how it looked."""

    name: str
    kind: str  # nadir, oblique, blurred, duplicate, outlier, corrupt, no-gps
    centre: np.ndarray
    yaw: float
    pitch: float
    roll: float
    taken_at: str
    expect: str = "register"  # register, reject, either
    reason: str | None = None
    line: int | None = None
    source: str | None = None  # the shot a duplicate copies
    scene_seed_offset: int = 0  # another place (outlier)
    blur_px: float = 0.0  # motion blur length at full resolution, along the image y axis
    extras: dict[str, Any] = field(default_factory=dict)

    @property
    def rotation(self) -> np.ndarray:
        return gimbal_rotation(self.yaw, self.pitch, self.roll)


def project(cam: Camera, shot: Shot, p_local) -> tuple[np.ndarray, np.ndarray]:
    """Pixel positions (n, 2) and depths (n,) of local points (n, 3) in a shot. Points behind the
    camera or far outside the frame (where the distortion polynomial folds back) get NaN pixels."""
    p = np.atleast_2d(np.asarray(p_local, dtype=np.float64))
    xc = (p - shot.centre) @ shot.rotation.T
    z = xc[:, 2]
    with np.errstate(divide="ignore", invalid="ignore"):
        x, y = xc[:, 0] / z, xc[:, 1] / z
        xd, yd = cam.distort(x, y)
    bad = (z <= 0) | (x * x + y * y > 1.1 * cam.r2_max())
    uv = np.stack([cam.fx * xd + cam.cx, cam.fy * yd + cam.cy], axis=1)
    uv[bad] = np.nan
    return uv, z


# ---------------------------------------------------------------------------------- hash noise

_OFF = 1 << 20


def _hash(ix: np.ndarray, iy: np.ndarray, seed: int) -> np.ndarray:
    """A float in [0, 1) per integer lattice point (uint32 arithmetic, the same everywhere)."""
    h = (ix + _OFF).astype(np.uint32) * np.uint32(0x8DA6B343)
    h ^= (iy + _OFF).astype(np.uint32) * np.uint32(0xD8163841)
    h ^= np.uint32(seed & 0xFFFFFFFF)
    h ^= h >> np.uint32(15)
    h *= np.uint32(0x2C1B3C6D)
    h ^= h >> np.uint32(12)
    h *= np.uint32(0x297A2D39)
    h ^= h >> np.uint32(15)
    return h.astype(np.float64) * (1.0 / 4294967296.0)


def value_noise(x: np.ndarray, y: np.ndarray, cell: float, seed: int) -> np.ndarray:
    """Smooth value noise in [0, 1) with lattice spacing ``cell`` metres."""
    fx = x / cell
    fy = y / cell
    ix = np.floor(fx)
    iy = np.floor(fy)
    tx = fx - ix
    ty = fy - iy
    ix = ix.astype(np.int64)
    iy = iy.astype(np.int64)
    sx = tx * tx * (3 - 2 * tx)
    sy = ty * ty * (3 - 2 * ty)
    a = _hash(ix, iy, seed)
    b = _hash(ix + 1, iy, seed)
    c = _hash(ix, iy + 1, seed)
    d = _hash(ix + 1, iy + 1, seed)
    return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy


def fbm(x, y, cells: Iterable[float], amps: Iterable[float], seed: int) -> np.ndarray:
    """Sum of value noise octaves, centred on 0."""
    out = np.zeros_like(x, dtype=np.float64)
    for k, (c, a) in enumerate(zip(cells, amps, strict=True)):
        out += a * (value_noise(x, y, c, seed * 7919 + k * 104729) - 0.5)
    return out


def _smoothstep(t):
    t = np.clip(t, 0.0, 1.0)
    return t * t * (3 - 2 * t)


# ------------------------------------------------------------------------------------ geometry

_INF = np.inf


class Primitive:
    """An analytic solid: ``intersect`` returns the ray parameter (inf on a miss) and the normal."""

    kind = "primitive"
    lo: np.ndarray
    hi: np.ndarray

    def corners(self) -> np.ndarray:
        lo, hi = self.lo, self.hi
        return np.array([[x, y, z] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])])

    def intersect(self, o: np.ndarray, d: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        raise NotImplementedError

    def albedo(self, p: np.ndarray, n: np.ndarray) -> np.ndarray:
        raise NotImplementedError

    def top(self, x: np.ndarray, y: np.ndarray) -> np.ndarray:
        """Highest surface over (x, y), or -inf outside."""
        raise NotImplementedError


class Box(Primitive):
    """A box standing on the ground, turned by ``yaw`` degrees about the vertical."""

    kind = "box"

    def __init__(self, name, cx, cy, sx, sy, z0, z1, yaw, colour, seed, roof=None, style="wall"):
        self.name, self.c, self.h = name, np.array([cx, cy]), np.array([sx / 2, sy / 2])
        self.z0, self.z1, self.yaw = z0, z1, yaw
        a = math.radians(yaw)
        # local axes: u along the box's x side, v along its y side
        self.ax = np.array([math.cos(a), math.sin(a)])
        self.ay = np.array([-math.sin(a), math.cos(a)])
        self.colour = np.array(colour, dtype=np.float64)
        self.roof = np.array(roof if roof is not None else colour, dtype=np.float64)
        self.seed, self.style = seed, style
        r = abs(self.h[0] * self.ax) + abs(self.h[1] * self.ay)
        self.lo = np.array([cx - r[0], cy - r[1], z0])
        self.hi = np.array([cx + r[0], cy + r[1], z1])
        self.size = (sx, sy, z1 - z0)

    def _local(self, x, y):
        dx, dy = x - self.c[0], y - self.c[1]
        return dx * self.ax[0] + dy * self.ax[1], dx * self.ay[0] + dy * self.ay[1]

    def intersect(self, o, d):
        ou, ov = self._local(o[0], o[1])
        du = d[:, 0] * self.ax[0] + d[:, 1] * self.ax[1]
        dv = d[:, 0] * self.ay[0] + d[:, 1] * self.ay[1]
        dz = d[:, 2]
        tn = np.full(len(d), -_INF)
        tf = np.full(len(d), _INF)
        face = np.zeros(len(d), dtype=np.int8)
        with np.errstate(divide="ignore", invalid="ignore"):
            for k, (oc, dc, lo, hi) in enumerate(
                (
                    (ou, du, -self.h[0], self.h[0]),
                    (ov, dv, -self.h[1], self.h[1]),
                    (o[2], dz, self.z0, self.z1),
                )
            ):
                t1 = (lo - oc) / dc
                t2 = (hi - oc) / dc
                near = np.minimum(t1, t2)
                far = np.maximum(t1, t2)
                par = dc == 0
                inside = (oc >= lo) & (oc <= hi)
                near = np.where(par, np.where(inside, -_INF, _INF), near)
                far = np.where(par, np.where(inside, _INF, -_INF), far)
                upd = near > tn
                face = np.where(upd, np.int8(k), face)
                tn = np.maximum(tn, near)
                tf = np.minimum(tf, far)
        hit = (tn <= tf) & (tn > 1e-6)
        t = np.where(hit, tn, _INF)
        n = np.zeros((len(d), 3))
        su = -np.sign(du)
        sv = -np.sign(dv)
        n[face == 0, :2] = (su[face == 0, None]) * self.ax
        n[face == 1, :2] = (sv[face == 1, None]) * self.ay
        n[face == 2, 2] = -np.sign(dz[face == 2])
        return t, n

    def albedo(self, p, n):
        u, v = self._local(p[:, 0], p[:, 1])
        roof = n[:, 2] > 0.5
        wall_s = np.where(np.abs(n[:, :2] @ self.ax) > 0.5, v, u)
        s = np.where(roof, u, wall_s)
        t = np.where(roof, v, p[:, 2])
        g = 1 + fbm(s, t, (2.0, 0.5, 0.15, 0.05), (0.25, 0.25, 0.2, 0.15), self.seed)
        base = np.where(roof[:, None], self.roof, self.colour)
        if self.style == "container":
            # corrugation: vertical ribs on the walls, every 0.28 m
            rib = 0.88 + 0.12 * (np.sin(s * (2 * math.pi / 0.28)) > 0)
            g = g * np.where(roof, 1.0, rib)
        elif self.style == "building":
            # roof: a darker edge band and two vents; walls: a band at 1 m and window bays
            edge = (np.abs(u) > self.h[0] - 0.4) | (np.abs(v) > self.h[1] - 0.4)
            vent = ((u - 2.0) ** 2 + (v + 1.0) ** 2 < 0.36) | ((u + 3.5) ** 2 + (v - 2.0) ** 2 < 0.25)
            g = g * np.where(roof & (edge | vent), 0.6, 1.0)
            z = p[:, 2] - self.z0
            bay = (np.mod(s + 0.9, 3.0) < 1.4) & (np.mod(z, 3.2) > 1.6) & (np.mod(z, 3.2) < 2.6)
            g = g * np.where(~roof & bay, 0.45, 1.0)
        return np.clip(base * g[:, None], 0, 1)

    def top(self, x, y):
        u, v = self._local(x, y)
        inside = (np.abs(u) <= self.h[0]) & (np.abs(v) <= self.h[1])
        return np.where(inside, self.z1, -_INF)


class Tank(Primitive):
    """A vertical cylinder with a flat roof."""

    kind = "tank"

    def __init__(self, name, cx, cy, radius, z0, z1, seed):
        self.name, self.c, self.r, self.z0, self.z1, self.seed = (
            name,
            np.array([cx, cy]),
            radius,
            z0,
            z1,
            seed,
        )
        self.lo = np.array([cx - radius, cy - radius, z0])
        self.hi = np.array([cx + radius, cy + radius, z1])

    def intersect(self, o, d):
        ox, oy = o[0] - self.c[0], o[1] - self.c[1]
        a = d[:, 0] ** 2 + d[:, 1] ** 2
        b = 2 * (ox * d[:, 0] + oy * d[:, 1])
        c = ox * ox + oy * oy - self.r * self.r
        disc = b * b - 4 * a * c
        with np.errstate(divide="ignore", invalid="ignore"):
            ts = (-b - np.sqrt(np.maximum(disc, 0))) / (2 * a)
        z = o[2] + ts * d[:, 2]
        side = (disc > 0) & (ts > 1e-6) & (z >= self.z0) & (z <= self.z1)
        with np.errstate(divide="ignore", invalid="ignore"):
            tc = (self.z1 - o[2]) / d[:, 2]
        px, py = ox + tc * d[:, 0], oy + tc * d[:, 1]
        cap = (tc > 1e-6) & (px * px + py * py <= self.r * self.r)
        t = np.where(side, ts, _INF)
        t = np.where(cap & (tc < t), tc, t)
        n = np.zeros((len(d), 3))
        is_cap = cap & (t == tc)
        hx, hy = ox + t * d[:, 0], oy + t * d[:, 1]
        with np.errstate(invalid="ignore"):
            n[:, 0] = np.where(is_cap, 0, hx / self.r)
            n[:, 1] = np.where(is_cap, 0, hy / self.r)
        n[:, 2] = np.where(is_cap, 1.0, 0.0)
        return t, n

    def albedo(self, p, n):
        dx, dy = p[:, 0] - self.c[0], p[:, 1] - self.c[1]
        roof = n[:, 2] > 0.5
        ang = np.arctan2(dy, dx) + math.pi
        s = np.where(roof, dx, ang * self.r)
        t = np.where(roof, dy, p[:, 2])
        g = 1 + fbm(s, t, (1.5, 0.4, 0.12, 0.05), (0.18, 0.2, 0.18, 0.12), self.seed)
        z = p[:, 2] - self.z0
        weld = ~roof & (np.abs(np.mod(z, 2.0) - 1.0) > 0.96)
        ladder = ~roof & (np.abs(ang - 1.0) * self.r < 0.35)
        stain = ~roof & (value_noise(s, t, 0.7, self.seed + 3) > 0.8)
        rings = roof & (np.abs(np.mod(np.hypot(dx, dy), 1.5) - 0.75) > 0.7)
        g = g * np.where(weld | rings, 0.55, 1.0) * np.where(ladder, 0.35, 1.0) * np.where(stain, 0.75, 1.0)
        base = np.array([0.80, 0.80, 0.78])
        return np.clip(base[None, :] * g[:, None], 0, 1)

    def top(self, x, y):
        inside = (x - self.c[0]) ** 2 + (y - self.c[1]) ** 2 <= self.r * self.r
        return np.where(inside, self.z1, -_INF)


class Pipe(Primitive):
    """A horizontal cylinder along the x axis from ``x0`` to ``x1`` (a pipe of the rack)."""

    kind = "pipe"

    def __init__(self, name, x0, x1, y, z, radius, colour, seed):
        self.name, self.x0, self.x1, self.y, self.z, self.r = name, x0, x1, y, z, radius
        self.colour, self.seed = np.array(colour, dtype=np.float64), seed
        self.lo = np.array([x0, y - radius, z - radius])
        self.hi = np.array([x1, y + radius, z + radius])

    def intersect(self, o, d):
        oy, oz = o[1] - self.y, o[2] - self.z
        a = d[:, 1] ** 2 + d[:, 2] ** 2
        b = 2 * (oy * d[:, 1] + oz * d[:, 2])
        c = oy * oy + oz * oz - self.r * self.r
        disc = b * b - 4 * a * c
        with np.errstate(divide="ignore", invalid="ignore"):
            t = (-b - np.sqrt(np.maximum(disc, 0))) / (2 * a)
        x = o[0] + t * d[:, 0]
        hit = (disc > 0) & (t > 1e-6) & (x >= self.x0) & (x <= self.x1)
        t = np.where(hit, t, _INF)
        n = np.zeros((len(d), 3))
        with np.errstate(invalid="ignore"):
            n[:, 1] = (oy + t * d[:, 1]) / self.r
            n[:, 2] = (oz + t * d[:, 2]) / self.r
        n[~hit] = 0
        return t, n

    def albedo(self, p, n):
        ang = np.arctan2(p[:, 2] - self.z, p[:, 1] - self.y)
        g = 1 + fbm(p[:, 0], ang * self.r, (1.0, 0.3, 0.08), (0.2, 0.2, 0.15), self.seed)
        flange = np.abs(np.mod(p[:, 0] - self.x0, 6.0) - 3.0) > 2.85
        g = g * np.where(flange, 0.6, 1.0)
        return np.clip(self.colour[None, :] * g[:, None], 0, 1)

    def top(self, x, y):
        dy = y - self.y
        inside = (np.abs(dy) <= self.r) & (x >= self.x0) & (x <= self.x1)
        return np.where(inside, self.z + np.sqrt(np.maximum(self.r**2 - dy * dy, 0)), -_INF)


# --------------------------------------------------------------------------------------- scene


@dataclass(frozen=True)
class Target:
    id: str
    role: str  # control, check, blunder
    x: float
    y: float
    size: float = 1.0  # checker square, metres (plus a 0.1 m white margin)
    stated_offset: tuple[float, float, float] = (0.0, 0.0, 0.0)


TARGETS = (
    Target("GCP1", "control", -72.0, -75.0),
    Target("GCP2", "control", 70.0, -68.0),
    Target("GCP3", "control", 68.0, 72.0),
    Target("GCP4", "control", -74.0, 70.0),
    Target("GCP5", "control", 4.0, 30.0),
    Target("CHK1", "check", -35.0, -3.0),
    Target("CHK2", "check", 42.0, 4.0),
    Target("CHK3", "check", -10.0, -68.0),
    Target("CHK4", "check", 22.0, 70.0),
    # the planted blunder: its stated coordinate is 1 m off (0.6 m east, 0.8 m north)
    Target("GCP6", "blunder", -50.0, 46.0, stated_offset=(0.6, 0.8, 0.0)),
)

# Terrain features (local metres). They do not overlap, so the terrain's slope bound is the
# steepest one plus the gentle background.
PLANE = (0.004, -0.0025)
# gentle swells: a (1 - r2/R2)^3 bump of height ``a`` and radius ``R`` (zero outside R)
BUMPS = (
    (-70.0, -10.0, 0.8, 55.0),
    (55.0, 15.0, -0.6, 70.0),
    (10.0, 75.0, 0.7, 60.0),
    (-15.0, -85.0, 0.5, 50.0),
)
STOCKPILE = {"centre": (-30.0, 28.0), "radius": 14.0, "height": 6.0, "slopeDeg": 35.0}
PIT = {"centre": (38.0, -32.0), "radius": 10.0, "depth": 3.0, "slopeDeg": 30.0}
ROAD = {"a": (-110.0, -60.0), "b": (110.0, -50.0), "width": 7.0, "shoulder": 1.0, "raise": 0.12}
WATER = {"centre": (-62.0, 58.0), "radius": 10.0}
SOLAR = {"x": (48.0, 78.0), "y": (38.0, 62.0), "period": 2.6, "panel": 1.7}
SUN = np.array([0.45, -0.55, 0.70]) / np.linalg.norm([0.45, -0.55, 0.70])

_TAN_PILE = math.tan(math.radians(STOCKPILE["slopeDeg"]))
_TAN_PIT = math.tan(math.radians(PIT["slopeDeg"]))


def stockpile_volume() -> float:
    """Volume of the stockpile above the original ground (a truncated cone), m3."""
    r, h = STOCKPILE["radius"], STOCKPILE["height"]
    rt = r - h / _TAN_PILE
    return math.pi / 3 * h * (r * r + r * rt + rt * rt)


def pit_volume() -> float:
    r, dd = PIT["radius"], PIT["depth"]
    rb = r - dd / _TAN_PIT
    return math.pi / 3 * dd * (r * r + r * rb + rb * rb)


class Scene:
    """The synthetic site. ``variant`` 1 is "another place" (the outlier photo): other textures and
    no structures."""

    def __init__(self, seed: int = DEFAULT_SEED, variant: int = 0):
        self.seed = seed + 7777 * variant
        self.variant = variant
        g = self.ground
        self.lipschitz = (
            math.hypot(*PLANE)
            + sum(1.7174 * abs(a) / rad for _, _, a, rad in BUMPS)
            + max(_TAN_PILE, _TAN_PIT, 1.5 * ROAD["raise"] / ROAD["shoulder"])
        ) * 1.05
        self._height_bounds()
        objs: list[Primitive] = []
        if variant == 0:

            def base(x, y, sx, sy, yaw=0.0):
                a = math.radians(yaw)
                pts = [
                    (x + u * math.cos(a) - v * math.sin(a), y + u * math.sin(a) + v * math.cos(a))
                    for u in (-sx / 2, sx / 2)
                    for v in (-sy / 2, sy / 2)
                ]
                hs = [float(g(np.array([px]), np.array([py]))[0]) for px, py in pts]
                return min(hs) - 0.5, float(g(np.array([x]), np.array([y]))[0])

            def box(name, x, y, sx, sy, h, yaw, colour, roof, style, k):
                z0, zc = base(x, y, sx, sy, yaw)
                return Box(name, x, y, sx, sy, z0, zc + h, yaw, colour, seed + k, roof, style)

            objs += [
                box(
                    "building-1",
                    32.0,
                    22.0,
                    18.0,
                    11.0,
                    6.5,
                    12.0,
                    (0.78, 0.74, 0.66),
                    (0.55, 0.57, 0.6),
                    "building",
                    11,
                ),
                box(
                    "building-2",
                    -42.0,
                    -28.0,
                    10.0,
                    10.0,
                    4.5,
                    0.0,
                    (0.70, 0.62, 0.52),
                    (0.62, 0.62, 0.62),
                    "building",
                    12,
                ),
                box(
                    "container-1", 4.0, 50.0, 6.06, 2.44, 2.59, 0.0, (0.62, 0.22, 0.16), None, "container", 13
                ),
                box(
                    "container-2", 4.0, 54.0, 6.06, 2.44, 2.59, 0.0, (0.18, 0.36, 0.58), None, "container", 14
                ),
                box(
                    "container-3",
                    15.0,
                    52.0,
                    6.06,
                    2.44,
                    2.59,
                    90.0,
                    (0.25, 0.48, 0.30),
                    None,
                    "container",
                    15,
                ),
                box(
                    "container-4",
                    -8.0,
                    47.0,
                    6.06,
                    2.44,
                    2.59,
                    30.0,
                    (0.72, 0.62, 0.20),
                    None,
                    "container",
                    16,
                ),
            ]
            for name, (x, y), r, h in (
                ("tank-1", (0.0, 0.0), 6.0, 10.0),
                ("tank-2", (16.0, -10.0), 3.5, 7.0),
            ):
                z0, zc = base(x, y, 2 * r, 2 * r)
                objs.append(Tank(name, x, y, r, z0, zc + h, seed + 20 + len(objs)))
            # pipe rack: six bents of two posts and a beam, three pipes on top
            rack_z = float(g(np.array([-13.0]), np.array([-16.0]))[0])
            steel = (0.42, 0.44, 0.47)
            for k, x in enumerate(np.arange(-28.0, 2.1, 6.0)):
                for y in (-17.5, -14.5):
                    z0, _ = base(float(x), y, 0.35, 0.35)
                    objs.append(
                        Box(
                            f"rack-post-{k}{'ab'[y > -16]}",
                            float(x),
                            y,
                            0.35,
                            0.35,
                            z0,
                            rack_z + 5.0,
                            0.0,
                            steel,
                            40 + k,
                            None,
                            "steel",
                        )
                    )
                objs.append(
                    Box(
                        f"rack-beam-{k}",
                        float(x),
                        -16.0,
                        0.3,
                        3.4,
                        rack_z + 4.6,
                        rack_z + 4.9,
                        0.0,
                        steel,
                        50 + k,
                        None,
                        "steel",
                    )
                )
            for k, (y, r, col) in enumerate(
                (
                    (-16.6, 0.30, (0.85, 0.85, 0.82)),
                    (-15.8, 0.22, (0.78, 0.66, 0.30)),
                    (-15.0, 0.15, (0.30, 0.45, 0.62)),
                )
            ):
                objs.append(Pipe(f"pipe-{k + 1}", -29.0, 3.0, y, rack_z + 4.9 + r, r, col, seed + 60 + k))
        self.objects = objs

    # ---------------------------------------------------------------- terrain (the DTM)

    def ground(self, x: np.ndarray, y: np.ndarray, grad: bool = False):
        """Terrain height (local z) at (x, y); with ``grad`` also dz/dx and dz/dy."""
        z = PLANE[0] * x + PLANE[1] * y
        gx = np.full_like(z, PLANE[0])
        gy = np.full_like(z, PLANE[1])
        if self.variant:
            # another place: rolling dunes, no structures
            z = z + 1.5 * np.sin(x / 17.0 + 0.3) * np.cos(y / 23.0)
            gx = gx + 1.5 / 17.0 * np.cos(x / 17.0 + 0.3) * np.cos(y / 23.0)
            gy = gy - 1.5 / 23.0 * np.sin(x / 17.0 + 0.3) * np.sin(y / 23.0)
            return (z, gx, gy) if grad else z
        # every feature is zero outside its footprint: skip those this batch does not touch
        bx0, bx1 = (float(x.min()), float(x.max())) if x.size else (0.0, 0.0)
        by0, by1 = (float(y.min()), float(y.max())) if y.size else (0.0, 0.0)

        def touches(cx, cy, rad):
            return bx0 <= cx + rad and bx1 >= cx - rad and by0 <= cy + rad and by1 >= cy - rad

        for bx, by, a, rad in BUMPS:
            if not touches(bx, by, rad):
                continue
            dx, dy = x - bx, y - by
            q = np.maximum(1 - (dx * dx + dy * dy) / (rad * rad), 0.0)
            z = z + a * q**3
            k = -6 * a * q * q / (rad * rad)
            gx = gx + k * dx
            gy = gy + k * dy
        for feat, tan, sign in ((STOCKPILE, _TAN_PILE, 1.0), (PIT, _TAN_PIT, -1.0)):
            cx, cy = feat["centre"]
            if not touches(cx, cy, feat["radius"]):
                continue
            hmax = feat.get("height", feat.get("depth"))
            dx, dy = x - cx, y - cy
            r = np.sqrt(dx * dx + dy * dy)
            raw = (feat["radius"] - r) * tan
            p = np.clip(raw, 0.0, hmax)
            z = z + sign * p
            slope = (raw > 0) & (raw < hmax)
            with np.errstate(divide="ignore", invalid="ignore"):
                k = np.where(slope & (r > 0), -tan / r, 0.0)
            gx = gx + sign * k * dx
            gy = gy + sign * k * dy
        hw, sh, rz = ROAD["width"] / 2, ROAD["shoulder"], ROAD["raise"]
        corners = self._road_dist(np.array([bx0, bx0, bx1, bx1]), np.array([by0, by1, by0, by1]))[0]
        if corners.min() > hw + sh or corners.max() < -(hw + sh):
            return (z, gx, gy) if grad else z
        d, ux, uy = self._road_dist(x, y)
        t = (hw + sh - np.abs(d)) / sh
        z = z + rz * _smoothstep(t)
        tc = np.clip(t, 0.0, 1.0)
        ds = np.where((t > 0) & (t < 1), 6 * tc * (1 - tc), 0.0) * rz / sh * -np.sign(d)
        gx = gx + ds * ux
        gy = gy + ds * uy
        return (z, gx, gy) if grad else z

    @staticmethod
    def _road_dist(x, y):
        (ax, ay), (bx, by) = ROAD["a"], ROAD["b"]
        L = math.hypot(bx - ax, by - ay)
        nx, ny = -(by - ay) / L, (bx - ax) / L
        return (x - ax) * nx + (y - ay) * ny, nx, ny

    BOUND_CELL = 2.0
    BOUND_HALF = 160.0

    def _height_bounds(self) -> None:
        """Global height bounds and a coarse grid of the highest terrain per 2 m cell (sampled every
        0.25 m, plus the slope bound over half a sample), so marching starts just above the ground."""
        xs, ys = np.meshgrid(np.linspace(-400, 400, 801), np.linspace(-400, 400, 801))
        z = self.ground(xs, ys)
        self.zmax = float(z.max()) + 0.05
        self.zmin = float(z.min()) - 0.05
        n = round(2 * self.BOUND_HALF / self.BOUND_CELL)
        k = 8
        c = (np.arange(n * k) + 0.5) * (self.BOUND_CELL / k) - self.BOUND_HALF
        X, Y = np.meshgrid(c, c)
        g = self.ground(X, Y).reshape(n, k, n, k).max(axis=(1, 3))
        self.cell_max = g + self.lipschitz * self.BOUND_CELL / k + 0.01

    def local_zmax(self, x0: float, y0: float, x1: float, y1: float) -> float:
        """An upper bound of the terrain over a rectangle (local metres)."""
        h, c = self.BOUND_HALF, self.BOUND_CELL
        if x0 < -h or y0 < -h or x1 >= h or y1 >= h:
            return self.zmax
        i0, i1 = int((x0 + h) // c), int((x1 + h) // c)
        j0, j1 = int((y0 + h) // c), int((y1 + h) // c)
        return float(self.cell_max[j0 : j1 + 1, i0 : i1 + 1].max())

    def dsm(self, x: np.ndarray, y: np.ndarray) -> np.ndarray:
        """Top surface height (terrain and structures) at (x, y), local z."""
        z = self.ground(x, y)
        for o in self.objects:
            z = np.maximum(z, o.top(x, y))
        return z

    # ---------------------------------------------------------------- texture

    def ground_albedo(self, x: np.ndarray, y: np.ndarray, w: np.ndarray | None = None) -> np.ndarray:
        """Ground colour at (x, y). ``w`` is the half width of each sample's footprint in metres:
        the GCP targets are box filtered over it (exact edges, so their centres are unbiased)."""
        s = self.seed
        n = fbm(x, y, (24.0, 6.0, 1.6, 0.45, 0.16, 0.06), (0.30, 0.25, 0.22, 0.2, 0.18, 0.14), s)
        tint = value_noise(x, y, 11.0, s + 1)
        sand = np.array([0.74, 0.63, 0.47])
        dust = np.array([0.66, 0.60, 0.53])
        col = sand[None, :] * (1 - tint[:, None] * 0.6) + dust[None, :] * (tint[:, None] * 0.6)
        col = col * (1 + 1.1 * n)[:, None]
        # pebbles and dark scrub: scattered high-contrast spots
        peb = value_noise(x, y, 0.22, s + 2)
        col = np.where((peb > 0.83)[:, None], col * 0.45, col)
        col = np.where((peb < 0.06)[:, None], np.minimum(col * 1.25, 1), col)
        scrub = value_noise(x, y, 1.3, s + 3) * value_noise(x, y, 0.37, s + 4)
        col = np.where((scrub > 0.62)[:, None], np.array([0.36, 0.34, 0.24])[None, :] * (1 + n[:, None]), col)
        if self.variant:
            return np.clip(col * np.array([1.05, 0.98, 0.9]), 0, 1)
        # stockpile: grey gravel; pit floor: darker earth
        for feat, colr in ((STOCKPILE, (0.56, 0.55, 0.53)), (PIT, (0.52, 0.42, 0.33))):
            cx, cy = feat["centre"]
            m = np.nonzero((x - cx) ** 2 + (y - cy) ** 2 < feat["radius"] ** 2)[0]
            if m.size:
                g = 1 + fbm(x[m], y[m], (2.0, 0.5, 0.12, 0.05), (0.2, 0.25, 0.25, 0.2), s + 5)
                col[m] = np.array(colr)[None, :] * g[:, None]
        # road: asphalt, edge lines and a dashed centre line
        d, _, _ = self._road_dist(x, y)
        hw = ROAD["width"] / 2
        m = np.nonzero(np.abs(d) < hw)[0]
        if m.size:
            (ax, ay), (bx, by) = ROAD["a"], ROAD["b"]
            L = math.hypot(bx - ax, by - ay)
            xm, ym, dm = x[m], y[m], d[m]
            along = ((xm - ax) * (bx - ax) + (ym - ay) * (by - ay)) / L
            asphalt = 0.30 * (1 + fbm(xm, ym, (1.0, 0.25, 0.07), (0.25, 0.3, 0.25), s + 6))
            rc = np.stack([asphalt, asphalt, asphalt * 1.03], axis=1)
            line = (np.abs(np.abs(dm) - (hw - 0.3)) < 0.08) | (
                (np.abs(dm) < 0.08) & (np.mod(along, 9.0) < 3.0)
            )
            col[m] = np.where(line[:, None], 0.92, rc)
        # water-like area: almost no texture
        cx, cy = WATER["centre"]
        m = np.nonzero((x - cx) ** 2 + (y - cy) ** 2 < WATER["radius"] ** 2)[0]
        if m.size:
            wv = 1 + 0.01 * (value_noise(x[m], y[m], 3.0, s + 7) - 0.5)
            col[m] = np.array([0.16, 0.30, 0.32])[None, :] * wv[:, None]
        # solar panel rows: the same pattern every 2.6 m
        (x0, x1), (y0, y1) = SOLAR["x"], SOLAR["y"]
        ph = np.mod(y - y0, SOLAR["period"])
        m = np.nonzero((x >= x0) & (x <= x1) & (y >= y0) & (y <= y1) & (ph < SOLAR["panel"]))[0]
        if m.size:
            cell = (np.mod(x[m] - x0, 1.0) < 0.04) | (np.abs(ph[m] - SOLAR["panel"] / 2) < 0.02)
            col[m] = np.where(cell[:, None], np.array([0.55, 0.58, 0.62]), np.array([0.10, 0.14, 0.26]))
        # GCP targets: a 2 x 2 black and white checker inside a 0.1 m white margin, box filtered
        if w is None:
            w = np.full(x.shape, 1e-3)
        for t in TARGETS:
            half = t.size / 2
            reach = half + 0.1 + w
            m = np.nonzero((np.abs(x - t.x) < reach) & (np.abs(y - t.y) < reach))[0]
            if not m.size:
                continue
            dx, dy, wm = x[m] - t.x, y[m] - t.y, w[m]

            def ramp(v, wm=wm):
                return np.clip(0.5 + 0.5 * v / wm, 0.0, 1.0)

            checker = 0.5 + 0.46 * np.clip(dx / wm, -1, 1) * np.clip(dy / wm, -1, 1)
            inner = ramp(half - np.abs(dx)) * ramp(half - np.abs(dy))
            outer = ramp(half + 0.1 - np.abs(dx)) * ramp(half + 0.1 - np.abs(dy))
            target = 0.96 * (1 - inner) + checker * inner
            col[m] = col[m] * (1 - outer)[:, None] + (target * outer)[:, None]
        return np.clip(col, 0, 1)

    # ---------------------------------------------------------------- ray casting

    def march(self, o: np.ndarray, d: np.ndarray, tol: float = 3e-3) -> np.ndarray:
        """First hit of rays with the terrain (rays must point down). Lipschitz ray marching: each
        step is the vertical gap over (1 + L tan), so it never passes the surface; within ``tol`` a
        Newton step on the local plane finishes (micrometres on smooth ground)."""
        dz = -d[:, 2]
        tan = np.hypot(d[:, 0], d[:, 1]) / dz
        # start on a bound of the terrain under the rays' path between the global bounds
        ta = np.maximum((o[2] - self.zmax) / dz, 0.0)
        tb = (o[2] - self.zmin) / dz
        xs = np.concatenate([o[0] + ta * d[:, 0], o[0] + tb * d[:, 0]])
        ys = np.concatenate([o[1] + ta * d[:, 1], o[1] + tb * d[:, 1]])
        top = self.local_zmax(float(xs.min()), float(ys.min()), float(xs.max()), float(ys.max()))
        t = np.maximum((o[2] - top) / dz, 0.0)
        idx = np.arange(len(d))
        for _ in range(4000):
            if idx.size == 0:
                break
            ti = t[idx]
            di = d[idx]
            gap = (o[2] + ti * di[:, 2]) - self.ground(o[0] + ti * di[:, 0], o[1] + ti * di[:, 1])
            act = gap > tol
            t[idx] = ti + np.where(act, gap / (1 + self.lipschitz * tan[idx]) / dz[idx], 0.0)
            idx = idx[act]
        px, py = o[0] + t * d[:, 0], o[1] + t * d[:, 1]
        h, gx, gy = self.ground(px, py, grad=True)
        f = o[2] + t * d[:, 2] - h
        fp = d[:, 2] - gx * d[:, 0] - gy * d[:, 1]
        step = np.where(fp < -1e-3, -f / np.minimum(fp, -1e-3), 0.0)
        return t + np.clip(step, 0.0, 4 * tol / dz)

    def trace(self, o: np.ndarray, d: np.ndarray, objects: list[Primitive] | None = None):
        """Hits of rays from ``o`` along unit directions ``d`` (n, 3): ray parameter, normal, the
        index of what was hit (-1 terrain, else the object index)."""
        objects = self.objects if objects is None else objects
        t = self.march(o, d)
        what = np.full(len(d), -1, dtype=np.int32)
        nrm = np.zeros((len(d), 3))
        for k, ob in enumerate(objects):
            tk, nk = ob.intersect(o, d)
            closer = tk < t
            if closer.any():
                t = np.where(closer, tk, t)
                what[closer] = k
                nrm[closer] = nk[closer]
        g = what < 0
        if g.any():
            p = o + t[g, None] * d[g]
            _, gx, gy = self.ground(p[:, 0], p[:, 1], grad=True)
            n = np.stack([-gx, -gy, np.ones_like(gx)], axis=1)
            nrm[g] = n / np.linalg.norm(n, axis=1)[:, None]
        return t, nrm, what

    def shadowed(self, p: np.ndarray, objects: list[Primitive]) -> np.ndarray:
        lit = np.ones(len(p), dtype=bool)
        if not objects:
            return ~lit
        sun = np.broadcast_to(SUN, p.shape)
        for ob in objects:
            # a ray per point: intersect() takes one origin, so shift the points to a common frame
            tk = _intersect_many(ob, p + 0.02 * SUN, sun)
            lit &= ~np.isfinite(tk)
        return ~lit

    def shade(self, p, n, what, objects, w=None):
        alb = np.zeros((len(p), 3))
        g = what < 0
        if g.any():
            alb[g] = self.ground_albedo(p[g, 0], p[g, 1], None if w is None else w[g])
        for k, ob in enumerate(objects):
            m = what == k
            if m.any():
                alb[m] = ob.albedo(p[m], n[m])
        lam = np.maximum(n @ SUN, 0.0)
        shadow_objs = [ob for ob in self.objects if _shadow_reaches(ob, p)]
        sh = self.shadowed(p, shadow_objs) if shadow_objs else np.zeros(len(p), dtype=bool)
        light = 0.36 + 0.72 * lam * ~sh
        return alb * light[:, None]


def _intersect_many(ob: Primitive, origins: np.ndarray, dirs: np.ndarray) -> np.ndarray:
    """Ray parameters (inf on a miss) for rays with an origin each (shadow rays): a bounding box
    slab test first, then the closed form on the candidates."""
    t = np.full(len(origins), _INF)
    with np.errstate(divide="ignore", invalid="ignore"):
        t1 = (ob.lo[None, :] - origins) / dirs
        t2 = (ob.hi[None, :] - origins) / dirs
    tn = np.nanmax(np.minimum(t1, t2), axis=1)
    tf = np.nanmin(np.maximum(t1, t2), axis=1)
    cand = np.nonzero((tn <= tf) & (tf > 0))[0]
    if cand.size:
        t[cand] = _intersect_rays(ob, origins[cand], dirs[cand])
    return t


def _intersect_rays(ob: Primitive, o: np.ndarray, d: np.ndarray) -> np.ndarray:
    """Like ``Primitive.intersect`` but with an origin per ray (shadow rays)."""
    if isinstance(ob, Box):
        ou, ov = ob._local(o[:, 0], o[:, 1])
        du = d[:, 0] * ob.ax[0] + d[:, 1] * ob.ax[1]
        dv = d[:, 0] * ob.ay[0] + d[:, 1] * ob.ay[1]
        tn = np.full(len(d), -_INF)
        tf = np.full(len(d), _INF)
        with np.errstate(divide="ignore", invalid="ignore"):
            for oc, dc, lo, hi in (
                (ou, du, -ob.h[0], ob.h[0]),
                (ov, dv, -ob.h[1], ob.h[1]),
                (o[:, 2], d[:, 2], ob.z0, ob.z1),
            ):
                t1 = (lo - oc) / dc
                t2 = (hi - oc) / dc
                par = dc == 0
                inside = (oc >= lo) & (oc <= hi)
                tn = np.maximum(tn, np.where(par, np.where(inside, -_INF, _INF), np.minimum(t1, t2)))
                tf = np.minimum(tf, np.where(par, np.where(inside, _INF, -_INF), np.maximum(t1, t2)))
        return np.where((tn <= tf) & (tf > 1e-6), np.maximum(tn, 0), _INF)
    if isinstance(ob, Tank):
        ox, oy = o[:, 0] - ob.c[0], o[:, 1] - ob.c[1]
        a = d[:, 0] ** 2 + d[:, 1] ** 2
        b = 2 * (ox * d[:, 0] + oy * d[:, 1])
        c = ox * ox + oy * oy - ob.r * ob.r
        disc = b * b - 4 * a * c
        with np.errstate(divide="ignore", invalid="ignore"):
            sq = np.sqrt(np.maximum(disc, 0))
            t0 = (-b - sq) / (2 * a)
            t1 = (-b + sq) / (2 * a)
        z0 = o[:, 2] + t0 * d[:, 2]
        z1 = o[:, 2] + t1 * d[:, 2]
        hit = (disc > 0) & (t1 > 1e-6) & ((z0 <= ob.z1) | (z1 <= ob.z1)) & ((z0 >= ob.z0) | (z1 >= ob.z0))
        return np.where(hit, np.maximum(t0, 0), _INF)
    if isinstance(ob, Pipe):
        oy, oz = o[:, 1] - ob.y, o[:, 2] - ob.z
        a = d[:, 1] ** 2 + d[:, 2] ** 2
        b = 2 * (oy * d[:, 1] + oz * d[:, 2])
        c = oy * oy + oz * oz - ob.r * ob.r
        disc = b * b - 4 * a * c
        with np.errstate(divide="ignore", invalid="ignore"):
            t = (-b - np.sqrt(np.maximum(disc, 0))) / (2 * a)
        x = o[:, 0] + t * d[:, 0]
        return np.where((disc > 0) & (t > 1e-6) & (x >= ob.x0) & (x <= ob.x1), t, _INF)
    raise TypeError(type(ob))


def _shadow_reaches(ob: Primitive, p: np.ndarray) -> bool:
    """Whether an object's shadow can fall on any of the points (bounding box test)."""
    lo, hi = ob.lo, ob.hi
    # the shadow volume: the box swept away from the sun down to the lowest point
    depth = max(hi[2] - float(p[:, 2].min()), 0.0)
    sweep = -SUN[:2] / SUN[2] * depth
    x0 = min(lo[0], lo[0] + sweep[0]) - 0.1
    x1 = max(hi[0], hi[0] + sweep[0]) + 0.1
    y0 = min(lo[1], lo[1] + sweep[1]) - 0.1
    y1 = max(hi[1], hi[1] + sweep[1]) + 0.1
    return bool(((p[:, 0] >= x0) & (p[:, 0] <= x1) & (p[:, 1] >= y0) & (p[:, 1] <= y1)).any())


# ---------------------------------------------------------------------------------------- render


def render(scene: Scene, cam: Camera, shot: Shot, ss: int = 2, tile: int = 64) -> np.ndarray:
    """Render a shot: float RGB (height, width, 3) in [0, 1], before exposure and noise."""
    R = shot.rotation
    o = np.asarray(shot.centre, dtype=np.float64)
    out = np.zeros((cam.height, cam.width, 3), dtype=np.float32)
    # objects in front of the camera, with their bounds in normalised image coordinates
    boxes = []
    for ob in scene.objects:
        c = (ob.corners() - o) @ R.T
        if (c[:, 2] <= 0.1).any():
            boxes.append((ob, None))
        else:
            xn, yn = c[:, 0] / c[:, 2], c[:, 1] / c[:, 2]
            boxes.append((ob, (xn.min(), xn.max(), yn.min(), yn.max())))
    sub = (np.arange(ss) + 0.5) / ss
    for r0 in range(0, cam.height, tile):
        for c0 in range(0, cam.width, tile):
            r1, c1 = min(r0 + tile, cam.height), min(c0 + tile, cam.width)
            vv = (np.arange(r0, r1)[:, None] + sub[None, :]).ravel()
            uu = (np.arange(c0, c1)[:, None] + sub[None, :]).ravel()
            u, v = np.meshgrid(uu, vv)
            x, y = cam.undistort((u.ravel() - cam.cx) / cam.fx, (v.ravel() - cam.cy) / cam.fy)
            dc = np.stack([x, y, np.ones_like(x)], axis=1)
            dc /= np.linalg.norm(dc, axis=1)[:, None]
            d = dc @ R
            bx = (x.min(), x.max(), y.min(), y.max())
            objs = [
                ob
                for ob, b in boxes
                if b is None or not (b[1] < bx[0] or b[0] > bx[1] or b[3] < bx[2] or b[2] > bx[3])
            ]
            t, n, what = scene.trace(o, d, objs)
            p = o + t[:, None] * d
            # half width of each sample's footprint on the surface (for the box-filtered targets)
            cosi = np.maximum(np.abs(np.einsum("ij,ij->i", n, d)), 0.25)
            w = 0.5 * t / (cam.fx * dc[:, 2] * ss) / cosi
            rgb = scene.shade(p, n, what, objs, w)
            h, w = r1 - r0, c1 - c0
            rgb = rgb.reshape(h, ss, w, ss, 3).mean(axis=(1, 3))
            out[r0:r1, c0:c1] = rgb
    return out


def finish(img: np.ndarray, cam: Camera, seed: int, gain: float) -> np.ndarray:
    """Exposure gain, vignetting and sensor noise; uint8."""
    h, w = img.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    r2 = ((xx + 0.5 - cam.cx) / cam.fx) ** 2 + ((yy + 0.5 - cam.cy) / cam.fy) ** 2
    vig = 1 / (1 + 0.07 * r2) ** 2
    rng = np.random.default_rng(seed)
    noisy = img * (gain * vig)[..., None] + rng.normal(0, 1.2 / 255, img.shape)
    return np.clip(np.round(noisy * 255), 0, 255).astype(np.uint8)


def motion_blur(img: np.ndarray, length: int) -> np.ndarray:
    """Blur along the image y axis (the flight direction of a nadir line)."""
    from scipy.ndimage import uniform_filter1d

    return uniform_filter1d(img.astype(np.float32), size=max(1, length), axis=0, mode="nearest")


def jpeg_bytes(img: np.ndarray, quality: int = JPEG_QUALITY) -> bytes:
    """JPEG at a fixed quality without metadata (no JFIF segment: metadata goes in later)."""
    buf = io.BytesIO()
    Image.fromarray(img, "RGB").save(buf, "JPEG", quality=quality, subsampling=2, optimize=False)
    return _strip_app0(buf.getvalue())


def _strip_app0(data: bytes) -> bytes:
    if data[2:4] == b"\xff\xe0":
        n = struct.unpack(">H", data[4:6])[0]
        return data[:2] + data[4 + n :]
    return data


# ----------------------------------------------------------------------------------- the flight


@dataclass(frozen=True)
class FlightPlan:
    altitude_agl: float = 60.0
    lines_x: tuple[float, ...] = (-54.0, -27.0, 0.0, 27.0, 54.0)
    first_y: float = -60.75
    stations: int = 10
    spacing: float = 13.5
    ring: int = 8
    ring_radius: float = 28.0
    ring_height: float = 25.0
    takeoff: tuple[float, float] = (0.0, -105.0)
    start: str = "2026-03-14T08:30:00"


FLIGHT = FlightPlan()


def _time(start: str, seconds: float) -> str:
    from datetime import datetime, timedelta

    t = datetime.fromisoformat(start) + timedelta(seconds=seconds)
    return t.strftime("%Y-%m-%dT%H:%M:%S")


def plan_shots(scene: Scene, seed: int = DEFAULT_SEED, flight: FlightPlan = FLIGHT) -> list[Shot]:
    """The quick set's photos, in file order: nadir lines (serpentine), the oblique ring around
    tank-1, then the five bad images."""
    rng = np.random.default_rng(seed + 1)
    zt = float(scene.ground(np.array([flight.takeoff[0]]), np.array([flight.takeoff[1]]))[0])
    shots: list[Shot] = []
    k = 0
    secs = 0.0

    def name():
        return f"SYN_{k + 1:04d}.JPG"

    for li, x in enumerate(flight.lines_x):
        ys = [flight.first_y + i * flight.spacing for i in range(flight.stations)]
        north = li % 2 == 0
        if not north:
            ys = ys[::-1]
        for y in ys:
            j = rng.normal(0, 1, 6)
            c = np.array([x + 0.6 * j[0], y + 0.5 * j[1], zt + flight.altitude_agl + 0.4 * j[2]])
            yaw = (0.0 if north else 180.0) + 1.5 * j[3]
            shots.append(
                Shot(
                    name(),
                    "nadir",
                    c,
                    yaw,
                    -90.0 + 0.8 * j[4],
                    0.8 * j[5],
                    _time(flight.start, secs),
                    line=li,
                )
            )
            k += 1
            secs += 2.0
        secs += 12.0
    t1 = next(o for o in scene.objects if o.name == "tank-1")
    tz = float(scene.ground(np.array([0.0]), np.array([0.0]))[0])
    for i in range(flight.ring):
        a = 2 * math.pi * i / flight.ring + 0.2
        cx, cy = t1.c[0] + flight.ring_radius * math.sin(a), t1.c[1] + flight.ring_radius * math.cos(a)
        c = np.array([cx, cy, tz + flight.ring_height])
        look = np.array([t1.c[0], t1.c[1], tz + 2.0]) - c
        yaw = math.degrees(math.atan2(look[0], look[1])) % 360
        pitch = math.degrees(math.atan2(look[2], math.hypot(look[0], look[1])))
        j = rng.normal(0, 1, 2)
        shots.append(
            Shot(name(), "oblique", c, yaw, pitch + 0.5 * j[0], 0.5 * j[1], _time(flight.start, secs))
        )
        k += 1
        secs += 4.0
    secs += 20.0
    alt = zt + flight.altitude_agl

    def bad(kind, x, y, yaw, **kw):
        nonlocal k, secs
        s = Shot(name(), kind, np.array([x, y, alt]), yaw, -90.0, 0.0, _time(flight.start, secs), **kw)
        shots.append(s)
        k += 1
        secs += 2.0
        return s

    bad("blurred", -13.5, 3.0, 0.0, expect="reject", reason="motion blur", blur_px=120.0)
    bad("duplicate", 0, 0, 0.0, expect="reject", reason="duplicate of SYN_0023.JPG", source="SYN_0023.JPG")
    bad(
        "outlier",
        13.5,
        20.0,
        180.0,
        expect="reject",
        reason="another place: matches no other photo",
        scene_seed_offset=1,
    )
    bad("corrupt", -40.0, 30.0, 0.0, expect="reject", reason="corrupt JPEG (truncated)")
    bad(
        "no-gps",
        40.0,
        -40.0,
        180.0,
        expect="either",
        reason="no GPS: registered from matches, or rejected for that reason",
    )
    # the duplicate takes its source's pose
    src = next(s for s in shots if s.name == "SYN_0023.JPG")
    dup = next(s for s in shots if s.kind == "duplicate")
    dup.centre, dup.yaw, dup.pitch, dup.roll = src.centre.copy(), src.yaw, src.pitch, src.roll
    return shots


def _render_job(args) -> tuple[str, bytes]:
    seed, size, shot, cache = args
    if cache is not None:
        p = Path(cache) / f"{shot.name}.jpg"
        if p.exists():
            return shot.name, p.read_bytes()
    scene = Scene(seed, variant=shot.scene_seed_offset)
    cam = camera_for(size)
    ss = 2 if size != "full" else 1
    img = render(scene, cam, shot, ss=ss)
    idx = int(shot.name[4:8])
    gain = 1 + 0.03 * float(np.random.default_rng(seed * 1000 + idx).normal())
    u8 = finish(img, cam, seed * 1000 + idx, gain)
    if shot.blur_px:
        blurred = motion_blur(u8, round(shot.blur_px * cam.width / CAMERA.width))
        u8 = np.clip(np.round(blurred), 0, 255).astype(np.uint8)
    data = jpeg_bytes(u8, MINI_JPEG_QUALITY if size == "mini" else JPEG_QUALITY)
    if cache is not None:
        p = Path(cache) / f"{shot.name}.jpg"
        tmp = p.with_suffix(f".{os.getpid()}.tmp")
        tmp.write_bytes(data)
        os.replace(tmp, p)
    return shot.name, data


def camera_for(size: str) -> Camera:
    if size == "full":
        return CAMERA
    if size == "quick":
        return CAMERA.scaled(QUICK_WIDTH)
    if size == "mini":
        return CAMERA.scaled(MINI_WIDTH)
    raise ValueError(size)


# The mini set's grid photos: an L along the south and east edges of the site (lines 0 to 3 at the
# south end, all of line 3, the north end of line 4), so four control points (GCP1, GCP2, GCP3,
# GCP5) and three checkpoints (CHK2, CHK3, CHK4) are each well inside three photos or more, and
# CHK1 in two. SYN_0023 is the duplicate's source.
MINI_NADIR = tuple(f"SYN_{k:04d}.JPG" for k in (1, 2, 19, 21, 22, 23, 24, *range(31, 41), 49, 50))
#: One more station, only in the mini set: the south end of line 0, one spacing before SYN_0001.
#: GCP1 sits in the corner of the site, well inside only two photos of the grid (SYN_0019 has it
#: 3 px from its edge).
MINI_EXTRA = "SYN_0000.JPG"


def mini_extra_shot(scene: Scene, seed: int, flight: FlightPlan = FLIGHT) -> Shot:
    """The mini set's extra station (``MINI_EXTRA``): line 0 flown one station further south."""
    rng = np.random.default_rng(seed + 2)
    zt = float(scene.ground(np.array([flight.takeoff[0]]), np.array([flight.takeoff[1]]))[0])
    j = rng.normal(0, 1, 6)
    x, y = flight.lines_x[0], flight.first_y - flight.spacing
    c = np.array([x + 0.6 * j[0], y + 0.5 * j[1], zt + flight.altitude_agl + 0.4 * j[2]])
    return Shot(
        MINI_EXTRA, "nadir", c, 1.5 * j[3], -90.0 + 0.8 * j[4], 0.8 * j[5], _time(flight.start, -2.0), line=0
    )


def mini_shots(scene: Scene, seed: int) -> list[Shot]:
    """The mini set at 960 x 720: the extra station, 19 nadir photos of the grid (``MINI_NADIR``)
    and the five bad images. The grid photos have the same names and poses as in the quick set."""
    grid = [s for s in plan_shots(scene, seed) if s.name in MINI_NADIR or s.kind not in ("nadir", "oblique")]
    return [mini_extra_shot(scene, seed), *grid]


# Everything above decides the pixels of a photo (scene, camera, flight, rendering): the render
# cache key hashes it. Below: metadata, truth and side files, written fresh on every run.
# ===================================================================== end of the rendered part


# --------------------------------------------------------------------------------------- metadata


def _rational(x: float, den: int = 10000) -> IFDRational:
    return IFDRational(round(x * den), den)


def _dms(deg: float) -> tuple[IFDRational, IFDRational, IFDRational]:
    deg = abs(deg)
    d = int(deg)
    m = int((deg - d) * 60)
    s = (deg - d - m / 60) * 3600
    return (IFDRational(d, 1), IFDRational(m, 1), _rational(s, 1000000))


def exif_segment(
    cam: Camera, taken_at: str, gps: tuple[float, float, float] | None, software: str = GENERATOR
) -> bytes:
    """An APP1 EXIF segment as a DJI camera writes it, without a serial number."""
    ex = Image.Exif()
    t = taken_at.replace("-", ":").replace("T", " ")
    ex[271] = MAKE
    ex[272] = MODEL
    ex[305] = software
    ex[306] = t
    ex[274] = 1
    sub = ex.get_ifd(0x8769)
    sub[36867] = t
    sub[36868] = t
    sub[37386] = _rational(cam.focal_mm, 100)
    sub[41989] = round(cam.focal_mm * 43.27 / math.hypot(cam.sensor_w_mm, cam.sensor_h_mm))
    sub[40962] = cam.width
    sub[40963] = cam.height
    sub[41486] = _rational(cam.width / cam.sensor_w_mm, 1000)
    sub[41487] = _rational(cam.height / cam.sensor_h_mm, 1000)
    sub[41488] = 4  # millimetres
    if gps is not None:
        lat, lon, alt = gps
        g = ex.get_ifd(0x8825)
        g[1] = "N" if lat >= 0 else "S"
        g[2] = _dms(lat)
        g[3] = "E" if lon >= 0 else "W"
        g[4] = _dms(lon)
        g[5] = 0 if alt >= 0 else 1
        g[6] = _rational(abs(alt), 1000)
        g[18] = "WGS-84"
    payload = ex.tobytes()
    if not payload.startswith(b"Exif\x00\x00"):
        payload = b"Exif\x00\x00" + payload
    return b"\xff\xe1" + struct.pack(">H", len(payload) + 2) + payload


def xmp_segment(fields: dict[str, Any]) -> bytes:
    """An APP1 XMP segment with DJI ``drone-dji`` attributes."""
    attrs = " ".join(f'drone-dji:{k}="{v}"' for k, v in fields.items())
    xmp = (
        '<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>'
        '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
        '<rdf:Description rdf:about="" xmlns:tiff="http://ns.adobe.com/tiff/1.0/" '
        'xmlns:drone-dji="http://www.dji.com/drone-dji/1.0/" '
        f'tiff:Make="{MAKE}" tiff:Model="{MODEL}" {attrs}/>'
        '</rdf:RDF></x:xmpmeta><?xpacket end="w"?>'
    ).encode()
    payload = b"http://ns.adobe.com/xap/1.0/\x00" + xmp
    return b"\xff\xe1" + struct.pack(">H", len(payload) + 2) + payload


def with_metadata(jpeg: bytes, *segments: bytes) -> bytes:
    """Insert APP segments right after SOI (no re-encoding: the pixels stay byte for byte)."""
    assert jpeg[:2] == b"\xff\xd8"
    return jpeg[:2] + b"".join(segments) + jpeg[2:]


@dataclass(frozen=True)
class Variant:
    """How the geotags were made: standard GNSS (metres, a datum offset on the altitude) or RTK."""

    name: str
    sigma_h: float
    sigma_v: float
    bias_h: float  # a constant horizontal bias of the whole flight (standard GNSS), metres
    alt_offset: float  # AbsoluteAltitude minus the true ellipsoidal height, metres
    rtk: bool


VARIANTS = {
    "standard": Variant("standard", 2.5, 4.0, 1.2, -21.7, False),
    "rtk": Variant("rtk", 0.02, 0.03, 0.0, 0.0, True),
}


def geotags(shots: list[Shot], variant: Variant, seed: int, takeoff_z: float) -> dict[str, dict[str, Any]]:
    """The values written into each photo (seeded per variant): lat, lon, absolute and relative
    altitude, gimbal and flight angles, RTK fields."""
    rng = np.random.default_rng(seed + (11 if variant.rtk else 13))
    bias = rng.normal(0, variant.bias_h, 2)
    zt = SITE.origin[2] + takeoff_z
    out: dict[str, dict[str, Any]] = {}
    for s in shots:
        n = rng.normal(0, 1, 6)
        e_, n_, h_ = local_to_world(s.centre)
        e_ += bias[0] + variant.sigma_h * n[0]
        n_ += bias[1] + variant.sigma_h * n[1]
        lon, lat = utm_to_lonlat(SITE.epsg, e_, n_)
        absolute = h_ + variant.alt_offset + variant.sigma_v * n[2]
        relative = h_ - zt + 0.15 * n[3]
        rec: dict[str, Any] = {
            "lat": round(lat, 9),
            "lon": round(lon, 9),
            "absoluteAltitude": round(absolute, 3),
            "relativeAltitude": round(relative, 3),
            "gimbal": {"yaw": _r(_yaw180(s.yaw), 2), "pitch": _r(s.pitch, 2), "roll": _r(s.roll, 2)},
            "flight": {
                "yaw": _r(_yaw180(s.yaw + 0.8 * n[4]), 2),
                "pitch": _r(2.0 + 0.5 * n[5], 2),
                "roll": 0.0,
            },
        }
        if variant.rtk:
            rec["rtk"] = {
                "flag": 50,
                "stdLon": round(abs(variant.sigma_h * (1 + 0.2 * n[4])), 5),
                "stdLat": round(abs(variant.sigma_h * (1 + 0.2 * n[5])), 5),
                "stdHgt": round(abs(variant.sigma_v * (1 + 0.2 * n[3])), 5),
            }
        out[s.name] = rec
    return out


def _yaw180(y: float) -> float:
    return (y + 180.0) % 360.0 - 180.0


def photo_metadata(cam: Camera, shot: Shot, tag: dict[str, Any] | None) -> list[bytes]:
    """The APP1 segments of one photo (none of them for the no-GPS photo's GPS)."""
    gps = None if tag is None or shot.kind == "no-gps" else (tag["lat"], tag["lon"], tag["absoluteAltitude"])
    segs = [exif_segment(cam, shot.taken_at, gps)]
    if tag is not None:
        f: dict[str, Any] = {}
        if shot.kind != "no-gps":
            f["AbsoluteAltitude"] = f"{tag['absoluteAltitude']:+.3f}"
        f["RelativeAltitude"] = f"{tag['relativeAltitude']:+.3f}"
        for k in ("Roll", "Yaw", "Pitch"):
            f[f"Gimbal{k}Degree"] = f"{tag['gimbal'][k.lower()]:+.2f}"
        for k in ("Roll", "Yaw", "Pitch"):
            f[f"Flight{k}Degree"] = f"{tag['flight'][k.lower()]:+.2f}"
        f["CalibratedFocalLength"] = f"{CAMERA.focal_mm / CAMERA.sensor_w_mm * CAMERA.width:.6f}"
        f["CalibratedOpticalCenterX"] = f"{CAMERA.width / 2:.6f}"
        f["CalibratedOpticalCenterY"] = f"{CAMERA.height / 2:.6f}"
        if "rtk" in tag and shot.kind != "no-gps":
            f["GpsStatus"] = "RTK"
            f["RtkFlag"] = str(tag["rtk"]["flag"])
            f["RtkStdLon"] = f"{tag['rtk']['stdLon']:.5f}"
            f["RtkStdLat"] = f"{tag['rtk']['stdLat']:.5f}"
            f["RtkStdHgt"] = f"{tag['rtk']['stdHgt']:.5f}"
        elif shot.kind != "no-gps":
            f["GpsStatus"] = "Normal"
        segs.append(xmp_segment(f))
    return segs


# ------------------------------------------------------------------------------------- truth


def visible(scene: Scene, cam: Camera, shot: Shot, p_local: np.ndarray, margin: float = 2.0):
    """Pixel positions of points in a shot, or None where outside the frame or hidden."""
    px, z = project(cam, shot, p_local)
    out: list[list[float] | None] = []
    for i in range(len(px)):
        u, v = px[i]
        if not (margin <= u <= cam.width - margin and margin <= v <= cam.height - margin):
            out.append(None)
            continue
        dvec = p_local[i] - shot.centre
        dist = float(np.linalg.norm(dvec))
        d = (dvec / dist)[None, :]
        t, _, _ = scene.trace(shot.centre, d)
        out.append([float(u), float(v)] if abs(float(t[0]) - dist) < 0.01 else None)
    return out


def target_points(scene: Scene) -> dict[str, np.ndarray]:
    xs = np.array([t.x for t in TARGETS])
    ys = np.array([t.y for t in TARGETS])
    zs = scene.ground(xs, ys)
    return {t.id: np.array([t.x, t.y, z]) for t, z in zip(TARGETS, zs, strict=True)}


def build_truth(
    scene: Scene, cam: Camera, shots: list[Shot], seed: int, size: str, variant: Variant, tags
) -> dict[str, Any]:
    tp = target_points(scene)
    pts = np.array([tp[t.id] for t in TARGETS])
    obs: dict[str, list[dict[str, Any]]] = {t.id: [] for t in TARGETS}
    photos = []
    for s in shots:
        R = s.rotation
        rec: dict[str, Any] = {
            "name": s.name,
            "kind": s.kind,
            "expect": s.expect,
            "takenAt": s.taken_at,
            "centre": [_r(v, 4) for v in local_to_world(s.centre)],
            "rotation": [[_r(v, 9) for v in row] for row in R],
            "gimbal": {"yaw": _r(s.yaw, 4), "pitch": _r(s.pitch, 4), "roll": _r(s.roll, 4)},
        }
        if s.reason:
            rec["reason"] = s.reason
        if s.line is not None:
            rec["line"] = s.line
        if s.source:
            rec["duplicateOf"] = s.source
        if s.kind != "no-gps":
            rec["geotag"] = tags[s.name]
        else:
            rec["geotag"] = {
                k: v for k, v in tags[s.name].items() if k in ("relativeAltitude", "gimbal", "flight")
            }
        photos.append(rec)
        if s.kind in ("nadir", "oblique", "no-gps"):
            for t, uv in zip(TARGETS, visible(scene, cam, s, pts), strict=True):
                if uv is not None:
                    obs[t.id].append({"photo": s.name, "px": [_r(uv[0], 4), _r(uv[1], 4)]})
    targets = []
    for t in TARGETS:
        true = local_to_world(tp[t.id])
        stated = [true[i] + t.stated_offset[i] for i in range(3)]
        targets.append(
            {
                "id": t.id,
                "role": t.role,
                "xyz": [_r(v, 4) for v in true],
                "stated": [_r(v, 4) for v in stated],
                "local": [_r(v, 4) for v in tp[t.id]],
                "sizeM": t.size,
                "observations": obs[t.id],
            }
        )
    takeoff = local_to_world(
        [
            *FLIGHT.takeoff,
            float(scene.ground(np.array([FLIGHT.takeoff[0]]), np.array([FLIGHT.takeoff[1]]))[0]),
        ]
    )
    lon0, lat0 = utm_to_lonlat(SITE.epsg, SITE.origin[0], SITE.origin[1])
    gsd = cam.gsd_cm(FLIGHT.altitude_agl)
    # a known ground height (the take-off point) for terrain packs made from the true DTM
    blon, blat = utm_to_lonlat(SITE.epsg, takeoff[0], takeoff[1])
    benchmark = {
        "name": "take-off point",
        "xyz": [_r(v, 4) for v in takeoff],
        "lonLat": [round(blon, 9), round(blat, 9)],
        "heightM": _r(takeoff[2], 4),
        "datum": "ellipsoid (WGS 84)",
    }
    return {
        "schema": "aio.photo-truth/1",
        "generator": {"name": GENERATOR, "seed": seed, "set": size, "variant": variant.name},
        "site": {
            "name": SITE.name,
            "crs": {"epsg": SITE.epsg},
            "heights": "ellipsoidal (WGS 84)",
            "origin": list(SITE.origin),
            "lonLat": [round(lon0, 9), round(lat0, 9)],
            "benchmark": benchmark,
            "localFrame": "x east, y north, z up; metres from origin in the projected grid",
        },
        "conventions": {
            "rotation": "world to camera: rows are the camera x (right), y (down), z (forward) axes in the local frame",
            "pixels": "(0, 0) is the top-left corner of the top-left pixel; its centre is (0.5, 0.5)",
            "gimbal": "DJI: yaw clockwise from north, pitch from the horizon (-90 down), roll clockwise seen from behind",
        },
        "camera": cam.to_json(),
        "cameraFull": CAMERA.to_json(),
        "gsdCm": _r(gsd, 4),
        "flight": {
            "altitudeAglM": FLIGHT.altitude_agl,
            "forwardOverlap": 0.8,
            "sideOverlap": 0.7,
            "takeoff": [_r(v, 4) for v in takeoff],
        },
        "geotags": {
            "variant": variant.name,
            "sigmaHorizontalM": variant.sigma_h,
            "sigmaVerticalM": variant.sigma_v,
            "flightBiasSigmaM": variant.bias_h,
            "absoluteAltitudeOffsetM": variant.alt_offset,
            "rtk": variant.rtk,
            "note": "AbsoluteAltitude = true ellipsoidal height + offset + noise; RelativeAltitude above take-off",
        },
        "photos": photos,
        "registration": {
            "expected": sum(1 for p in photos if p["expect"] == "register"),
            "rejected": [
                {"name": p["name"], "reason": p["reason"]} for p in photos if p["expect"] == "reject"
            ],
            "either": [{"name": p["name"], "reason": p["reason"]} for p in photos if p["expect"] == "either"],
        },
        "targets": targets,
        "scene": {
            "stockpile": {
                "centre": [_r(v, 4) for v in local_to_world([*STOCKPILE["centre"], 0.0])][:2],
                "radiusM": STOCKPILE["radius"],
                "heightM": STOCKPILE["height"],
                "slopeDeg": STOCKPILE["slopeDeg"],
                "volumeM3": _r(stockpile_volume(), 3),
                "volumeNote": "above the original ground (the terrain without the pile)",
            },
            "pit": {
                "centre": [_r(v, 4) for v in local_to_world([*PIT["centre"], 0.0])][:2],
                "radiusM": PIT["radius"],
                "depthM": PIT["depth"],
                "volumeM3": _r(pit_volume(), 3),
            },
            "objects": [
                {
                    "name": o.name,
                    "kind": o.kind,
                    "min": [_r(v, 4) for v in local_to_world(o.lo)],
                    "max": [_r(v, 4) for v in local_to_world(o.hi)],
                }
                for o in scene.objects
            ],
            "water": {
                "centre": [_r(v, 4) for v in local_to_world([*WATER["centre"], 0.0])][:2],
                "radiusM": WATER["radius"],
            },
            "solarPanels": {
                "min": [_r(v, 4) for v in local_to_world([SOLAR["x"][0], SOLAR["y"][0], 0.0])][:2],
                "max": [_r(v, 4) for v in local_to_world([SOLAR["x"][1], SOLAR["y"][1], 0.0])][:2],
                "periodM": SOLAR["period"],
            },
        },
        "grids": {
            "dsm": "truth/dsm.tif",
            "dtm": "truth/dtm.tif",
            "ortho": "truth/ortho.tif",
            "resolutionM": GRID_RES,
            "bounds": list(GRID_BOUNDS),
            "note": "cell centres; heights ellipsoidal; bounds local west, south, east, north",
        },
        "mesh": {
            "file": "truth/mesh.glb",
            "frame": "glTF: Y up; X east, Y up, Z south, metres from origin (projected grid offsets)",
        },
        "tiles": {
            "truth-mesh": "tiles/truth-mesh/tileset.json",
            "truth-cloud": "tiles/truth-cloud/tileset.json",
            "frame": "3D Tiles 1.1: east-north-up at the origin, every vertex through geodetic and ECEF",
        },
        "files": {
            "photos": "photos/",
            "gcp": "gcp.csv",
            "gcpBlunder": "gcp-blunder.csv",
            "gcpList": "gcp_list.txt",
            "ppk": "ppk.csv",
            "hashes": "images.sha256",
            "alignment": "alignment/alignment.json",
            "sparse": "alignment/sparse/",
        },
    }


GRID_RES = 0.25
GRID_BOUNDS = (-100.0, -100.0, 100.0, 100.0)  # local west, south, east, north


def write_grids(scene: Scene, out: Path) -> None:
    import rasterio
    from rasterio.transform import from_origin

    x0, y0, x1, y1 = GRID_BOUNDS
    n = round((x1 - x0) / GRID_RES)
    m = round((y1 - y0) / GRID_RES)
    xs = x0 + (np.arange(n) + 0.5) * GRID_RES
    ys = y1 - (np.arange(m) + 0.5) * GRID_RES
    X, Y = np.meshgrid(xs, ys)
    out.mkdir(parents=True, exist_ok=True)
    for name, z in (("dtm", scene.ground(X, Y)), ("dsm", scene.dsm(X, Y))):
        with rasterio.open(
            out / f"{name}.tif",
            "w",
            driver="GTiff",
            height=m,
            width=n,
            count=1,
            dtype="float32",
            crs=f"EPSG:{SITE.epsg}",
            transform=from_origin(SITE.origin[0] + x0, SITE.origin[1] + y1, GRID_RES, GRID_RES),
            compress="deflate",
            predictor=3,
        ) as d:
            d.write((z + SITE.origin[2]).astype(np.float32), 1)


def truth_mesh(scene: Scene, res: float = 1.0):
    """The true surface as a trimesh (local frame converted to glTF: X east, Y up, Z south)."""
    import trimesh

    x0, y0, x1, y1 = GRID_BOUNDS
    xs = np.arange(x0, x1 + res / 2, res)
    ys = np.arange(y0, y1 + res / 2, res)
    X, Y = np.meshgrid(xs, ys)
    Z = scene.ground(X, Y)
    nx, ny = len(xs), len(ys)
    verts = np.stack([X.ravel(), Y.ravel(), Z.ravel()], axis=1)
    i = np.arange(nx - 1)[None, :] + nx * np.arange(ny - 1)[:, None]
    i = i.ravel()
    faces = np.concatenate([np.stack([i, i + 1, i + nx + 1], 1), np.stack([i, i + nx + 1, i + nx], 1)])
    parts = [trimesh.Trimesh(verts, faces, process=False)]
    for o in scene.objects:
        if isinstance(o, Box):
            m = trimesh.creation.box(extents=[2 * o.h[0], 2 * o.h[1], o.z1 - o.z0])
            m.apply_transform(trimesh.transformations.rotation_matrix(math.radians(o.yaw), [0, 0, 1]))
            m.apply_translation([o.c[0], o.c[1], (o.z0 + o.z1) / 2])
        elif isinstance(o, Tank):
            m = trimesh.creation.cylinder(radius=o.r, height=o.z1 - o.z0, sections=64)
            m.apply_translation([o.c[0], o.c[1], (o.z0 + o.z1) / 2])
        else:
            assert isinstance(o, Pipe)
            m = trimesh.creation.cylinder(radius=o.r, height=o.x1 - o.x0, sections=24)
            m.apply_transform(trimesh.transformations.rotation_matrix(math.pi / 2, [0, 1, 0]))
            m.apply_translation([(o.x0 + o.x1) / 2, o.y, o.z])
        parts.append(m)
    mesh = trimesh.util.concatenate(parts)
    # local (x east, y north, z up) to glTF (X east, Y up, Z south)
    v = mesh.vertices.copy()
    mesh.vertices = np.stack([v[:, 0], v[:, 2], -v[:, 1]], axis=1)
    return mesh


def write_mesh(scene: Scene, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(truth_mesh(scene).export(file_type="glb"))


def top_colour(scene: Scene, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Colour of the top surface seen from straight above, lit by the sun (no shadows)."""
    z = scene.ground(x, y)
    col = scene.ground_albedo(x, y)
    zt = z.copy()
    for o in scene.objects:
        top = o.top(x, y)
        m = np.nonzero(top > zt)[0]
        if m.size:
            p = np.stack([x[m], y[m], top[m]], axis=1)
            col[m] = o.albedo(p, np.tile([0.0, 0.0, 1.0], (m.size, 1)))
            zt[m] = top[m]
    _, gx, gy = scene.ground(x, y, grad=True)
    on_ground = zt <= z
    n = np.stack([np.where(on_ground, -gx, 0), np.where(on_ground, -gy, 0), np.ones_like(x)], axis=1)
    n /= np.linalg.norm(n, axis=1)[:, None]
    return np.clip(col * (0.36 + 0.72 * np.maximum(n @ SUN, 0))[:, None], 0, 1)


def write_ortho(scene: Scene, path: Path) -> None:
    """The true orthophoto (top colours at the truth grids' cells), an RGB GeoTIFF."""
    import rasterio
    from rasterio.transform import from_origin

    x0, y0, x1, y1 = GRID_BOUNDS
    n = round((x1 - x0) / GRID_RES)
    X, Y = np.meshgrid(x0 + (np.arange(n) + 0.5) * GRID_RES, y1 - (np.arange(n) + 0.5) * GRID_RES)
    rgb = (top_colour(scene, X.ravel(), Y.ravel()) * 255).round().astype(np.uint8).reshape(n, n, 3)
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        height=n,
        width=n,
        count=3,
        dtype="uint8",
        crs=f"EPSG:{SITE.epsg}",
        transform=from_origin(SITE.origin[0] + x0, SITE.origin[1] + y1, GRID_RES, GRID_RES),
        compress="deflate",
        photometric="RGB",
    ) as d:
        d.write(np.moveaxis(rgb, 2, 0))


# ------------------------------------------------------------------------ ECEF and 3D Tiles

_E2 = _F * (2 - _F)


def utm_to_lonlat_np(epsg: int, e: np.ndarray, n: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """``utm_to_lonlat`` for arrays (radians out)."""
    zone, south = _zone(epsg)
    xi = (n - (10000000.0 if south else 0.0)) / (_K0 * _AA)
    eta = (e - 500000.0) / (_K0 * _AA)
    xp, ep = xi.copy(), eta.copy()
    for j, b in enumerate(_BETA, 1):
        xp -= b * np.sin(2 * j * xi) * np.cosh(2 * j * eta)
        ep -= b * np.cos(2 * j * xi) * np.sinh(2 * j * eta)
    chi = np.arcsin(np.sin(xp) / np.cosh(ep))
    lat = chi + sum(d * np.sin(2 * j * chi) for j, d in enumerate(_DELTA, 1))
    lon = math.radians(zone * 6 - 183) + np.arctan2(np.sinh(ep), np.cos(xp))
    return lon, lat


def ecef(lon: np.ndarray, lat: np.ndarray, h: np.ndarray) -> np.ndarray:
    """Geodetic (radians, ellipsoidal metres) to ECEF metres, (n, 3)."""
    nn = _A / np.sqrt(1 - _E2 * np.sin(lat) ** 2)
    return np.stack(
        [
            (nn + h) * np.cos(lat) * np.cos(lon),
            (nn + h) * np.cos(lat) * np.sin(lon),
            (nn * (1 - _E2) + h) * np.sin(lat),
        ],
        axis=1,
    )


def enu_frame(site: Site = SITE) -> tuple[np.ndarray, np.ndarray]:
    """The east-north-up frame at the site origin: (rows east, north, up; origin in ECEF)."""
    lon, lat = utm_to_lonlat_np(site.epsg, np.array([site.origin[0]]), np.array([site.origin[1]]))
    o = ecef(lon, lat, np.array([site.origin[2]]))[0]
    sl, cl, sp, cp = math.sin(lon[0]), math.cos(lon[0]), math.sin(lat[0]), math.cos(lat[0])
    rows = np.array([[-sl, cl, 0.0], [-sp * cl, -sp * sl, cp], [cp * cl, cp * sl, sp]])
    return rows, o


def local_to_enu(p_local: np.ndarray, site: Site = SITE) -> np.ndarray:
    """Local grid offsets (x east, y north, z up from the origin, in the projected CRS) to true
    east-north-up metres at the origin, per point through geodetic coordinates and ECEF (never a
    UTM-as-metres shortcut: the grid's scale and convergence are a few centimetres per 100 m)."""
    p = np.asarray(p_local, dtype=np.float64)
    lon, lat = utm_to_lonlat_np(site.epsg, p[:, 0] + site.origin[0], p[:, 1] + site.origin[1])
    xyz = ecef(lon, lat, p[:, 2] + site.origin[2])
    rows, o = enu_frame(site)
    return (xyz - o) @ rows.T


def _tileset(content: str, enu: np.ndarray) -> dict[str, Any]:
    rows, o = enu_frame()
    m = np.eye(4)
    m[:3, :3] = rows.T  # columns: east, north, up in ECEF
    m[:3, 3] = o
    lo, hi = enu.min(axis=0), enu.max(axis=0)
    c, h = (lo + hi) / 2, (hi - lo) / 2 + 0.01
    return {
        "asset": {"version": "1.1", "generator": GENERATOR},
        "geometricError": 100,
        "root": {
            # east-north-up at the site origin; content is glTF (Y up), so X east, Y up, Z south
            "transform": [_r(v, 12) for v in m.T.ravel()],
            "boundingVolume": {"box": [_r(v, 4) for v in (*c, h[0], 0, 0, 0, h[1], 0, 0, 0, h[2])]},
            "geometricError": 0,
            "refine": "REPLACE",
            "content": {"uri": content},
        },
    }


def write_tiles(scene: Scene, out: Path) -> dict[str, str]:
    """3D Tiles 1.1 of the true surface: ``truth-mesh`` (the truth mesh with vertex colours) and
    ``truth-cloud`` (points every 0.5 m on the top surface), each one tile in east-north-up at the
    origin with every vertex converted through the CRS. Returns {id: tileset path}."""
    import trimesh

    mesh = truth_mesh(scene)
    v = mesh.vertices
    local = np.stack([v[:, 0], -v[:, 2], v[:, 1]], axis=1)
    enu = local_to_enu(local)
    col = top_colour(scene, local[:, 0], local[:, 1])
    mesh.vertices = np.stack([enu[:, 0], enu[:, 2], -enu[:, 1]], axis=1)
    mesh.visual = trimesh.visual.ColorVisuals(mesh, vertex_colors=(col * 255).round().astype(np.uint8))
    step = 0.5
    x0, y0, x1, y1 = GRID_BOUNDS
    X, Y = np.meshgrid(np.arange(x0 + step / 2, x1, step), np.arange(y0 + step / 2, y1, step))
    x, y = X.ravel(), Y.ravel()
    pts_local = np.stack([x, y, scene.dsm(x, y)], axis=1)
    pts = local_to_enu(pts_local)
    cloud = trimesh.PointCloud(
        np.stack([pts[:, 0], pts[:, 2], -pts[:, 1]], axis=1),
        colors=(top_colour(scene, x, y) * 255).round().astype(np.uint8),
    )
    made = {}
    for tid, geom, enu_pts, name in (
        ("truth-mesh", mesh, enu, "mesh.glb"),
        ("truth-cloud", cloud, pts, "cloud.glb"),
    ):
        d = out / tid
        d.mkdir(parents=True, exist_ok=True)
        (d / name).write_bytes(geom.export(file_type="glb"))
        (d / "tileset.json").write_text(json.dumps(_tileset(name, enu_pts), indent=2) + "\n", encoding="utf8")
        made[tid] = f"{tid}/tileset.json"
    return made


# ---------------------------------------------------------------- precomputed alignment (the demo)

# A GNSS-only alignment is off from the truth by a small similarity (the flight's GNSS bias). The
# demo's precomputed alignment applies this one, so predicted GCP marks land near the targets, not
# on them, as they do after a real ``photo.align``; marking and ``photo.georef`` close the gap.
ALIGN_SHIFT = (1.1, -0.7, 0.9)
ALIGN_ROT_DEG = 0.015
ALIGN_SCALE = 1.0003


def _similarity() -> tuple[float, np.ndarray, np.ndarray]:
    a = math.radians(ALIGN_ROT_DEG)
    rot = np.array([[math.cos(a), -math.sin(a), 0.0], [math.sin(a), math.cos(a), 0.0], [0.0, 0.0, 1.0]])
    return ALIGN_SCALE, rot, np.array(ALIGN_SHIFT)


def aligned(p_local) -> np.ndarray:
    """Where the precomputed (GNSS-only) alignment puts local points."""
    s, rot, t = _similarity()
    return s * (np.atleast_2d(np.asarray(p_local, dtype=np.float64)) @ rot.T) + t


def _project_rc(cam: Camera, centre: np.ndarray, rot: np.ndarray, p: np.ndarray) -> np.ndarray:
    xc = (np.atleast_2d(p) - centre) @ rot.T
    with np.errstate(divide="ignore", invalid="ignore"):
        x, y = xc[:, 0] / xc[:, 2], xc[:, 1] / xc[:, 2]
        xd, yd = cam.distort(x, y)
    uv = np.stack([cam.fx * xd + cam.cx, cam.fy * yd + cam.cy], axis=1)
    uv[(xc[:, 2] <= 0) | (x * x + y * y > 1.1 * cam.r2_max())] = np.nan
    return uv


def _quat(rot: np.ndarray) -> tuple[float, float, float, float]:
    """Hamilton quaternion (w, x, y, z) of a rotation matrix, w >= 0."""
    m = rot
    tr = m[0, 0] + m[1, 1] + m[2, 2]
    if tr > 0:
        s = math.sqrt(tr + 1.0) * 2
        q = (0.25 * s, (m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s)
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        q = ((m[2, 1] - m[1, 2]) / s, 0.25 * s, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s)
    elif m[1, 1] > m[2, 2]:
        s = math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        q = ((m[0, 2] - m[2, 0]) / s, (m[0, 1] + m[1, 0]) / s, 0.25 * s, (m[1, 2] + m[2, 1]) / s)
    else:
        s = math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        q = ((m[1, 0] - m[0, 1]) / s, (m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, 0.25 * s)
    return q if q[0] >= 0 else (-q[0], -q[1], -q[2], -q[3])


def write_alignment(
    scene: Scene,
    cam: Camera,
    shots: list[Shot],
    truth: dict[str, Any],
    out: Path,
    seed: int,
    n_points: int = 4000,
) -> dict[str, Any]:
    """The demo's precomputed ``photo.align``: ``alignment.json`` (aligned cameras, GCP predictions
    per photo, the GNSS-only residual of every target, rejected photos) and ``sparse/`` (a COLMAP
    text model: one FULL_OPENCV camera, the registered images and points on the true surface seen
    in at least three photos, with 0.3 px observation noise). Coordinates are the local frame of
    the truth (x east, y north, z up from the site origin, metres in EPSG:32639 and ellipsoidal
    heights), after the alignment's similarity."""
    rng = np.random.default_rng(seed + 23)
    s, rot, t = _similarity()
    by_name = {p["name"]: p for p in truth["photos"]}
    registered = [sh for sh in shots if sh.kind in ("nadir", "oblique", "no-gps")]
    cams = [(sh, aligned(sh.centre)[0], sh.rotation @ rot.T) for sh in registered]
    gsd = cam.gsd_cm(FLIGHT.altitude_agl) / 100
    radius = round(3 * float(np.linalg.norm(t)) / gsd, 1)
    predictions: dict[str, list[dict[str, Any]]] = {}
    residuals: dict[str, list[float]] = {}
    for tg in truth["targets"]:
        if tg["role"] == "blunder":
            continue
        stated = np.array(world_to_local(tg["stated"]))
        true = np.array(tg["local"])
        residuals[tg["id"]] = [_r(v, 4) for v in (aligned(true)[0] - true)]
        seen = {o["photo"] for o in tg["observations"]}
        preds = []
        for sh, c, r in cams:
            if sh.name not in seen:
                continue
            uv = _project_rc(cam, c, r, stated)[0]
            if np.isfinite(uv).all() and 0 <= uv[0] <= cam.width and 0 <= uv[1] <= cam.height:
                preds.append({"photo": sh.name, "px": [_r(uv[0], 2), _r(uv[1], 2)], "radiusPx": radius})
        predictions[tg["id"]] = preds
    # camera residuals to their geotags (GNSS only: the bias shows here, honestly)
    res = []
    for sh, c, _ in cams:
        g = by_name[sh.name]["geotag"]
        if "lat" not in g:
            continue
        e, n = lonlat_to_utm(SITE.epsg, g["lon"], g["lat"])
        w = local_to_world(c)
        res.append(
            [w[0] - e, w[1] - n, w[2] - (g["absoluteAltitude"] - truth["geotags"]["absoluteAltitudeOffsetM"])]
        )
    res = np.array(res)
    rh = np.hypot(res[:, 0], res[:, 1])
    # sparse points on the true surface, with tracks
    x = rng.uniform(-90, 90, n_points * 2)
    y = rng.uniform(-90, 90, n_points * 2)
    pts = np.stack([x, y, scene.dsm(x, y)], axis=1)
    tracks: list[list[tuple[int, float, float]]] = [[] for _ in range(len(pts))]
    for k, (sh, _, _) in enumerate(cams):
        uv, z = project(cam, sh, pts)
        inside = np.isfinite(uv).all(axis=1) & (uv[:, 0] > 1) & (uv[:, 0] < cam.width - 1)
        inside &= (uv[:, 1] > 1) & (uv[:, 1] < cam.height - 1)
        idx = np.nonzero(inside)[0]
        if not idx.size:
            continue
        dvec = pts[idx] - sh.centre
        dist = np.linalg.norm(dvec, axis=1)
        tt, _, _ = scene.trace(sh.centre, dvec / dist[:, None])
        ok = idx[np.abs(tt - dist) < 0.02]
        noise = rng.normal(0, 0.3, (len(ok), 2))
        for j, i in enumerate(ok):
            tracks[i].append((k, uv[i, 0] + noise[j, 0], uv[i, 1] + noise[j, 1]))
    keep = [i for i in range(len(pts)) if len(tracks[i]) >= 3][:n_points]
    colours = top_colour(scene, pts[keep, 0], pts[keep, 1])
    sparse = out / "sparse"
    sparse.mkdir(parents=True, exist_ok=True)
    c = cam
    (sparse / "cameras.txt").write_text(
        "# Camera list with one line of data per camera:\n"
        "#   CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]\n"
        f"1 FULL_OPENCV {c.width} {c.height} {c.fx:.6f} {c.fy:.6f} {c.cx:.6f} {c.cy:.6f} "
        f"{c.k1} {c.k2} {c.p1} {c.p2} {c.k3} 0 0 0\n",
        encoding="utf8",
    )
    obs_of_image: list[list[tuple[float, float, int]]] = [[] for _ in cams]
    point_lines = []
    for pid, i in enumerate(keep, 1):
        track = []
        for k, u, v in tracks[i]:
            obs_of_image[k].append((u, v, pid))
            track.append(f"{k + 1} {len(obs_of_image[k]) - 1}")
        p = aligned(pts[i])[0]
        rgb = (colours[pid - 1] * 255).round().astype(int)
        point_lines.append(
            f"{pid} {p[0]:.4f} {p[1]:.4f} {p[2]:.4f} {rgb[0]} {rgb[1]} {rgb[2]} 0.30 {' '.join(track)}"
        )
    noise_px = np.hypot(*rng.normal(0, 0.3, (2, 4000)))
    (sparse / "points3D.txt").write_text(
        "# 3D point list with one line of data per point:\n"
        "#   POINT3D_ID, X, Y, Z, R, G, B, ERROR, TRACK[] as (IMAGE_ID, POINT2D_IDX)\n"
        + "\n".join(point_lines)
        + "\n",
        encoding="utf8",
    )
    image_lines = []
    for k, (sh, cc, r) in enumerate(cams):
        q = _quat(r)
        tv = -r @ cc
        image_lines.append(
            f"{k + 1} {q[0]:.9f} {q[1]:.9f} {q[2]:.9f} {q[3]:.9f} {tv[0]:.6f} {tv[1]:.6f} {tv[2]:.6f} 1 {sh.name}"
        )
        image_lines.append(" ".join(f"{u:.2f} {v:.2f} {pid}" for u, v, pid in obs_of_image[k]))
    (sparse / "images.txt").write_text(
        "# Image list with two lines of data per image:\n"
        "#   IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME\n"
        "#   POINTS2D[] as (X, Y, POINT3D_ID)\n" + "\n".join(image_lines) + "\n",
        encoding="utf8",
    )
    al = {
        "schema": "aio.photo-synth-alignment/1",
        "note": "Precomputed GNSS-only alignment of the synthetic set: the truth moved by a small "
        "similarity (the flight's GNSS bias), for UI tests and the demo. Not a pipeline output.",
        "frame": "local: x east, y north, z up, metres from the site origin (EPSG:32639, ellipsoidal heights)",
        "similarity": {"scale": ALIGN_SCALE, "rotationDeg": ALIGN_ROT_DEG, "shiftM": list(ALIGN_SHIFT)},
        "registered": [sh.name for sh, _, _ in cams],
        "rejected": [
            {"name": sh.name, "reason": sh.reason}
            for sh in shots
            if sh.expect == "reject" and sh.kind != "corrupt"
        ],
        "meanReprojPx": _r(float(noise_px.mean()), 3),
        "gsdCm": truth["gsdCm"],
        "cameras": [
            {
                "name": sh.name,
                "centre": [_r(v, 4) for v in local_to_world(cc)],
                "rotation": [[_r(v, 9) for v in row] for row in r],
            }
            for sh, cc, r in cams
        ],
        "cameraResiduals": {
            "medianM": _r(float(np.median(np.hypot(rh, res[:, 2]))), 3),
            "maxM": _r(float(np.hypot(rh, res[:, 2]).max()), 3),
            "rmseHorizontalM": _r(float(np.sqrt((rh**2).mean())), 3),
            "rmseVerticalM": _r(float(np.sqrt((res[:, 2] ** 2).mean())), 3),
        },
        "residuals": residuals,
        "predictions": predictions,
        "sparse": {"folder": "sparse/", "points": len(keep), "images": len(cams)},
    }
    (out / "alignment.json").write_text(json.dumps(al, indent=2) + "\n", encoding="utf8")
    return al


# ---------------------------------------------------------------------------------- generator


def source_hash() -> str:
    """Hash of this generator's source: cached renders of another version are not reused."""
    text = Path(__file__).read_bytes().replace(b"\r\n", b"\n")
    return hashlib.sha256(text.split(RENDER_END.encode())[0]).hexdigest()[:16]


def generate(
    out: Path | str,
    *,
    seed: int = DEFAULT_SEED,
    size: str = "quick",
    variant: str = "standard",
    workers: int | None = None,
    cache: Path | str | None = None,
    log: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """Write the photo set into ``out``: photos/, gcp.csv, gcp-blunder.csv, gcp_list.txt, ppk.csv,
    truth.json, truth/ (dsm.tif, dtm.tif, mesh.glb) and images.sha256. Returns the truth."""
    out = Path(out)
    log = log or (lambda m: None)
    scene = Scene(seed)
    cam = camera_for(size)
    shots = mini_shots(scene, seed) if size == "mini" else plan_shots(scene, seed)
    var = VARIANTS[variant]
    cache_dir = None
    if cache is not None:
        cache_dir = Path(cache) / f"{seed}-{size}-{source_hash()}"
        cache_dir.mkdir(parents=True, exist_ok=True)
    jobs = [(seed, size, s, str(cache_dir) if cache_dir else None) for s in shots if s.kind != "duplicate"]
    workers = workers or min(len(jobs), max(1, (os.cpu_count() or 2) - 1))
    log(f"rendering {len(jobs)} photos at {cam.width} x {cam.height} with {workers} workers")
    if workers > 1:
        with ProcessPoolExecutor(max_workers=workers) as ex:
            rendered = dict(ex.map(_render_job, jobs))
    else:
        rendered = dict(map(_render_job, jobs))
    zt = float(scene.ground(np.array([FLIGHT.takeoff[0]]), np.array([FLIGHT.takeoff[1]]))[0])
    tags = geotags(shots, var, seed, zt)
    photos = out / "photos"
    photos.mkdir(parents=True, exist_ok=True)
    hashes = []
    for s in shots:
        if s.kind == "duplicate":
            data = (photos / str(s.source)).read_bytes()
        else:
            data = with_metadata(rendered[s.name], *photo_metadata(cam, s, tags[s.name]))
            if s.kind == "corrupt":
                cut = len(data) * 2 // 5
                data = data[:cut] + bytes(4096) + data[cut + 4096 : cut + 8192]
        (photos / s.name).write_bytes(data)
        hashes.append(f"{hashlib.sha256(data).hexdigest()}  photos/{s.name}")
    (out / "images.sha256").write_text("\n".join(hashes) + "\n", encoding="utf8")
    truth = build_truth(scene, cam, shots, seed, size, var, tags)
    write_side_files(out, truth, seed)
    write_grids(scene, out / "truth")
    write_mesh(scene, out / "truth" / "mesh.glb")
    write_ortho(scene, out / "truth" / "ortho.tif")
    log("writing the tiles and the precomputed alignment")
    write_tiles(scene, out / "tiles")
    write_alignment(scene, cam, shots, truth, out / "alignment", seed)
    (out / "truth.json").write_text(json.dumps(truth, indent=2) + "\n", encoding="utf8")
    log(f"photo set written to {out}")
    return truth


def write_side_files(out: Path, truth: dict[str, Any], seed: int) -> None:
    """GCP files (CSV with roles, the blunder variant, ODM gcp_list.txt with 0.5 px mark noise)
    and the PPK positions CSV."""
    rows = [t for t in truth["targets"] if t["role"] != "blunder"]
    with (out / "gcp.csv").open("w", newline="", encoding="utf8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["id", "x", "y", "z", "role"])
        for t in rows:
            w.writerow([t["id"], *(f"{v:.4f}" for v in t["stated"]), t["role"]])
    with (out / "gcp-blunder.csv").open("w", newline="", encoding="utf8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["id", "x", "y", "z", "role"])
        for t in truth["targets"]:
            role = "control" if t["role"] == "blunder" else t["role"]
            w.writerow([t["id"], *(f"{v:.4f}" for v in t["stated"]), role])
    rng = np.random.default_rng(seed + 17)
    lines = [f"EPSG:{SITE.epsg}"]
    for t in rows:
        for o in t["observations"]:
            u, v = (o["px"][0] + 0.5 * rng.normal(), o["px"][1] + 0.5 * rng.normal())
            x, y, z = t["stated"]
            lines.append(f"{x:.4f} {y:.4f} {z:.4f} {u:.2f} {v:.2f} {o['photo']} {t['id']}")
    (out / "gcp_list.txt").write_text("\n".join(lines) + "\n", encoding="utf8")
    rng = np.random.default_rng(seed + 19)
    with (out / "ppk.csv").open("w", newline="", encoding="utf8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["image", "lat", "lon", "h", "sigma_h", "sigma_v"])
        for p in truth["photos"]:
            if p["kind"] in ("corrupt", "no-gps"):
                continue
            e, n, h = p["centre"]
            e += 0.015 * rng.normal()
            n += 0.015 * rng.normal()
            h += 0.025 * rng.normal()
            lon, lat = utm_to_lonlat(SITE.epsg, e, n)
            w.writerow([p["name"], f"{lat:.9f}", f"{lon:.9f}", f"{h:.3f}", "0.015", "0.025"])


def load_truth(folder: Path | str) -> dict[str, Any]:
    return json.loads((Path(folder) / "truth.json").read_text(encoding="utf8"))


# ------------------------------------------------------------------------------ pytest fixtures

try:  # the module also runs as a script without pytest
    import pytest
except ImportError:  # pragma: no cover
    pytest = None  # type: ignore[assignment]


@dataclass
class PhotoSet:
    """A generated set: its folder, the truth, and the photos folder."""

    root: Path
    truth: dict[str, Any]

    @property
    def photos(self) -> Path:
        return self.root / "photos"

    def photo(self, name: str) -> Path:
        return self.photos / name

    def target(self, tid: str) -> dict[str, Any]:
        return next(t for t in self.truth["targets"] if t["id"] == tid)

    def shot(self, name: str) -> dict[str, Any]:
        return next(p for p in self.truth["photos"] if p["name"] == name)


def photo_set_factory_impl(base: Path, cache: Path | None) -> Callable[..., PhotoSet]:
    made: dict[tuple, PhotoSet] = {}

    def make(size: str = "quick", variant: str = "standard", seed: int = DEFAULT_SEED) -> PhotoSet:
        key = (size, variant, seed)
        if key not in made:
            root = base / f"{size}-{variant}-{seed}"
            truth = generate(root, seed=seed, size=size, variant=variant, cache=cache)
            made[key] = PhotoSet(root, truth)
        return made[key]

    return make


if pytest is not None:

    @pytest.fixture(scope="session")
    def photo_set_factory(tmp_path_factory, request):
        """``make(size="quick"|"mini"|"full", variant="standard"|"rtk", seed=...)`` -> PhotoSet.
        Renders are cached across sessions in pytest's cache (by seed, size and generator hash)."""
        cache = Path(request.config.cache.mkdir("photo-synth"))
        return photo_set_factory_impl(tmp_path_factory.mktemp("photo-synth"), cache)

    @pytest.fixture(scope="session")
    def photo_set(photo_set_factory) -> PhotoSet:
        """The quick set (63 photos at 1600 x 1200), standard GNSS geotags."""
        return photo_set_factory("quick", "standard")

    @pytest.fixture(scope="session")
    def photo_set_rtk(photo_set_factory) -> PhotoSet:
        """The quick set with RTK geotags (2 cm, RtkFlag 50); the same pixels."""
        return photo_set_factory("quick", "rtk")

    @pytest.fixture(scope="session")
    def photo_mini(photo_set_factory) -> PhotoSet:
        """20 nadir photos and the five bad ones at 960 x 720 (``mini_shots``): about a minute."""
        return photo_set_factory("mini", "standard")


# ----------------------------------------------------------------------------------------- cli


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Synthetic photogrammetry set (no client data).")
    ap.add_argument("--out", required=True)
    ap.add_argument("--seed", type=int, default=DEFAULT_SEED)
    ap.add_argument("--full", action="store_true", help="full resolution (5280 x 3960), nightly")
    ap.add_argument("--mini", action="store_true", help="20 nadir and 5 bad photos at 960 x 720")
    ap.add_argument("--variant", choices=sorted(VARIANTS), default="standard")
    ap.add_argument("--workers", type=int, default=None)
    ap.add_argument("--cache", default=None, help="folder for cached renders")
    a = ap.parse_args(argv)
    size = "full" if a.full else "mini" if a.mini else "quick"
    generate(a.out, seed=a.seed, size=size, variant=a.variant, workers=a.workers, cache=a.cache, log=print)
    return 0


if __name__ == "__main__":
    sys.exit(main())
