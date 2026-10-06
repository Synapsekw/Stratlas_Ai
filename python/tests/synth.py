"""Procedural M8 test data for the pipeline tests: small rasters, clouds and meshes with known change.

Synthetic only (no client data), seeded (numpy PCG64: the same arrays on every machine), small
enough for unit tests, so no pipeline test needs the bundled demo. Every generator returns its
truth: what changed, where (array indices or local metres) and by how much.

    from synth import ortho_pair, dsm_pair, cloud_pair, mesh_pair, scan, write_geotiff, write_las

Local frame as everywhere in Stratlas: metres, x east, y up, z south.
"""

from __future__ import annotations

import struct
from pathlib import Path

import numpy as np

SAND = np.array([205, 178, 136], dtype=np.float32)


def _smooth(rng: np.random.Generator, size: int, cells: int) -> np.ndarray:
    """Smooth noise in [0, 1): a coarse random grid, bilinearly enlarged to size x size."""
    g = rng.random((cells + 1, cells + 1))
    t = np.linspace(0, cells, size, endpoint=False)
    i = t.astype(int)
    f = t - i
    rows = g[i] * (1 - f)[:, None] + g[i + 1] * f[:, None]
    return rows[:, i] * (1 - f)[None, :] + rows[:, i + 1] * f[None, :]


# ------------------------------------------------------------------ orthos


def ortho_pair(seed: int = 1, size: int = 256, res: float = 0.25):
    """Two RGB orthos (uint8, rows north to south) of the same desert patch.

    The later one has a new dark structure (``added``), lost a blue container (``removed``), a
    cloud shadow (``clean``: lighting only, factor 0.6) and a warmer tint over everything. Boxes
    are ``[row0, col0, row1, col1]``, end exclusive.
    """
    rng = np.random.default_rng(seed)
    k = 0.85 + 0.15 * _smooth(rng, size, 8) + 0.03 * rng.random((size, size))
    a = SAND[None, None, :] * k[:, :, None]
    added = [40, 150, 72, 196]
    removed = [170, 40, 186, 88]
    shadow = [120, 120, 160, 180]
    y0, x0, y1, x1 = removed
    a[y0:y1, x0:x1] = [52, 92, 140]
    b = a.copy()
    b[y0:y1, x0:x1] = SAND[None, None, :] * k[y0:y1, x0:x1, None]
    y0, x0, y1, x1 = added
    b[y0:y1, x0:x1] = [60, 60, 70]
    y0, x0, y1, x1 = shadow
    b[y0:y1, x0:x1] *= 0.6
    tint = [1.04, 1.0, 0.95]
    b *= np.asarray(tint, dtype=np.float32)
    to8 = lambda v: np.clip(np.round(v), 0, 255).astype(np.uint8)  # noqa: E731
    truth = {
        "res": res,
        "changes": [
            {"id": "added", "verdict": "added", "box": added},
            {"id": "removed", "verdict": "removed", "box": removed},
        ],
        "clean": [{"id": "shadow", "why": "lighting only", "box": shadow, "factor": 0.6}],
        "tint": tint,
    }
    return to8(a), to8(b), truth


# ------------------------------------------------------------------ surfaces


def dsm_pair(seed: int = 1, size: int = 192, res: float = 0.5, noise: float = 0.02):
    """Two DSMs (float32 metres, rows north to south): a pile that grew and a new pit.

    Truth: ``fill_m3`` and ``cut_m3`` of the noise-free surfaces, counting cells that changed by
    0.1 m or more (the default surface threshold), and ``noise_m`` (uniform, independent per date).
    """
    rng = np.random.default_rng(seed)
    j, i = np.mgrid[0:size, 0:size]
    x = (i + 0.5) * res
    z = (j + 0.5) * res
    base = 100.0 + 0.002 * x

    def pile(cx: float, cz: float, h: float, r: float) -> np.ndarray:
        d = np.hypot(x - cx, z - cz)
        return np.clip(h * (1 - d / r), 0, None)

    a = base + pile(60, 60, 3.0, 10.0)
    b = base + pile(60, 60, 4.0, 12.0)
    pit = (x >= 20) & (x < 30) & (z >= 70) & (z < 76)
    b = np.where(pit, b - 2.0, b)
    d = b - a
    cell = res * res
    truth = {
        "res": res,
        "noise_m": noise,
        "fill_m3": float(d[d >= 0.1].sum() * cell),
        "cut_m3": float(-d[d <= -0.1].sum() * cell),
        "pile": {"centre": [60.0, 0.0, 60.0], "radius_m": [10.0, 12.0], "height_m": [3.0, 4.0]},
        "pit": {"box": [[20.0, -2.0, 70.0], [30.0, 0.0, 76.0]], "depth_m": 2.0},
    }
    a = (a + rng.uniform(-noise, noise, a.shape)).astype(np.float32)
    b = (b + rng.uniform(-noise, noise, b.shape)).astype(np.float32)
    return a, b, truth


# ------------------------------------------------------------------ point clouds


def _box_surface(rng: np.random.Generator, c, size, density: float) -> np.ndarray:
    """Points on the top and four sides of a box standing on y = 0 (centre of its base ``c``)."""
    sx, sy, sz = size
    out = []
    faces = [
        ((sx, sz), lambda u, v: np.c_[u - sx / 2, np.full_like(u, sy), v - sz / 2]),
        ((sx, sy), lambda u, v: np.c_[u - sx / 2, v, np.full_like(u, sz / 2)]),
        ((sx, sy), lambda u, v: np.c_[u - sx / 2, v, np.full_like(u, -sz / 2)]),
        ((sz, sy), lambda u, v: np.c_[np.full_like(u, sx / 2), v, u - sz / 2]),
        ((sz, sy), lambda u, v: np.c_[np.full_like(u, -sx / 2), v, u - sz / 2]),
    ]
    for (w, h), f in faces:
        n = round(w * h * density)
        out.append(f(rng.random(n) * w, rng.random(n) * h))
    return np.vstack(out) + np.asarray([c[0], 0.0, c[2]])


def cloud_pair(seed: int = 1, density: float = 60.0, noise: float = 0.01):
    """Two point clouds (N x 3, local metres) of a 20 m square: ground and four boxes.

    Between the dates one box moved by ``[2, 0, -1]``, one was removed, one was added and one is
    unchanged. Truth boxes ``[[min], [max]]`` start 0.1 m above the ground, so they hold object
    points only.
    """
    rng = np.random.default_rng(seed)
    objects = [
        {"id": "U", "verdict": "unchanged", "c": [4.0, 0.0, 4.0], "size": [2.0, 1.5, 2.0], "dates": (0, 1)},
        {
            "id": "M",
            "verdict": "moved",
            "c": [10.0, 0.0, 5.0],
            "size": [2.0, 1.0, 1.5],
            "dates": (0, 1),
            "offset": [2.0, 0.0, -1.0],
        },
        {"id": "R", "verdict": "removed", "c": [5.0, 0.0, 14.0], "size": [2.5, 1.2, 1.5], "dates": (0,)},
        {"id": "A", "verdict": "added", "c": [14.0, 0.0, 14.0], "size": [1.5, 2.0, 1.5], "dates": (1,)},
    ]
    clouds = []
    for date in (0, 1):
        pts = []
        foot = []
        for o in objects:
            if date not in o["dates"]:
                continue
            c = np.asarray(o["c"]) + (np.asarray(o.get("offset", [0, 0, 0])) if date == 1 else 0)
            pts.append(_box_surface(rng, c, o["size"], density))
            foot.append((c, o["size"]))
        g = rng.random((int(400 * density / 4), 2)) * 20
        keep = np.ones(len(g), dtype=bool)
        for c, s in foot:
            keep &= ~((np.abs(g[:, 0] - c[0]) < s[0] / 2) & (np.abs(g[:, 1] - c[2]) < s[2] / 2))
        g = g[keep]
        pts.append(np.c_[g[:, 0], np.zeros(len(g)), g[:, 1]])
        p = np.vstack(pts)
        clouds.append(p + rng.normal(0, noise, p.shape))

    def box_of(o, date):
        c = np.asarray(o["c"]) + (np.asarray(o.get("offset", [0, 0, 0])) if date == 1 else 0)
        s = np.asarray(o["size"])
        lo = [c[0] - s[0] / 2 - 0.05, 0.1, c[2] - s[2] / 2 - 0.05]
        hi = [c[0] + s[0] / 2 + 0.05, s[1] + 0.05, c[2] + s[2] / 2 + 0.05]
        return [[float(v) for v in lo], [float(v) for v in hi]]

    truth = {"noise_m": noise, "objects": []}
    for o in objects:
        item = {"id": o["id"], "verdict": o["verdict"], "box": box_of(o, o["dates"][-1])}
        if "offset" in o:
            item["offset"] = o["offset"]
            item["box_before"] = box_of(o, 0)
        truth["objects"].append(item)
    return clouds[0], clouds[1], truth


# ------------------------------------------------------------------ meshes


def _box_mesh(c, size):
    sx, sy, sz = size
    v = np.array(
        [[x, y, z] for y in (0, sy) for z in (-sz / 2, sz / 2) for x in (-sx / 2, sx / 2)], dtype=float
    )
    v += np.asarray([c[0], 0.0, c[2]])
    f = np.array(
        [
            [0, 1, 3],
            [0, 3, 2],
            [4, 6, 7],
            [4, 7, 5],
            [0, 4, 5],
            [0, 5, 1],
            [2, 3, 7],
            [2, 7, 6],
            [0, 2, 6],
            [0, 6, 4],
            [1, 5, 7],
            [1, 7, 3],
        ],
        dtype=np.int64,
    )
    return v, f


def _tank_mesh(c, r, h, segs=48, rows=24, dent=None):
    t = np.arange(segs) * 2 * np.pi / segs
    y = np.arange(rows + 1) * h / rows
    tt, yy = np.meshgrid(t, y)
    rr = np.full_like(tt, r)
    if dent:
        da = (tt - dent["theta"] + np.pi) % (2 * np.pi) - np.pi
        d = np.hypot(da * r, yy - dent["y"])
        rr = rr - np.where(d < dent["radius"], dent["depth"] * (1 - (d / dent["radius"]) ** 2) ** 2, 0)
    v = np.c_[c[0] + rr.ravel() * np.cos(tt.ravel()), yy.ravel(), c[2] + rr.ravel() * np.sin(tt.ravel())]
    f = []
    for j in range(rows):
        for k in range(segs):
            a, b = j * segs + k, j * segs + (k + 1) % segs
            f += [[a, a + segs, b + segs], [a, b + segs, b]]
    return v, np.asarray(f, dtype=np.int64)


def mesh_pair(seed: int = 1):
    """Two models as ``{part: (vertices N x 3, faces M x 3)}``, one entry per tagged part.

    BOX-0 unchanged, BOX-1 moved by ``[1.5, 0, 0.5]``, BOX-2 removed, BOX-3 added, TANK-1 dented
    (``max_m`` exact: the dent centre is a mesh vertex). ``seed`` is accepted for symmetry; the
    meshes are fixed.
    """
    del seed
    dent = {"theta": 12 * 2 * np.pi / 48, "y": 3.0, "radius": 1.0, "depth": 0.2}
    a = {
        "BOX-0": _box_mesh([0, 0, 10], [2, 2, 2]),
        "BOX-1": _box_mesh([10, 0, 0], [3, 1.5, 2]),
        "BOX-2": _box_mesh([10, 0, 10], [2, 1, 2]),
        "TANK-1": _tank_mesh([0, 0, 0], 3.0, 6.0),
    }
    b = {
        "BOX-0": a["BOX-0"],
        "BOX-1": _box_mesh([11.5, 0, 0.5], [3, 1.5, 2]),
        "BOX-3": _box_mesh([16, 0, 10], [2, 2.5, 2]),
        "TANK-1": _tank_mesh([0, 0, 0], 3.0, 6.0, dent=dent),
    }
    truth = {
        "parts": [
            {"part": "BOX-0", "verdict": "unchanged"},
            {"part": "BOX-1", "verdict": "moved", "offset": [1.5, 0.0, 0.5]},
            {"part": "BOX-2", "verdict": "removed"},
            {"part": "BOX-3", "verdict": "added"},
            {"part": "TANK-1", "verdict": "changed", "max_m": dent["depth"], "dent": dent},
        ]
    }
    return a, b, truth


# ------------------------------------------------------------------ modelling scan


def scan(seed: int = 1, density: float = 20.0, noise: float = 0.01):
    """A scan for primitive fitting: two tanks, a box and a pipe on the ground, with noise and
    half the north-facing shell points missing (occlusion). Returns (points N x 3, truth)."""
    rng = np.random.default_rng(seed)
    prims = [
        {"kind": "cylinder", "tag": "TK-1", "base": [0.0, 0.0, 0.0], "radius": 4.0, "height": 8.0},
        {"kind": "cylinder", "tag": "TK-2", "base": [12.0, 0.0, 2.0], "radius": 3.0, "height": 6.0},
        {"kind": "box", "tag": "BX-1", "centre": [5.0, 1.0, 10.0], "size": [4.0, 2.0, 3.0], "rotY": 0.0},
        {"kind": "pipe", "tag": "PP-1", "from": [-5.0, 1.5, -8.0], "to": [15.0, 1.5, -8.0], "radius": 0.25},
    ]
    pts = []
    for p in prims:
        if p["kind"] == "cylinder":
            r, h = p["radius"], p["height"]
            n = int(2 * np.pi * r * h * density)
            t = rng.random(n) * 2 * np.pi
            y = rng.random(n) * h
            keep = ~((np.sin(t) < -0.5) & (rng.random(n) < 0.5))
            t, y = t[keep], y[keep]
            pts.append(np.c_[p["base"][0] + r * np.cos(t), y, p["base"][2] + r * np.sin(t)])
            m = int(np.pi * r * r * density)
            rad = r * np.sqrt(rng.random(m))
            a = rng.random(m) * 2 * np.pi
            pts.append(np.c_[p["base"][0] + rad * np.cos(a), np.full(m, h), p["base"][2] + rad * np.sin(a)])
        elif p["kind"] == "box":
            c = p["centre"]
            pts.append(_box_surface(rng, [c[0], 0, c[2]], p["size"], density))
        else:
            a, b, r = np.asarray(p["from"]), np.asarray(p["to"]), p["radius"]
            length = np.linalg.norm(b - a)
            n = int(2 * np.pi * r * length * density * 4)
            s = rng.random(n)
            t = rng.random(n) * 2 * np.pi
            keep = np.cos(t) > -0.3  # the underside is hidden from the air
            s, t = s[keep], t[keep]
            pts.append(np.c_[a[0] + s * (b[0] - a[0]), a[1] + r * np.cos(t), a[2] + r * np.sin(t)])
    g = rng.random((int(30 * 30 * density / 4), 2)) * 30 - [8, 12]
    pts.append(np.c_[g[:, 0], np.zeros(len(g)), g[:, 1]])
    p = np.vstack(pts)
    return p + rng.normal(0, noise, p.shape), {"noise_m": noise, "primitives": prims}


# ------------------------------------------------------------------ files


def write_geotiff(
    path: Path, array: np.ndarray, x0: float, y1: float, res: float, epsg: int, nodata=None
) -> Path:
    """A north-up GeoTIFF of a single band (or H x W x 3 RGB) in ``epsg``, top-left at (x0, y1)."""
    import rasterio
    from rasterio.transform import from_origin

    bands = array[None] if array.ndim == 2 else np.moveaxis(array, -1, 0)
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        height=bands.shape[1],
        width=bands.shape[2],
        count=bands.shape[0],
        dtype=str(array.dtype),
        crs=f"EPSG:{epsg}",
        transform=from_origin(x0, y1, res, res),
        nodata=nodata,
    ) as d:
        d.write(bands)
    return Path(path)


def write_las(path: Path, xyz: np.ndarray, epsg: int, scale: float = 0.001, point_format: int = 0) -> Path:
    """LAS 1.2, point format 0 (or 2, grey RGB), coordinates in ``epsg`` (E, N, H), with a GeoTIFF key VLR."""
    if point_format not in (0, 2):
        raise ValueError("point_format must be 0 or 2")
    xyz = np.asarray(xyz, dtype=np.float64)
    offset = np.floor(xyz.min(axis=0) / 100) * 100
    q = np.round((xyz - offset) / scale).astype("<i4")
    keys = [(1, 1, 0, 4), (1024, 0, 1, 1), (1025, 0, 1, 1), (3072, 0, 1, epsg), (3076, 0, 1, 9001)]
    geo = b"".join(struct.pack("<4H", *k) for k in keys)
    vlr = struct.pack("<H16sHH32s", 0, b"LASF_Projection", 34735, len(geo), b"GeoKeyDirectoryTag") + geo
    header_size = 227
    lo = q.min(axis=0) * scale + offset
    hi = q.max(axis=0) * scale + offset
    head = struct.pack(
        "<4sHH16sBB32s32sHHHIIBHI5I3d3d6d",
        b"LASF",
        0,
        0,
        b"\0" * 16,
        1,
        2,
        b"Stratlas test (synthetic)",
        b"synth.py",
        1,
        2026,
        header_size,
        header_size + len(vlr),
        1,
        point_format,
        20 if point_format == 0 else 26,
        len(q),
        len(q),
        0,
        0,
        0,
        0,
        scale,
        scale,
        scale,
        *offset,
        hi[0],
        lo[0],
        hi[1],
        lo[1],
        hi[2],
        lo[2],
    )
    rec = np.zeros(
        len(q),
        dtype=[
            ("xyz", "<i4", 3),
            ("i", "<u2"),
            ("f", "u1"),
            ("c", "u1"),
            ("a", "i1"),
            ("u", "u1"),
            ("s", "<u2"),
            *([("rgb", "<u2", 3)] if point_format == 2 else []),
        ],
    )
    rec["xyz"] = q
    rec["f"] = 9
    rec["c"] = 1
    if point_format == 2:
        rec["rgb"] = 32768
    Path(path).write_bytes(head + vlr + rec.tobytes())
    return Path(path)


def read_las_xyz(path: Path) -> np.ndarray:
    """XYZ of a LAS 1.x file (any point format), scaled to the file's CRS units."""
    buf = Path(path).read_bytes()
    (start,) = struct.unpack_from("<I", buf, 96)
    (rec_len,) = struct.unpack_from("<H", buf, 105)
    (n,) = struct.unpack_from("<I", buf, 107)
    scale = np.asarray(struct.unpack_from("<3d", buf, 131))
    offset = np.asarray(struct.unpack_from("<3d", buf, 155))
    raw = np.frombuffer(buf, dtype=np.uint8, count=n * rec_len, offset=start).reshape(n, rec_len)
    q = raw[:, :12].copy().view("<i4").reshape(n, 3)
    return q * scale + offset
