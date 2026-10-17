"""Seeded synthetic tower crowns with exact antenna truth, for the telecom antenna detection tests.

Local frame like `synth_assets`: x east, y up, z south (north is -z), the tower base at the origin,
azimuths clockwise from north. A monopole (30 m, twelve-sided shaft) or a lattice tower (40 m, four
legs) carries a ring headframe with mount pipes, brackets and a set of antenna units: panels, short
units, one wide panel, a dish and a radio unit. Every box unit samples all six faces; the truth is
exactly the pose that was used to place the unit. Nothing here describes a real site.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np

from synth_assets import (
    LATTICE,
    _disc,
    _segment,
    toward,
    write_las,
)

SIDES = 12
MONO_HEIGHT = 30.0
MONO_PROFILE = [{"y": 0.0, "r": 0.6}, {"y": MONO_HEIGHT, "r": 0.35}]
RING_R = 2.0  # headframe ring radius (pipe radius of the frame)
INNER_RING_R = 1.2
BACK_R = 2.12  # radial distance of the unit back faces
PIPE_R = 0.03  # mount pipe radius; the pipe axes sit at RING_R - 0.02
ATTACHED_BACK_R = RING_R - 0.02 + PIPE_R  # attached variant: unit backs clamp onto their pipes
CABLE_R = 0.008
SHAFT_DENSITY = 0.25  # the shaft and the lattice members are sampled sparser than the faces
GROUND_POINTS = 30_000
GROUND_RADIUS = 40.0

SECTORS = (0.0, 120.0, 240.0)
PANEL = (0.30, 1.40, 0.15)
SHORT = (0.40, 0.90, 0.20)
WIDE = (1.50, 1.30, 0.20)  # ruling P1: 1.30 m tall
RADIO = (0.30, 0.40, 0.15)
DISH_D = 0.60
DISH_DEPTH = 0.15
DOWNTILTS = (2.0, 4.0, 6.0)
PLUMBS = (0.0, 1.0, -1.0)


def _rot_y(v: np.ndarray, deg: float) -> np.ndarray:
    """Rotate `v` clockwise seen from above (north -> east) by `deg` about the vertical."""
    t = math.radians(deg)
    return np.array([v[0] * math.cos(t) - v[2] * math.sin(t), v[1], v[0] * math.sin(t) + v[2] * math.cos(t)])


def unit_axes(azimuth_deg: float, downtilt_deg: float, plumb_deg: float):
    """(across, up, normal) of a unit. Start across = east, up = up, normal = north; downtilt about
    across (the normal tips down for positive); plumb about the normal (the top leans to the viewer's
    right for positive); then azimuth about up (clockwise from north)."""
    across = np.array([1.0, 0.0, 0.0])
    up = np.array([0.0, 1.0, 0.0])
    normal = np.array([0.0, 0.0, -1.0])
    d, p = math.radians(downtilt_deg), math.radians(plumb_deg)
    normal, up = normal * math.cos(d) - up * math.sin(d), up * math.cos(d) + normal * math.sin(d)
    up, across = up * math.cos(p) - across * math.sin(p), across * math.cos(p) + up * math.sin(p)
    return tuple(_rot_y(v, azimuth_deg) for v in (across, up, normal))


def _box_points(rng, ppm2, size, occlude, drop_back):
    """Points on all six faces of a box of extents `size` (across, long, depth) in its own frame."""
    out = []
    for axis in range(3):
        o1, o2 = [i for i in range(3) if i != axis]
        n = max(1, round(size[o1] * size[o2] * ppm2))
        for sign in (-1.0, 1.0):
            p = np.zeros((n, 3))
            p[:, o1] = rng.uniform(-0.5, 0.5, n) * size[o1]
            p[:, o2] = rng.uniform(-0.5, 0.5, n) * size[o2]
            p[:, axis] = sign * size[axis] / 2
            if occlude:
                if axis == 2 and sign < 0 and drop_back:
                    continue
                if axis == 0:
                    p = p[p[:, 1] <= 0]  # half of each side face is hidden
            out.append(p)
    return np.vstack(out)


def _box_unit(rng, ppm2, spec, occlude):
    across, up, normal = unit_axes(spec["azimuthDeg"], spec["downtiltDeg"], spec["plumbDeg"])
    size = (spec["widthM"], spec["heightM"], spec["depthM"])
    loc = _box_points(rng, ppm2, size, occlude, spec.get("dropBack", False))
    return np.asarray(spec["centre"]) + loc[:, 0:1] * across + loc[:, 1:2] * up + loc[:, 2:3] * normal


def _dish_unit(rng, ppm2, spec):
    a, e = math.radians(spec["azimuthDeg"]), math.radians(spec["elevationDeg"])
    axis = np.array([math.sin(a) * math.cos(e), math.sin(e), -math.cos(a) * math.cos(e)])
    side = np.array([math.cos(a), 0.0, math.sin(a)])
    v = np.cross(axis, side)
    r_max = spec["diameterM"] / 2
    n = max(1, round(math.pi * r_max**2 * ppm2))
    pts = []
    for shift in (0.0, -0.012):  # the front reflector and a thin shell behind it
        rho = r_max * np.sqrt(rng.uniform(0, 1, n))
        th = rng.uniform(0, 2 * math.pi, n)
        along = -DISH_DEPTH / 2 + DISH_DEPTH * (rho / r_max) ** 2 + shift
        pts.append(
            np.asarray(spec["centre"])
            + along[:, None] * axis
            + (rho * np.cos(th))[:, None] * side
            + (rho * np.sin(th))[:, None] * v
        )
    return np.vstack(pts)


def _tube(rng, ppm2, a, b, radius, scale=1.0):
    length = float(np.linalg.norm(np.asarray(b, float) - np.asarray(a, float)))
    n = max(2, round(2 * math.pi * radius * length * ppm2 * scale))
    return _segment(rng, n, a, b, radius)


def _torus(rng, ppm2, r, y, tube_r):
    n = max(2, round(4 * math.pi**2 * r * tube_r * ppm2))
    a = rng.uniform(0, 2 * math.pi, n)
    b = rng.uniform(0, 2 * math.pi, n)
    rr = r + tube_r * np.cos(b)
    return np.column_stack([rr * np.sin(a), y + tube_r * np.sin(b), -rr * np.cos(a)])


def _unit_specs(ring_y: float, back_r: float = BACK_R) -> list[dict]:
    """The truth of the unit set around a ring headframe whose lower ring sits at `ring_y`."""
    y = ring_y + 1.0
    units: list[dict] = []
    for az, dt, pl in zip(SECTORS, DOWNTILTS, PLUMBS, strict=True):
        c = toward(az, back_r + PANEL[2] / 2, y)
        units.append(_spec(f"panel-{int(az)}", "panel", c, az, dt, pl, PANEL, drop_back=az == 240.0))
        c = toward(az, back_r + SHORT[2] / 2, y) + toward(az + 90.0, 0.65)
        units.append(_spec(f"short-{int(az)}", "short", c, az, 0.0, 0.0, SHORT))
    c = toward(300.0, back_r + WIDE[2] / 2, y)
    units.append(_spec("wide-300", "panel", c, 300.0, 0.0, 0.0, WIDE))
    dish_c = toward(60.0, 2.4, ring_y - 0.4)
    units.append(
        {
            "name": "dish-60",
            "kind": "dish",
            "centre": dish_c.tolist(),
            "azimuthDeg": 60.0,
            "elevationDeg": 1.0,
            "diameterM": DISH_D,
            # box extents are not required for a dish (ruling P6); they are the bounding size
            "widthM": DISH_D,
            "heightM": DISH_D,
            "depthM": DISH_DEPTH,
        }
    )
    c = toward(180.0, INNER_RING_R + 0.04 + RADIO[2] / 2, ring_y + 0.4)
    units.append(_spec("radio-180", "other", c, 270.0, 0.0, 0.0, RADIO))
    return units


def _spec(name, kind, centre, az, dt, pl, size, drop_back=False):
    return {
        "name": name,
        "kind": kind,
        "centre": [float(v) for v in centre],
        "azimuthDeg": float(az),
        "downtiltDeg": float(dt),
        "plumbDeg": float(pl),
        "widthM": size[0],
        "heightM": size[1],
        "depthM": size[2],
        "dropBack": drop_back,
    }


def _crown(rng, ppm2, ring_y, inner_r, occlude, attached=False):
    """Headframe, mount pipes, brackets and the antenna units. Returns (parts, unit truth).

    `attached`: the unit backs clamp onto their mount pipes, the wide unit and the dish get pipes
    of their own (the dish pipe clamped to both rings), and a cable crosses the front of panel-0.
    Its extra parts are drawn after everything else, so the default cloud stays the same."""
    parts = []
    upper = ring_y + 2.0
    for yy in (ring_y, upper):
        parts.append(_torus(rng, ppm2, RING_R, yy, 0.04))
    parts.append(_torus(rng, ppm2, INNER_RING_R, ring_y, 0.04))
    for k in range(6):  # spokes from the shaft to the ring, between the units
        az = 30.0 + 60.0 * k
        for yy in (ring_y, upper):
            a = toward(az, inner_r(yy), yy)
            parts.append(_tube(rng, ppm2, a, toward(az, RING_R - 0.04, yy), 0.03, 0.5))
    for k in range(6):  # shaft brackets, radius 0.4 to 0.9 m from the axis
        az = 60.0 * k
        for yy in (ring_y - 1.0, ring_y + 3.0):
            r0 = inner_r(yy)
            parts.append(_tube(rng, ppm2, toward(az, r0, yy), toward(az, r0 + 0.5, yy), 0.03, 0.5))
    for az in SECTORS:  # three vertical mount pipes per sector
        for off in (-0.6, 0.0, 0.6):
            base = toward(az, RING_R - 0.02) + toward(az + 90.0, off)
            parts.append(
                _tube(
                    rng,
                    ppm2,
                    base + np.array([0, ring_y - 0.7, 0]),
                    base + np.array([0, ring_y + 2.3, 0]),
                    0.03,
                    0.5,
                )
            )
    specs = _unit_specs(ring_y, ATTACHED_BACK_R if attached else BACK_R)
    for s in specs:
        parts.append(_dish_unit(rng, ppm2, s) if s["kind"] == "dish" else _box_unit(rng, ppm2, s, occlude))
    if attached:
        parts += _attachments(rng, ppm2, ring_y, upper, specs)
    truth = [{k: v for k, v in s.items() if k != "dropBack"} for s in specs]
    return parts, truth


def _attachments(rng, ppm2, ring_y, upper, specs):
    """The attached variant's pipes for the wide unit and the dish, the dish pipe's clamps to the
    rings, and a cable lying across the front face of panel-0."""
    parts = []
    lo, hi = np.array([0, ring_y - 0.7, 0]), np.array([0, ring_y + 2.3, 0])
    base = toward(300.0, RING_R - 0.02)
    parts.append(_tube(rng, ppm2, base + lo, base + hi, PIPE_R, 0.5))
    dish = next(s for s in specs if s["kind"] == "dish")
    # the pipe touches the back of the reflector (its vertex, DISH_DEPTH / 2 plus the shell behind)
    r_pipe = float(np.hypot(dish["centre"][0], dish["centre"][2])) - DISH_DEPTH / 2 - 0.012 - PIPE_R
    base = toward(dish["azimuthDeg"], r_pipe)
    parts.append(_tube(rng, ppm2, base + lo, base + hi, PIPE_R, 0.5))
    for yy in (ring_y, upper):
        a = toward(dish["azimuthDeg"], RING_R, yy)
        parts.append(_tube(rng, ppm2, a, toward(dish["azimuthDeg"], r_pipe, yy), PIPE_R, 0.5))
    panel = next(s for s in specs if s["name"] == "panel-0")
    across, _, normal = unit_axes(panel["azimuthDeg"], panel["downtiltDeg"], panel["plumbDeg"])
    mid = np.asarray(panel["centre"]) + normal * (panel["depthM"] / 2 + CABLE_R)
    parts.append(_tube(rng, ppm2, mid - 0.6 * across, mid + 0.6 * across, CABLE_R))
    return parts


def _monopole(rng, ppm2, occlude, attached=False):
    perimeter = SIDES * 2 * math.sin(math.pi / SIDES)
    area = perimeter * 0.5 * (MONO_PROFILE[0]["r"] + MONO_PROFILE[1]["r"]) * MONO_HEIGHT
    n = round(area * ppm2 * SHAFT_DENSITY)
    y = rng.uniform(0, MONO_HEIGHT, n)
    face = rng.integers(0, SIDES, n)
    u = rng.uniform(0, 1, n)
    r = np.interp(y, [p["y"] for p in MONO_PROFILE], [p["r"] for p in MONO_PROFILE])
    a0, a1 = 2 * math.pi * face / SIDES, 2 * math.pi * (face + 1) / SIDES
    shaft = np.column_stack(
        [r * ((1 - u) * np.sin(a0) + u * np.sin(a1)), y, -r * ((1 - u) * np.cos(a0) + u * np.cos(a1))]
    )
    ring_y = 27.0
    crown, units = _crown(
        rng,
        ppm2,
        ring_y,
        lambda yy: float(np.interp(yy, [0, MONO_HEIGHT], [0.6, 0.35])),
        occlude,
        attached,
    )
    return [shaft, *crown], units, MONO_HEIGHT, [[p["y"], p["r"]] for p in MONO_PROFILE]


def _lattice(rng, ppm2, occlude, attached=False):
    L = LATTICE
    height, bays = L["height"], L["bays"]

    def half(y):
        return (L["widthBase"] + (L["widthTop"] - L["widthBase"]) * y / height) / 2

    corners = [(1, 1), (1, -1), (-1, -1), (-1, 1)]
    parts = []
    for sx, sz in corners:
        h0, h1 = half(0), half(height)
        parts.append(_tube(rng, ppm2, [sx * h0, 0, sz * h0], [sx * h1, height, sz * h1], 0.1, SHAFT_DENSITY))
    for b in range(bays):
        y0, y1 = b * height / bays, (b + 1) * height / bays
        h0, h1 = half(y0), half(y1)
        for k in range(4):
            (ax, az), (bx, bz) = corners[k], corners[(k + 1) % 4]
            parts.append(
                _tube(rng, ppm2, [ax * h0, y0, az * h0], [bx * h1, y1, bz * h1], 0.05, SHAFT_DENSITY)
            )
            parts.append(
                _tube(rng, ppm2, [bx * h0, y0, bz * h0], [ax * h1, y1, az * h1], 0.05, SHAFT_DENSITY)
            )
    crown, units = _crown(rng, ppm2, 36.5, half, occlude, attached)
    return [*parts, *crown], units, height, [[0.0, half(0)], [height, half(height)]]


RADIO_PAIR = (0.40, 0.70, 0.20)  # each of the two radios side by side
RADIO_GAP_M = 0.05


def _radio_pair(rng, ppm2, ring_y, occlude):
    """Two radio units side by side on the 180 side of the ring, facing out, their sides
    `RADIO_GAP_M` apart: a sparse cloud's in-plane flood fill reaches across such a slit."""
    parts, truth = [], []
    for name, sign in (("radio-pair-a", -1.0), ("radio-pair-b", 1.0)):
        c = toward(180.0, BACK_R + RADIO_PAIR[2] / 2, ring_y + 1.0)
        c = c + toward(270.0, sign * (RADIO_PAIR[0] + RADIO_GAP_M) / 2)
        spec = _spec(name, "short", c, 180.0, 0.0, 0.0, RADIO_PAIR)
        parts.append(_box_unit(rng, ppm2, spec, occlude))
        truth.append({k: v for k, v in spec.items() if k != "dropBack"})
    return parts, truth


FRAME = (1.6, 2.8)  # a flat-bar frame in the headframe: across, tall
FRAME_BAR_M = 0.05
TRAY = (0.25, 1.6)  # a vertical cable tray: across, tall
TRAY_CABLES = 9  # cables behind the tray, from 2 cm to 0.85 m behind it
BAR = (0.18, 2.2)  # a flat bar behind short-120: across, tall
BAR_BEHIND_M = 0.15  # from the short's back face


def _sheet(rng, ppm2, centre, across, up, w, h):
    n = max(1, round(w * h * ppm2))
    a = rng.uniform(-0.5, 0.5, (n, 1)) * w
    b = rng.uniform(-0.5, 0.5, (n, 1)) * h
    return np.asarray(centre) + a * across + b * up


def _interior(rng, ppm2, ring_y):
    """Headframe parts that are no unit, facing out from the axis.

    A flat-bar frame (`FRAME`, bars `FRAME_BAR_M` wide, one plane) at azimuth 90 and 1.55 m out:
    its plane outlines a 1.6 x 2.8 m rectangle that is mostly air. A cable tray (`TRAY`, a sheet)
    at azimuth 200 and 1.5 m out with `TRAY_CABLES` vertical cables behind it, one after another
    out to 0.85 m: no air behind the sheet to end a depth reading. A flat bar (`BAR`) right behind
    short-120, narrower than it but taller and better supported."""
    parts = []
    up = np.array([0.0, 1.0, 0.0])
    w, h = FRAME
    across = _rot_y(np.array([1.0, 0, 0]), 90.0)
    c = toward(90.0, 1.55, ring_y + 1.0)
    bar = FRAME_BAR_M
    for dy in (-(h - bar) / 2, (h - bar) / 2):
        parts.append(_sheet(rng, ppm2, c + dy * up, across, up, w, bar))
    for dx in (-(w - bar) / 2, (w - bar) / 2):
        parts.append(_sheet(rng, ppm2, c + dx * across, across, up, bar, h - 2 * bar))
    frame = {"centre": c.tolist(), "azimuthDeg": 90.0, "widthM": w, "heightM": h}
    tw, th = TRAY
    across = _rot_y(np.array([1.0, 0, 0]), 200.0)
    normal = toward(200.0, 1.0)
    t = toward(200.0, 1.5, ring_y + 1.0)
    parts.append(_sheet(rng, ppm2, t, across, up, tw, th))
    for k in range(TRAY_CABLES):
        back = 0.02 + (0.85 - 0.02) * k / (TRAY_CABLES - 1)
        lateral = (k % 3 - 1) * 0.1
        base = t - normal * back + across * lateral
        parts.append(_tube(rng, ppm2, base - up * th / 2, base + up * th / 2, CABLE_R * 2))
    tray = {"centre": t.tolist(), "azimuthDeg": 200.0, "widthM": tw, "heightM": th}
    # a flat bar standing right behind short-120, taller than it and better supported
    bw, bh = BAR
    across = _rot_y(np.array([1.0, 0, 0]), 120.0)
    b = toward(120.0, BACK_R - BAR_BEHIND_M, ring_y + 1.0) + toward(210.0, 0.65)
    parts.append(_sheet(rng, ppm2, b, across, up, bw, bh))  # its front: the back hides in the scan
    bar = {"centre": b.tolist(), "azimuthDeg": 120.0, "widthM": bw, "heightM": bh}
    return parts, {"frame": frame, "tray": tray, "bar": bar}


SHELTER = (3.0, 3.2, 2.5)  # across, tall, deep: an equipment shelter by the base
SHELTER_AT = (150.0, 4.5)  # azimuth and distance of its centre from the axis
CLUTTER_DENSITY = 0.2


def _base_clutter(rng, ppm2):
    """An equipment shelter standing by the tower base: a box sampled on its five visible faces
    (no floor), at a fifth of the face density. It reaches into the lowest slices of the shaft
    radius fit, as a shelter, a fence or a parked vehicle does on a real site."""
    w, h, d = SHELTER
    pts = _box_points(rng, ppm2 * CLUTTER_DENSITY, (w, h, d), False, False)
    pts = pts[pts[:, 1] > -h / 2 + 1e-9]
    az, r = SHELTER_AT
    across, up, normal = (
        _rot_y(v, az) for v in (np.array([1.0, 0, 0]), np.array([0, 1.0, 0]), np.array([0, 0, -1.0]))
    )
    centre = toward(az, r, h / 2)
    return centre + pts[:, 0:1] * across + pts[:, 1:2] * up + pts[:, 2:3] * normal


def tower_cloud(
    kind: str = "monopole",
    seed: int = 1,
    noise: float = 0.003,
    occlude: bool = True,
    points_per_m2: float = 4000.0,
    ground: bool = True,
    attached: bool = False,
    clutter: bool = False,
    radios: bool = False,
    interior: bool = False,
) -> tuple[np.ndarray, dict]:
    """A synthetic tower with a crown of antennas, in the local frame (x east, y up, z south).

    truth = {"axis": {"point", "dir"}, "height", "shaftRadiusAt": [[y, r], ...],
             "units": [{"name", "kind", "centre", "azimuthDeg", "downtiltDeg", "plumbDeg",
                        "widthM", "heightM", "depthM", "diameterM"?, "elevationDeg"?}]}
    Dishes carry diameterM and elevationDeg (and a bounding widthM/heightM/depthM) but no downtilt
    or plumb. The shaft radius is the circumradius of the twelve-sided monopole and the half width
    of the lattice. Same seed, same cloud. `attached=True` clamps the unit backs and the dish onto
    mount pipes and lays a cable across panel-0 (see `_crown`); the default cloud is unchanged.
    `clutter=True` stands an equipment shelter by the tower base, 3.2 m tall (`_base_clutter`).
    `radios=True` mounts two radio units side by side, 5 cm apart, facing 180 (`_radio_pair`).
    `interior=True` fills the headframe with what is no unit: a flat-bar frame and a cable tray
    with cables behind it, a flat bar behind short-120 (`_interior`); `truth["interior"]` lists them.
    Opt-in parts are drawn with their own seeds after everything else, so turning one on leaves
    the rest of the cloud as it was.
    """
    if kind not in ("monopole", "lattice"):
        raise ValueError(f"unknown tower kind {kind!r}")
    rng = np.random.default_rng(seed)
    build = _monopole if kind == "monopole" else _lattice
    parts, units, height, profile = build(rng, points_per_m2, occlude, attached)
    if clutter:
        parts.append(_base_clutter(np.random.default_rng([seed, 11]), points_per_m2))
    if radios:
        ring_y = 27.0 if kind == "monopole" else 36.5
        pair, pair_truth = _radio_pair(np.random.default_rng([seed, 12]), points_per_m2, ring_y, occlude)
        parts += pair
        units = [*units, *pair_truth]
    extra: dict = {}
    if interior:
        ring_y = 27.0 if kind == "monopole" else 36.5
        inner, extra = _interior(np.random.default_rng([seed, 13]), points_per_m2, ring_y)
        parts += inner
    if ground:
        parts.append(_disc(rng, GROUND_POINTS, 0.0, GROUND_RADIUS, 0.0, 0.0))
    cloud = np.vstack(parts).astype(np.float64)
    cloud += np.random.default_rng([seed, 7]).normal(0.0, noise, cloud.shape) if noise else 0.0
    truth = {
        "kind": kind,
        "axis": {"point": [0.0, 0.0, 0.0], "dir": [0.0, 1.0, 0.0]},
        "height": float(height),
        "shaftRadiusAt": profile,
        "units": units,
    }
    if extra:
        truth["interior"] = extra
    return np.ascontiguousarray(cloud), truth


def two_masts_cloud(seed: int = 1, gap_m: float = 20.0) -> tuple[np.ndarray, dict]:
    """Two 30 m monopoles `gap_m` apart on the x axis (centred on the origin) with one ground."""
    clouds, units, masts = [], [], []
    for i, x in enumerate((-gap_m / 2, gap_m / 2)):
        cloud, t = tower_cloud("monopole", seed=seed + 1000 * i, ground=False)
        cloud[:, 0] += x
        clouds.append(cloud)
        for u in t["units"]:
            u = {
                **u,
                "name": f"m{i}-{u['name']}",
                "centre": [u["centre"][0] + x, u["centre"][1], u["centre"][2]],
            }
            units.append(u)
        masts.append({"xz": [x, 0.0], "axis": {"point": [x, 0.0, 0.0], "dir": [0.0, 1.0, 0.0]}})
    rng = np.random.default_rng([seed, 99])
    ground = _disc(rng, GROUND_POINTS, 0.0, GROUND_RADIUS, 0.0, 0.003)
    truth = {"masts": masts, "height": MONO_HEIGHT, "units": units}
    return np.ascontiguousarray(np.vstack([*clouds, ground])), truth


def make_tower_project(
    root: Path,
    cloud: np.ndarray,
    *,
    epsg: int | None = 32633,
    height_offset_m: float | None = None,
    photos: list[dict] | None = None,
    origin: tuple[float, float, float] = (400000.0, 5600000.0, 0.0),
) -> Path:
    """A minimal project folder: `clouds/tower.las` plus `manifest.json` (aio.project/1) with one
    pointcloud layer "tower-cloud". With `height_offset_m` the file Z is lowered by it and the layer
    carries `heightOffsetM`, so project Z (file Z + offset) is the local y. Without `epsg` the
    manifest has no crs and the cloud is local."""
    root = Path(root)
    (root / "clouds").mkdir(parents=True, exist_ok=True)
    pts = np.array(cloud, dtype=np.float64)
    if height_offset_m:
        pts[:, 1] -= height_offset_m
    write_las(pts, root / "clouds" / "tower.las", crs_epsg=epsg or 32633, offset=origin)
    layer: dict = {
        "kind": "pointcloud",
        "id": "tower-cloud",
        "name": "Tower cloud",
        "src": {"path": "clouds/tower.las"},
        "format": "las",
    }
    if height_offset_m is not None:
        layer["heightOffsetM"] = height_offset_m
    manifest: dict = {"schema": "aio.project/1", "id": "tower-fixture", "name": "Tower fixture"}
    if epsg is not None:
        manifest["crs"] = {"epsg": epsg}
    manifest.update({"origin": list(origin), "captures": [], "layers": [layer]})
    if photos is not None:
        manifest["photos"] = photos
    (root / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    return root


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Write a synthetic tower cloud as float32 xyz plus its truth.")
    ap.add_argument("--kind", default="monopole", choices=["monopole", "lattice"])
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--points-per-m2", type=float, default=4000.0)
    ap.add_argument("--out", required=True, type=Path, help="output .f32 file; the truth goes to <out>.json")
    args = ap.parse_args(argv)
    cloud, truth = tower_cloud(args.kind, seed=args.seed, points_per_m2=args.points_per_m2)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    cloud.astype("<f4").tofile(args.out)
    Path(f"{args.out}.json").write_text(json.dumps(truth, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
