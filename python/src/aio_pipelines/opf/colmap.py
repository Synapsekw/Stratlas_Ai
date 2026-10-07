"""A run's sparse model (``photogrammetry/<run>/sparse/``) in COLMAP's text or binary format.

Only what interchange needs: cameras (model, size, parameters), images (pose, camera, name) and
3D points (position, colour, error). Tracks and 2D points are read past, never kept. Counts are
checked against the file size before anything is allocated, so a damaged or hostile model fails
with its name instead of exhausting memory.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from ..runtime import JobError, atomic_write_bytes
from .geometry import COLMAP_MODEL_NAMES, COLMAP_MODELS

#: More images than any survey this build is made for; a bigger count is a damaged file.
MAX_IMAGES = 200_000
MAX_POINTS = 50_000_000


@dataclass
class Camera:
    id: int
    model: str
    width: int
    height: int
    params: list[float]


@dataclass
class Image:
    id: int
    qvec: list[float]  # w, x, y, z (world to camera)
    tvec: list[float]
    camera_id: int
    name: str


@dataclass
class Model:
    cameras: dict[int, Camera] = field(default_factory=dict)
    images: dict[int, Image] = field(default_factory=dict)
    xyz: np.ndarray = field(default_factory=lambda: np.zeros((0, 3)))
    rgb: np.ndarray = field(default_factory=lambda: np.zeros((0, 3), dtype=np.uint8))
    error: np.ndarray = field(default_factory=lambda: np.zeros(0))


def _bad(path: Path, why: str) -> JobError:
    return JobError(f"The sparse model file {path.name} cannot be read: {why}.")


# ---------------------------------------------------------------- text


def _lines(path: Path):
    with open(path, encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if line and not line.startswith("#"):
                yield line


def _read_text(folder: Path) -> Model:
    m = Model()
    p = folder / "cameras.txt"
    for line in _lines(p):
        parts = line.split()
        try:
            cid, model, w, h = int(parts[0]), parts[1], int(parts[2]), int(parts[3])
            params = [float(v) for v in parts[4:]]
        except (ValueError, IndexError) as e:
            raise _bad(p, f"line {line[:60]!r}") from e
        if model not in COLMAP_MODELS or len(params) != COLMAP_MODELS[model][1]:
            raise _bad(p, f"camera {cid} has the model {model} with {len(params)} parameters")
        m.cameras[cid] = Camera(cid, model, w, h, params)
    p = folder / "images.txt"
    pose_line = True
    with open(p, encoding="utf-8") as f:
        for raw in f:
            line = raw.rstrip("\r\n")
            if line.startswith("#"):
                continue
            if pose_line:
                if not line.strip():
                    continue
                parts = line.split(maxsplit=9)
                try:
                    iid = int(parts[0])
                    q = [float(v) for v in parts[1:5]]
                    t = [float(v) for v in parts[5:8]]
                    cid = int(parts[8])
                    name = parts[9].strip()
                except (ValueError, IndexError) as e:
                    raise _bad(p, f"line {line[:60]!r}") from e
                m.images[iid] = Image(iid, q, t, cid, name)
                if len(m.images) > MAX_IMAGES:
                    raise _bad(p, f"more than {MAX_IMAGES} images")
                pose_line = False
            else:
                pose_line = True  # the 2D points line (possibly empty) is skipped
    p = folder / "points3D.txt"
    xyz, rgb, err = [], [], []
    if p.is_file():
        for line in _lines(p):
            parts = line.split()
            try:
                xyz.append([float(v) for v in parts[1:4]])
                rgb.append([int(v) for v in parts[4:7]])
                err.append(float(parts[7]))
            except (ValueError, IndexError) as e:
                raise _bad(p, f"line {line[:60]!r}") from e
            if len(xyz) > MAX_POINTS:
                raise _bad(p, f"more than {MAX_POINTS} points")
    if xyz:
        m.xyz = np.asarray(xyz, dtype=np.float64)
        m.rgb = np.clip(np.asarray(rgb), 0, 255).astype(np.uint8)
        m.error = np.asarray(err, dtype=np.float64)
    return m


# ---------------------------------------------------------------- binary


class _Reader:
    def __init__(self, path: Path):
        self.path = path
        self.data = path.read_bytes()
        self.pos = 0

    def take(self, fmt: str):
        n = struct.calcsize(fmt)
        if self.pos + n > len(self.data):
            raise _bad(self.path, "it ends early")
        v = struct.unpack_from(fmt, self.data, self.pos)
        self.pos += n
        return v

    def count(self, limit: int, min_bytes: int) -> int:
        (n,) = self.take("<Q")
        if n > limit or n * min_bytes > len(self.data) - self.pos:
            raise _bad(self.path, f"it declares {n} records")
        return n

    def cstring(self) -> str:
        end = self.data.find(b"\0", self.pos)
        if end < 0 or end - self.pos > 4096:
            raise _bad(self.path, "an image name has no end")
        s = self.data[self.pos : end].decode("utf-8", errors="replace")
        self.pos = end + 1
        return s

    def skip(self, n: int) -> None:
        if n < 0 or self.pos + n > len(self.data):
            raise _bad(self.path, "it ends early")
        self.pos += n


def _read_binary(folder: Path) -> Model:
    m = Model()
    r = _Reader(folder / "cameras.bin")
    for _ in range(r.count(MAX_IMAGES, 24)):
        cid, mid, w, h = r.take("<iiQQ")
        name = COLMAP_MODEL_NAMES.get(mid)
        if name is None:
            raise _bad(r.path, f"camera {cid} has the unknown model id {mid}")
        n = COLMAP_MODELS[name][1]
        m.cameras[cid] = Camera(cid, name, w, h, list(r.take(f"<{n}d")))
    r = _Reader(folder / "images.bin")
    for _ in range(r.count(MAX_IMAGES, 64)):
        iid, qw, qx, qy, qz, tx, ty, tz, cid = r.take("<idddddddi")
        name = r.cstring()
        (n2d,) = r.take("<Q")
        r.skip(24 * n2d)
        m.images[iid] = Image(iid, [qw, qx, qy, qz], [tx, ty, tz], cid, name)
    p = folder / "points3D.bin"
    if p.is_file():
        r = _Reader(p)
        n = r.count(MAX_POINTS, 43)
        xyz = np.empty((n, 3))
        rgb = np.empty((n, 3), dtype=np.uint8)
        err = np.empty(n)
        for i in range(n):
            _, x, y, z, cr, cg, cb, e, tl = r.take("<QdddBBBdQ")
            xyz[i] = (x, y, z)
            rgb[i] = (cr, cg, cb)
            err[i] = e
            r.skip(8 * tl)
        m.xyz, m.rgb, m.error = xyz, rgb, err
    return m


def read_model(folder: Path) -> Model:
    """Read a COLMAP sparse model folder (text preferred when both are there)."""
    if (folder / "cameras.txt").is_file() and (folder / "images.txt").is_file():
        return _read_text(folder)
    if (folder / "cameras.bin").is_file() and (folder / "images.bin").is_file():
        return _read_binary(folder)
    raise JobError(f"There is no sparse model (COLMAP cameras and images) in {folder.name}/.")


def write_text(folder: Path, model: Model) -> None:
    """Write the model in COLMAP's text format (full double precision), each file atomically."""
    cams = ["# Camera list: CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]"]
    for c in sorted(model.cameras.values(), key=lambda c: c.id):
        cams.append(
            " ".join([str(c.id), c.model, str(c.width), str(c.height), *(repr(float(v)) for v in c.params)])
        )
    imgs = ["# Image list: IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME (then a 2D points line)"]
    for im in sorted(model.images.values(), key=lambda i: i.id):
        nums = [repr(float(v)) for v in (*im.qvec, *im.tvec)]
        imgs.append(" ".join([str(im.id), *nums, str(im.camera_id), im.name]))
        imgs.append("")
    pts = ["# 3D point list: POINT3D_ID, X, Y, Z, R, G, B, ERROR, TRACK[]"]
    for i in range(len(model.xyz)):
        x, y, z = (float(v) for v in model.xyz[i])
        r, g, b = (int(v) for v in model.rgb[i])
        e = float(model.error[i]) if len(model.error) > i else 0.0
        pts.append(f"{i + 1} {x!r} {y!r} {z!r} {r} {g} {b} {e!r}")
    for name, lines in (("cameras.txt", cams), ("images.txt", imgs), ("points3D.txt", pts)):
        atomic_write_bytes(folder / name, ("\n".join(lines) + "\n").encode("utf-8"))
