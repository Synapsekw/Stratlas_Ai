"""A small synthetic photogrammetry scene with known poses, for ``photo.products`` tests (G3).

Stream G8's ``photo_synth.py`` renders the full M10 scene; this one is deliberately small and fast
so the products can be checked against truth in every test run, without waiting for G2's
alignment: the sparse model is written straight from the known cameras (COLMAP text format).

The scene (fictional desert site, EPSG:32639, project origin at its centre):

- gently sloping textured ground;
- a flat-roofed box building (6 m) and a cone stockpile (4 m high, 7 m radius);
- black-and-white checker targets at known positions (ortho checks);
- every surface carries seeded multi-scale colour noise, so images match like real ground.

Images are rendered by splatting a dense set of coloured surface samples into a z-buffer at twice
the resolution and averaging down (no GPU, no OpenGL), with an OPENCV lens.
"""

from __future__ import annotations

import atexit
import functools
import json
import math
import os
import shutil
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image

from aio_pipelines.photo.scene import Camera, SparseModel, View, write_text_model

EPSG = 32639
ORIGIN = (412000.0, 3245000.0, 20.0)
BOX = (5.0, 15.0, 4.0, 12.0, 6.0)  # x0, x1, y0, y1 (local east, north), height above ground
PILE = (-12.0, -6.0, 7.0, 4.0)  # cx, cy, radius, height
TARGETS = [(-20.0, 14.0), (20.0, 15.0), (0.0, 0.0), (-18.0, -16.0), (21.0, -15.0)]
TARGET_SIZE = 1.2


def ground(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Ground height above the origin height, metres (local east x, north y)."""
    return 0.03 * x + 0.4 * np.sin(y / 9.0)


def pile(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    cx, cy, r, h = PILE
    d = np.hypot(x - cx, y - cy)
    return np.clip(h * (1 - d / r), 0, None)


def in_box(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    x0, x1, y0, y1, _ = BOX
    return (x >= x0) & (x <= x1) & (y >= y0) & (y <= y1)


def dsm(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """True surface height above the origin height (roof, pile or ground)."""
    g = ground(x, y)
    h = g + pile(x, y)
    roof = ground(np.full_like(x, BOX[0]), np.full_like(y, BOX[2])) + BOX[4]
    return np.where(in_box(x, y), np.maximum(roof, h), h)


def pile_volume() -> float:
    _, _, r, h = PILE
    return math.pi * r * r * h / 3


class Noise:
    """Seeded multi-scale value noise in [0, 1] over the plane."""

    def __init__(self, seed: int, scales=(0.15, 0.4, 1.2, 4.0), extent=80.0):
        rng = np.random.default_rng(seed)
        self.layers = []
        for s in scales:
            n = int(extent * 2 / s) + 3
            self.layers.append((s, rng.random((n, n)), extent))

    def __call__(self, x: np.ndarray, y: np.ndarray) -> np.ndarray:
        out = np.zeros_like(x, dtype=np.float64)
        wsum = 0.0
        for s, grid, ext in self.layers:
            gx, gy = (x + ext) / s, (y + ext) / s
            ix, iy = np.floor(gx).astype(int), np.floor(gy).astype(int)
            fx, fy = gx - ix, gy - iy
            ix = np.clip(ix, 0, grid.shape[1] - 2)
            iy = np.clip(iy, 0, grid.shape[0] - 2)
            v = (
                grid[iy, ix] * (1 - fx) * (1 - fy)
                + grid[iy, ix + 1] * fx * (1 - fy)
                + grid[iy + 1, ix] * (1 - fx) * fy
                + grid[iy + 1, ix + 1] * fx * fy
            )
            w = 1.0 / (1 + s)
            out += w * v
            wsum += w
        return out / wsum


def _ground_colour(n1: Noise, n2: Noise, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    a, b = n1(x, y), n2(x, y)
    base = np.stack([150 + 90 * a, 120 + 80 * a, 80 + 60 * b], axis=-1)
    base = (base - 128) * 1.6 + 128
    for tx, ty in TARGETS:
        s = TARGET_SIZE / 2
        m = (np.abs(x - tx) < s) & (np.abs(y - ty) < s)
        black = ((x - tx) * (y - ty)) > 0
        base[m & black] = 15
        base[m & ~black] = 245
    return np.clip(base, 0, 255)


@dataclass
class Scene:
    points: np.ndarray  # world (E, N, H)
    colours: np.ndarray  # uint8
    views: list[View] = field(default_factory=list)
    images: list[np.ndarray] = field(default_factory=list)

    @property
    def origin(self) -> np.ndarray:
        return np.array(ORIGIN)


def surface_samples(step: float = 0.025, half=(36.0, 31.0), seed: int = 7) -> tuple[np.ndarray, np.ndarray]:
    n1, n2 = Noise(seed), Noise(seed + 1)
    xs = np.arange(-half[0], half[0], step)
    ys = np.arange(-half[1], half[1], step)
    gx, gy = np.meshgrid(xs, ys)
    gx, gy = gx.ravel(), gy.ravel()
    gz = dsm(gx, gy)
    col = _ground_colour(n1, n2, gx, gy)
    roof = in_box(gx, gy)
    col[roof] = np.clip(col[roof] * 0.7 + 60, 0, 255)
    pts = [np.column_stack([gx, gy, gz])]
    cols = [col]
    # the four walls of the box, sampled on their own grid
    x0, x1, y0, y1, h = BOX
    top = ground(np.array(x0), np.array(y0)) + h
    for (ax, ay), (bx, by) in [
        ((x0, y0), (x1, y0)),
        ((x1, y0), (x1, y1)),
        ((x1, y1), (x0, y1)),
        ((x0, y1), (x0, y0)),
    ]:
        length = math.hypot(bx - ax, by - ay)
        t = np.arange(0, length, step)
        wz = np.arange(0, h + 1, step)
        tt, zz = np.meshgrid(t, wz)
        wx = ax + (bx - ax) * tt.ravel() / length
        wy = ay + (by - ay) * tt.ravel() / length
        hz = ground(wx, wy) + zz.ravel()
        keep = hz <= float(top)
        a = n1(tt.ravel() + 31.0, zz.ravel() * 3)[keep]
        pts.append(np.column_stack([wx[keep], wy[keep], hz[keep]]))
        cols.append(np.stack([90 + 120 * a, 90 + 110 * a, 100 + 90 * a], axis=-1))
    p = np.concatenate(pts)
    p += np.array(ORIGIN)
    return p, np.concatenate(cols).astype(np.uint8)


def nadir_r(yaw_deg: float = 0.0, tilt_deg: tuple[float, float] = (0.0, 0.0)) -> np.ndarray:
    """World (E, N, H) to camera rotation for a camera looking down, image up = north at yaw 0."""
    base = np.array([[1.0, 0, 0], [0, -1.0, 0], [0, 0, -1.0]])
    c, s = math.cos(math.radians(yaw_deg)), math.sin(math.radians(yaw_deg))
    rz = np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])
    a, b = (math.radians(v) for v in tilt_deg)
    rx = np.array([[1, 0, 0], [0, math.cos(a), -math.sin(a)], [0, math.sin(a), math.cos(a)]])
    ry = np.array([[math.cos(b), 0, math.sin(b)], [0, 1, 0], [-math.sin(b), 0, math.cos(b)]])
    return rx @ ry @ base @ rz.T


def render(points: np.ndarray, colours: np.ndarray, view: View, ss: int = 2) -> np.ndarray:
    cam = view.camera.scaled(ss)
    x, y, z = view.project(points, cam)
    ok = (z > 0.1) & (x >= 0) & (y >= 0) & (x < cam.width) & (y < cam.height)
    px, py, pz = np.floor(x[ok]).astype(np.int64), np.floor(y[ok]).astype(np.int64), z[ok]
    col = colours[ok]
    idx = py * cam.width + px
    order = np.lexsort((pz, idx))
    first = np.r_[True, idx[order][1:] != idx[order][:-1]]
    sel = order[first]
    img = np.zeros((cam.height * cam.width, 3), np.float64)
    have = np.zeros(cam.height * cam.width, bool)
    img[idx[sel]] = col[sel]
    have[idx[sel]] = True
    img = img.reshape(cam.height, cam.width, 3)
    have = have.reshape(cam.height, cam.width)
    if not have.all():
        from scipy import ndimage

        _, (iy, ix) = ndimage.distance_transform_edt(~have, return_indices=True)
        img = img[iy, ix]
    small = img.reshape(view.camera.height, ss, view.camera.width, ss, 3).mean(axis=(1, 3))
    return np.clip(np.round(small), 0, 255).astype(np.uint8)


def make_scene(
    *,
    width: int = 480,
    height: int = 360,
    focal: float = 380.0,
    altitude: float = 34.0,
    spacing: tuple[float, float] = (9.0, 9.0),
    grid: tuple[int, int] = (4, 4),
    seed: int = 3,
    distortion: tuple[float, float, float, float] = (-0.04, 0.008, 0.0004, -0.0003),
    step: float = 0.025,
) -> Scene:
    rng = np.random.default_rng(seed)
    pts, cols = surface_samples(step=step)
    cam = Camera(
        "OPENCV", width, height, (focal, focal * 1.002, width / 2 + 1.3, height / 2 - 0.8, *distortion)
    )
    scene = Scene(pts, cols)
    vid = 1
    nx, ny = grid
    for j in range(ny):
        for i in range(nx):
            ex = (i - (nx - 1) / 2) * spacing[0] + rng.normal(0, 0.3)
            ny_ = (j - (ny - 1) / 2) * spacing[1] + rng.normal(0, 0.3)
            r = nadir_r(rng.normal(0, 2.0), (rng.normal(0, 1.5), rng.normal(0, 1.5)))
            c = np.array(ORIGIN) + np.array([ex, ny_, altitude + rng.normal(0, 0.2)])
            v = View(vid, f"IMG_{vid:04d}.jpg", cam, r, -r @ c)
            scene.views.append(v)
            vid += 1
    for v in scene.views:
        scene.images.append(render(pts, cols, v))
    return scene


def sparse_points(scene: Scene, n: int = 2500, seed: int = 5) -> SparseModel:
    rng = np.random.default_rng(seed)
    pick = rng.choice(len(scene.points), size=n, replace=False)
    p, c = scene.points[pick], scene.colours[pick]
    tracks = []
    for q in p:
        seen = []
        for v in scene.views:
            x, y, z = v.project(q[None])
            if z[0] > 0 and 0 <= x[0] < v.camera.width and 0 <= y[0] < v.camera.height:
                seen.append(v.id)
        tracks.append(seen)
    return SparseModel(scene.views, p, c, tracks)


def write_project(
    root: Path,
    scene: Scene,
    run: str = "20261007-0915",
    sparse_offset: tuple[float, float, float] | None = None,
) -> Path:
    """A project folder with photos, a manifest and an aligned run (``run.json`` and ``sparse/``)."""
    photos = root / "photos-in"
    photos.mkdir(parents=True, exist_ok=True)
    for v, img in zip(scene.views, scene.images, strict=True):
        Image.fromarray(img).save(photos / v.name, "JPEG", quality=95)
    manifest = {
        "schema": "aio.project/1",
        "id": "synthetic-photo",
        "name": "Synthetic photo site",
        "type": "volumetric",
        "crs": {"epsg": EPSG},
        "origin": list(ORIGIN),
        "captures": [{"id": "c1", "date": "2026-10-07", "label": "7 Oct 2026"}],
        "layers": [],
    }
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2), "utf-8")
    rdir = root / "photogrammetry" / run
    model = sparse_points(scene)
    if sparse_offset is not None:
        off = np.array(sparse_offset)
        views = [View(v.id, v.name, v.camera, v.r, v.t + v.r @ off) for v in model.views]
        model = SparseModel(views, model.points - off, model.colours, model.tracks)
    write_text_model(rdir / "sparse", model)
    doc = {
        "schema": "aio.photo-run/1",
        "id": run,
        "createdAt": "2026-10-07T09:15:00Z",
        "status": "aligned",
        "preset": "standard",
        "photos": {
            "source": {"folders": [str(photos)]},
            "count": len(scene.views),
            "registered": len(scene.views),
        },
        "cameras": [
            {
                "id": "cam1",
                "make": "Stratlas Synthetic",
                "model": "SYN-20",
                "widthPx": scene.views[0].camera.width,
                "heightPx": scene.views[0].camera.height,
                "calibration": "OPENCV",
                "photos": len(scene.views),
            }
        ],
        "crs": {"epsg": EPSG},
        "stages": [
            {"name": "sfm", "state": "done", "seconds": 1.0},
        ],
        "outputs": {"layers": [], "tilesets": [], "files": []},
        "versions": {"pack": "0.4.0"},
    }
    if sparse_offset is not None:
        doc["sparseOffset"] = list(sparse_offset)
    (rdir / "run.json").write_text(json.dumps(doc, indent=1), "utf-8")
    return root


# ------------------------------------------------------------------- cached for the test session

RUN = "20261007-0915"
GSD = 34.0 / 380.0
_TMP = Path(tempfile.mkdtemp(prefix="aio-products-"))
atexit.register(shutil.rmtree, _TMP, True)


@functools.cache
def scene() -> Scene:
    """The test scene, rendered once per test session (about 15 s)."""
    return make_scene(step=0.03)


def project(name: str, **kw) -> Path:
    """A fresh copy of the aligned synthetic project."""
    root = _TMP / name
    if root.exists():
        shutil.rmtree(root)
    return write_project(root, scene(), **kw)


@functools.cache
def processed() -> tuple[Path, dict, list]:
    """The project after one ``photo.products`` job (high preset: dense at full size), once."""
    import threading

    from aio_pipelines.photo.products import PhotoProducts
    from aio_pipelines.runtime import Job

    root = project("processed")
    messages: list = []
    params = {
        "run": RUN,
        "products": ["dsm", "dtm", "ortho", "mesh", "tiles"],
        "preset": "high",
        "capture": "c1",
    }
    res = Job(
        "p1", PhotoProducts(), root, params, lambda m, p: messages.append((m, p)), threading.Event()
    ).run()
    return root, res, messages


def fake_tool(folder: Path, name: str, script: str) -> Path:
    """An executable ``name`` (a .cmd on Windows) running ``script`` with this Python."""
    folder.mkdir(parents=True, exist_ok=True)
    py = folder / f"{name}_fake.py"
    py.write_text(script, "utf-8")
    if os.name == "nt":
        exe = folder / f"{name}.cmd"
        exe.write_text(f'@"{sys.executable}" "{py}" %*\r\n', "utf-8")
    else:
        exe = folder / name
        exe.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{py}" "$@"\n', "utf-8")
        exe.chmod(0o755)
    return exe
