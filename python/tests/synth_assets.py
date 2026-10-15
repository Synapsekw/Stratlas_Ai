"""Seeded synthetic assets (stack, flare, lattice tower, monopole) with known truth.

Local float64 coordinates near the origin: x east, y up, z south (so north is -z), the asset base at
the origin. Azimuths are compass degrees, 0 = north = -z, 90 = east = +x, clockwise. Lengths are in
metres, a member `size` is a diameter. The numbers mirror `STACK_TRUTH`, `FLARE_TRUTH`,
`LATTICE_TRUTH` and `MONOPOLE_TRUTH` in `packages/modelling/src/engineer/fixtures.ts` (a test keeps
them in step). Nothing here describes a real asset.
"""

from __future__ import annotations

import math
import struct
from pathlib import Path

import numpy as np

STACK = {
    "height": 120.0,
    "profile": [{"y": 0.0, "r": 9.0}, {"y": 55.0, "r": 6.5}, {"y": 120.0, "r": 6.5}],
    "flues": 3,
    "fluePitchR": 2.6,
    "flueAzimuths": [30.0, 150.0, 270.0],
    "flueR": 0.9,
    "flueHeight": 6.0,
    "lightLevels": [40.0, 80.0, 120.0],
    "lightsPerLevel": 3,
    "lightAzimuths": [0.0, 120.0, 240.0],
    "lightSize": 0.4,
    "bands": [[100.0, 104.0], [108.0, 112.0]],
}
FLARE = {
    "height": 60.0,
    "profile": [{"y": 0.0, "r": 1.2}, {"y": 60.0, "r": 0.8}],
    "tipR": 0.6,
    "tipHeight": 3.0,
    "pilots": 3,
    "platformLevels": [57.0],
    "ladder": True,
    "serviceLines": 1,
}
LATTICE = {
    "height": 40.0,
    "legs": 4,
    "widthBase": 6.0,
    "widthTop": 1.5,
    "bays": 8,
    "sectors": [0.0, 120.0, 240.0],
    "antennasPerSector": 2,
    "antennaSpread": 0.8,
    "antennaR": 2.1,
    "antennaY": 38.0,
}
MONOPOLE = {
    "height": 30.0,
    "profile": [{"y": 0.0, "r": 0.8}, {"y": 30.0, "r": 0.4}],
    "sides": 12,
    "antennas": 1,
    "antennaY": 28.0,
}

MISSING_SECTOR = (135.0, 225.0)  # the south, a quarter turn, dropped in a partial scan
GROUND_RADIUS = 40.0


def azimuth_deg(xyz: np.ndarray) -> np.ndarray:
    """Compass azimuth of each point about the vertical axis (0 = north = -z, clockwise)."""
    return np.degrees(np.arctan2(xyz[:, 0], -xyz[:, 2])) % 360.0


def toward(deg: float, r: float, y: float = 0.0) -> np.ndarray:
    t = math.radians(deg)
    return np.array([r * math.sin(t), y, -r * math.cos(t)])


def radius_at(profile: list[dict], y: float) -> float:
    return float(np.interp(y, [p["y"] for p in profile], [p["r"] for p in profile]))


def _ring(rng, n, r, y0, y1, centre=(0.0, 0.0)):
    """Points on a vertical cylinder wall of radius `r` between heights `y0` and `y1`."""
    y = rng.uniform(y0, y1, n)
    a = rng.uniform(0, 2 * math.pi, n)
    return np.column_stack([centre[0] + r * np.sin(a), y, centre[1] - r * np.cos(a)])


def _shaft(rng, n, profile, y0, y1, noise):
    y = rng.uniform(y0, y1, n)
    a = rng.uniform(0, 2 * math.pi, n)
    r = np.interp(y, [p["y"] for p in profile], [p["r"] for p in profile]) + rng.normal(0, noise, n)
    return np.column_stack([r * np.sin(a), y, -r * np.cos(a)])


def _disc(rng, n, r_in, r_out, y, noise):
    a = rng.uniform(0, 2 * math.pi, n)
    r = np.sqrt(rng.uniform(r_in**2, r_out**2, n))
    return np.column_stack([r * np.sin(a), y + rng.normal(0, noise, n), -r * np.cos(a)])


def _sphere(rng, n, centre, diameter):
    v = rng.normal(size=(n, 3))
    v /= np.linalg.norm(v, axis=1, keepdims=True)
    return np.asarray(centre) + v * (diameter / 2)


def _box(rng, n, centre, size):
    """Points on the surface of an axis-aligned box of full extents `size` (x, y, z)."""
    s = np.asarray(size, dtype=float)
    p = rng.uniform(-0.5, 0.5, (n, 3)) * s
    face = rng.integers(0, 3, n)
    p[np.arange(n), face] = rng.choice([-0.5, 0.5], n) * s[face]
    return np.asarray(centre) + p


def _segment(rng, n, a, b, radius, noise=0.0):
    """Points on a thin tube (radius `radius`) from `a` to `b`, plus optional isotropic noise."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    p = a + rng.uniform(0, 1, (n, 1)) * (b - a)
    v = rng.normal(size=(n, 3))
    v /= np.linalg.norm(v, axis=1, keepdims=True)
    p = p + v * radius
    return p + rng.normal(0, noise, p.shape) if noise else p


def _finish(parts, partial, ground, rng, noise, ground_n):
    pts = list(parts)
    if ground:
        pts.append(_disc(rng, ground_n, 0.0, GROUND_RADIUS, 0.0, noise))
    cloud = np.vstack(pts).astype(np.float64)
    if partial:
        az = azimuth_deg(cloud)
        cloud = cloud[~((az >= MISSING_SECTOR[0]) & (az < MISSING_SECTOR[1]))]
    return np.ascontiguousarray(cloud)


def _truth(height, profile, **extra):
    return {
        "axis": {"point": [0.0, 0.0, 0.0], "dir": [0.0, 1.0, 0.0]},
        "base": [0.0, 0.0, 0.0],
        "height": height,
        "profile": profile,
        **extra,
    }


def stack_cloud(seed=1, partial=False, noise=0.02, ground=True, points=60_000):
    """A noisy chimney: tapered shaft, flues out of the crown, lights at three levels, a ground disc.

    `partial` drops the southern quarter (azimuth 135 to 225, everything in it). `noise` is the
    standard deviation of the radial error on the shaft (and the vertical error on the ground).
    Returns (xyz, truth).
    """
    rng = np.random.default_rng(seed)
    S = STACK
    parts = [_shaft(rng, points, S["profile"], 0.0, S["height"], noise)]
    for az in S["flueAzimuths"]:
        c = toward(az, S["fluePitchR"])
        parts.append(
            _ring(rng, points // 40, S["flueR"], S["height"], S["height"] + S["flueHeight"], (c[0], c[2]))
        )
    lights = [
        toward(az, radius_at(S["profile"], h) + S["lightSize"], h)
        for h in S["lightLevels"]
        for az in S["lightAzimuths"]
    ]
    parts += [_sphere(rng, 60, c, S["lightSize"]) for c in lights]
    cloud = _finish(parts, partial, ground, rng, noise, points // 6)
    lo, hi = MISSING_SECTOR
    seen = [c for c in lights if not (partial and lo <= azimuth_deg(c[None, :])[0] < hi)]
    truth = _truth(
        S["height"],
        S["profile"],
        flues=S["flues"],
        fluePitchR=S["fluePitchR"],
        flueAzimuths=S["flueAzimuths"],
        flueDiameter=2 * S["flueR"],
        lightLevels=S["lightLevels"],
        lightsPerLevel=S["lightsPerLevel"],
        lightAzimuths=S["lightAzimuths"],
        lightDiameter=S["lightSize"],
        bands=S["bands"],
        partial=partial,
        missingSector=[lo, hi] if partial else None,
        noise=noise,
        lightsSeen=len(seen),
        # flues whose centre lies outside the missing sector (the one at 150 degrees is lost)
        fluesSeen=sum(not (partial and lo <= az < hi) for az in S["flueAzimuths"]),
    )
    return cloud, truth


def flare_cloud(seed=1, noise=0.01, ground=True, points=30_000):
    """A noisy flare stack: tapered riser, tip with pilots, caged ladder, platform, gas line."""
    rng = np.random.default_rng(seed)
    F = FLARE
    parts = [_shaft(rng, points, F["profile"], 0.0, F["height"], noise)]
    parts.append(_ring(rng, points // 10, F["tipR"], F["height"] + 0.05, F["height"] + F["tipHeight"]))
    pilot_az = [360.0 * i / F["pilots"] for i in range(F["pilots"])]
    parts += [
        _sphere(rng, 40, toward(az, F["tipR"] + 0.1, F["height"] + F["tipHeight"]), 0.15) for az in pilot_az
    ]
    parts += [_disc(rng, points // 10, 0.95, 2.4, level, noise) for level in F["platformLevels"]]
    parts.append(_segment(rng, points // 20, [1.5, 0, 0.25], [1.5, 57, 0.25], 0.03))
    parts.append(_segment(rng, points // 20, [1.5, 0, -0.25], [1.5, 57, -0.25], 0.03))
    parts.append(_segment(rng, points // 20, [-1.5, 0.5, 0], [-1.5, 56, 0], 0.1))
    cloud = _finish(parts, False, ground, rng, noise, points // 6)
    truth = _truth(
        F["height"],
        F["profile"],
        tipR=F["tipR"],
        tipHeight=F["tipHeight"],
        pilots=F["pilots"],
        pilotAzimuths=pilot_az,
        platformLevels=F["platformLevels"],
        ladder=F["ladder"],
        serviceLines=F["serviceLines"],
        noise=noise,
    )
    return cloud, truth


def lattice_cloud(seed=1, noise=0.01, ground=True, points=40_000):
    """A noisy four-legged lattice tower: tapered legs, X bracing in each bay, three antenna sectors."""
    rng = np.random.default_rng(seed)
    L = LATTICE
    bay_h = L["height"] / L["bays"]

    def half(y):
        return (L["widthBase"] + (L["widthTop"] - L["widthBase"]) * y / L["height"]) / 2

    corners = [(1, 1), (1, -1), (-1, -1), (-1, 1)]
    parts = []
    legs = []
    for sx, sz in corners:
        h0, h1 = half(0), half(L["height"])
        parts.append(
            _segment(rng, points // 8, [sx * h0, 0, sz * h0], [sx * h1, L["height"], sz * h1], 0.1, noise)
        )
        legs.append([sx * h0, 0.0, sz * h0])
    per = points // 40
    for b in range(L["bays"]):
        y0, y1 = b * bay_h, (b + 1) * bay_h
        h0, h1 = half(y0), half(y1)
        for k in range(4):
            (ax, az), (bx, bz) = corners[k], corners[(k + 1) % 4]
            parts.append(_segment(rng, per, [ax * h0, y0, az * h0], [bx * h1, y1, bz * h1], 0.05, noise))
            parts.append(_segment(rng, per, [bx * h0, y0, bz * h0], [ax * h1, y1, az * h1], 0.05, noise))
    antennas = []
    for az in L["sectors"]:
        for side in (-1, 1):
            c = toward(az, L["antennaR"], L["antennaY"]) + toward(az + 90, side * L["antennaSpread"] / 2)
            antennas.append({"centre": c.tolist(), "azimuthDeg": az, "size": 1.4})
            parts.append(_box(rng, 400, c, [0.3, 1.4, 0.15]))
    cloud = _finish(parts, False, ground, rng, noise, points // 8)
    truth = _truth(
        L["height"],
        [{"y": 0.0, "r": L["widthBase"] / 2}, {"y": L["height"], "r": L["widthTop"] / 2}],
        legs=L["legs"],
        legPositions=legs,
        legDiameter=0.2,
        widthBase=L["widthBase"],
        widthTop=L["widthTop"],
        bays=L["bays"],
        bayHeight=bay_h,
        sectors=L["sectors"],
        antennasPerSector=L["antennasPerSector"],
        antennaSpread=L["antennaSpread"],
        antennaR=L["antennaR"],
        antennaY=L["antennaY"],
        antennaAzimuths=[a["azimuthDeg"] for a in antennas],
        antennas=antennas,
        noise=noise,
    )
    return cloud, truth


def monopole_cloud(seed=1, noise=0.005, ground=True, points=25_000):
    """A noisy twelve-sided monopole with a panel antenna, an RRU and an omni near the top."""
    rng = np.random.default_rng(seed)
    M = MONOPOLE
    n = M["sides"]
    y = rng.uniform(0, M["height"], points)
    face = rng.integers(0, n, points)
    u = rng.uniform(0, 1, points)
    r = np.interp(y, [p["y"] for p in M["profile"]], [p["r"] for p in M["profile"]])
    a0, a1 = 2 * math.pi * face / n, 2 * math.pi * (face + 1) / n
    x = r * ((1 - u) * np.sin(a0) + u * np.sin(a1))
    z = -r * ((1 - u) * np.cos(a0) + u * np.cos(a1))
    pole = np.column_stack([x, y, z]) + rng.normal(0, noise, (points, 3)) * np.array([1.0, 0.0, 1.0])
    parts = [
        pole,
        _box(rng, 500, [0, M["antennaY"], -1.1], [0.3, 1.4, 0.15]),
        _box(rng, 200, [0.5, 26.0, -0.7], [0.3, 0.45, 0.15]),
        _segment(rng, 150, [0, 30.25, 0], [0, 31.75, 0], 0.04),
    ]
    cloud = _finish(parts, False, ground, rng, noise, points // 6)
    truth = _truth(
        M["height"],
        M["profile"],
        sides=M["sides"],
        antennas=M["antennas"],
        antennaY=M["antennaY"],
        antennaAzimuths=[0.0],
        noise=noise,
    )
    return cloud, truth


def write_las(points, path, crs_epsg=32633, offset=(400000, 5600000, 0), rgb=None):
    """Write local points (x east, y up, z south) as a LAS 1.2, point format 0 file (format 2 with
    `rgb`, uint8 (N, 3), stored as 16-bit channels).

    World = offset + (x, -z, y): east, north, up. The scale is 1 mm. A GeoTIFF key directory VLR
    carries `crs_epsg` as the projected CRS. Returns the path.
    """
    pts = np.asarray(points, dtype=np.float64)
    offset = tuple(float(v) for v in offset)
    local = np.column_stack([pts[:, 0], -pts[:, 2], pts[:, 1]])  # east, north, up
    scale = 0.001
    rec = np.dtype(
        [
            ("x", "<i4"),
            ("y", "<i4"),
            ("z", "<i4"),
            ("intensity", "<u2"),
            ("flags", "u1"),
            ("cls", "u1"),
            ("angle", "i1"),
            ("user", "u1"),
            ("source", "<u2"),
            *([("rgb", "<u2", 3)] if rgb is not None else []),
        ]
    )
    data = np.zeros(len(local), dtype=rec)
    if rgb is not None:
        data["rgb"] = np.asarray(rgb, dtype=np.uint16) * 257
    for i, k in enumerate("xyz"):
        data[k] = np.round(local[:, i] / scale).astype(np.int32)
    data["flags"] = 0b00001001  # return 1 of 1
    world = local + np.array(offset)
    mins, maxs = world.min(axis=0), world.max(axis=0)
    keys = struct.pack("<8H", 1, 1, 0, 1, 3072, 0, 1, int(crs_epsg))
    vlr = struct.pack("<H16sHH32s", 0, b"LASF_Projection", 34735, len(keys), b"GeoKeyDirectory") + keys
    head = 227
    header = struct.pack(
        "<4sHH16sBB32s32sHHHIIBHI5I3d3d6d",
        b"LASF",
        0,
        0,
        b"\0" * 16,
        1,
        2,
        b"synth_assets".ljust(32, b"\0"),
        b"synth_assets".ljust(32, b"\0"),
        1,
        2026,
        head,
        head + len(vlr),
        1,
        2 if rgb is not None else 0,
        rec.itemsize,
        len(local),
        len(local),
        0,
        0,
        0,
        0,
        scale,
        scale,
        scale,
        *offset,
        maxs[0],
        mins[0],
        maxs[1],
        mins[1],
        maxs[2],
        mins[2],
    )
    assert len(header) == head, len(header)
    path = Path(path)
    with open(path, "wb") as f:
        f.write(header)
        f.write(vlr)
        data.tofile(f)
    return path


def synth_photos(dir, n=3, seed=1, size=(1600, 1200), rotate_exif=False):
    """Render `n` simple silhouette JPEGs of a tapered stack from varied framings.

    With `rotate_exif` the pixels are stored turned a quarter anticlockwise and an EXIF Orientation 6
    tag is written, so a viewer that applies it shows the upright picture. Returns the paths.
    """
    from PIL import Image, ImageDraw

    rng = np.random.default_rng(seed)
    Path(dir).mkdir(parents=True, exist_ok=True)
    w, h = size
    out = []
    for i in range(n):
        img = Image.new("RGB", (w, h), (170, 200, 230))
        d = ImageDraw.Draw(img)
        horizon = int(h * rng.uniform(0.78, 0.86))
        d.rectangle([0, horizon, w, h], fill=(95, 110, 80))
        cx = w * rng.uniform(0.4, 0.6)
        top = h * rng.uniform(0.06, 0.12)
        half_top = w * rng.uniform(0.025, 0.035)
        half_base = half_top * 1.4
        grey = int(rng.integers(120, 160))
        d.polygon(
            [
                (cx - half_top, top),
                (cx + half_top, top),
                (cx + half_base, horizon),
                (cx - half_base, horizon),
            ],
            fill=(grey, grey, grey - 5),
        )
        flues = STACK["flues"]
        for k in range(flues):
            fx = cx - half_top + (k + 0.5) * (2 * half_top / flues)
            d.rectangle([fx - 6, top - h * 0.03, fx + 6, top], fill=(grey - 30,) * 3)
        path = Path(dir) / f"synth_{i + 1:02d}.jpg"
        if rotate_exif:
            exif = Image.Exif()
            exif[0x0112] = 6
            img.rotate(90, expand=True).save(path, "JPEG", quality=88, exif=exif)
        else:
            img.save(path, "JPEG", quality=88)
        out.append(path)
    return out
