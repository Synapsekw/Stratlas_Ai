"""What ``photo.products`` reads from an aligned run: cameras, poses, sparse points and the photos.

The run's sparse model (``photogrammetry/<run>/sparse/``, written by ``photo.align`` and
``photo.georef``) is a COLMAP model, text (``cameras.txt``, ``images.txt``, ``points3D.txt``) or
binary (``.bin``). Its world frame is the project CRS (easting, northing, height in metres), less
an optional offset the run states as ``sparseOffset`` ``[E, N, H]`` in ``run.json`` (default
none): large UTM numbers are fine in COLMAP's doubles, but an offset keeps them small.

Conventions are COLMAP's: ``x_cam = R(q) X + t``, the camera looks along +z, image x right and y
down, and pixel coordinates put the centre of the top-left pixel at (0.5, 0.5), so a camera scales
with its image exactly (``Camera.scaled``). Lens models: SIMPLE_PINHOLE, PINHOLE, SIMPLE_RADIAL,
RADIAL, OPENCV and FULL_OPENCV.

Photos are found by the image name of the model: an absolute path, else relative to each folder of
the run's photo source (``{"folders": [...]}``), else relative to the photos layer's files
(``{"layer": id}``), else relative to the project. They are only ever read.
"""

from __future__ import annotations

import json
import math
import struct
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from ..runtime import JobError, safe_project_path

#: COLMAP camera model ids and parameter counts.
MODELS: dict[int, tuple[str, int]] = {
    0: ("SIMPLE_PINHOLE", 3),
    1: ("PINHOLE", 4),
    2: ("SIMPLE_RADIAL", 4),
    3: ("RADIAL", 5),
    4: ("OPENCV", 8),
    6: ("FULL_OPENCV", 12),
}
MODEL_IDS = {name: mid for mid, (name, _) in MODELS.items()}


@dataclass(frozen=True)
class Camera:
    """A COLMAP camera: intrinsics and lens distortion for one image size."""

    model: str
    width: int
    height: int
    params: tuple[float, ...]

    def __post_init__(self) -> None:
        if self.model not in MODEL_IDS:
            raise JobError(
                f"The camera model {self.model} is not supported; align with OPENCV or a simpler model."
            )
        want = MODELS[MODEL_IDS[self.model]][1]
        if len(self.params) != want:
            raise JobError(f"A {self.model} camera has {want} parameters, not {len(self.params)}.")

    # intrinsics -------------------------------------------------------------------------------
    @property
    def fx(self) -> float:
        return float(self.params[0])

    @property
    def fy(self) -> float:
        return float(self.params[1] if self.model in ("PINHOLE", "OPENCV", "FULL_OPENCV") else self.params[0])

    @property
    def cx(self) -> float:
        return float(self.params[2] if self.model in ("PINHOLE", "OPENCV", "FULL_OPENCV") else self.params[1])

    @property
    def cy(self) -> float:
        return float(self.params[3] if self.model in ("PINHOLE", "OPENCV", "FULL_OPENCV") else self.params[2])

    def k(self) -> np.ndarray:
        return np.array([[self.fx, 0, self.cx], [0, self.fy, self.cy], [0, 0, 1]], dtype=np.float64)

    def distortion(self) -> tuple[float, ...]:
        """(k1, k2, p1, p2, k3, k4, k5, k6), zeros where the model has none."""
        p = self.params
        if self.model == "SIMPLE_RADIAL":
            return (p[3], 0, 0, 0, 0, 0, 0, 0)
        if self.model == "RADIAL":
            return (p[3], p[4], 0, 0, 0, 0, 0, 0)
        if self.model == "OPENCV":
            return (p[4], p[5], p[6], p[7], 0, 0, 0, 0)
        if self.model == "FULL_OPENCV":
            return tuple(p[4:12])
        return (0.0,) * 8

    @property
    def distorted(self) -> bool:
        return any(abs(v) > 0 for v in self.distortion())

    def scaled(self, s: float) -> Camera:
        """The same camera for the image resized by ``s`` (pixel-centre convention)."""
        w, h = max(1, round(self.width * s)), max(1, round(self.height * s))
        sx, sy = w / self.width, h / self.height
        p = list(self.params)
        if self.model in ("PINHOLE", "OPENCV", "FULL_OPENCV"):
            p[0], p[1], p[2], p[3] = p[0] * sx, p[1] * sy, p[2] * sx, p[3] * sy
        else:
            p[0], p[1], p[2] = p[0] * sx, p[1] * sx, p[2] * sy
        return Camera(self.model, w, h, tuple(p))

    def pinhole(self) -> Camera:
        """The undistorted pinhole camera of the same size and intrinsics."""
        return Camera("PINHOLE", self.width, self.height, (self.fx, self.fy, self.cx, self.cy))

    # lens -------------------------------------------------------------------------------------
    def distort(self, u: np.ndarray, v: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Normalised undistorted coordinates to normalised distorted ones."""
        k1, k2, p1, p2, k3, k4, k5, k6 = self.distortion()
        if not self.distorted:
            return u, v
        r2 = u * u + v * v
        radial = (1 + r2 * (k1 + r2 * (k2 + r2 * k3))) / (1 + r2 * (k4 + r2 * (k5 + r2 * k6)))
        du = 2 * p1 * u * v + p2 * (r2 + 2 * u * u)
        dv = p1 * (r2 + 2 * v * v) + 2 * p2 * u * v
        return u * radial + du, v * radial + dv

    def undistort(
        self, ud: np.ndarray, vd: np.ndarray, iterations: int = 20
    ) -> tuple[np.ndarray, np.ndarray]:
        """Normalised distorted coordinates to undistorted ones (fixed-point iteration)."""
        if not self.distorted:
            return ud, vd
        k1, k2, p1, p2, k3, k4, k5, k6 = self.distortion()
        u, v = ud.copy(), vd.copy()
        for _ in range(iterations):
            r2 = u * u + v * v
            radial = (1 + r2 * (k1 + r2 * (k2 + r2 * k3))) / (1 + r2 * (k4 + r2 * (k5 + r2 * k6)))
            du = 2 * p1 * u * v + p2 * (r2 + 2 * u * u)
            dv = p1 * (r2 + 2 * v * v) + 2 * p2 * u * v
            u = (ud - du) / radial
            v = (vd - dv) / radial
        return u, v

    def project_cam(self, xc: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Camera-frame points (n, 3) to pixel x, y and depth z (pixels as COLMAP: centre 0.5)."""
        z = xc[:, 2]
        with np.errstate(divide="ignore", invalid="ignore"):
            u, v = xc[:, 0] / z, xc[:, 1] / z
        u, v = self.distort(u, v)
        return self.fx * u + self.cx, self.fy * v + self.cy, z

    def rays(self, x: np.ndarray, y: np.ndarray) -> np.ndarray:
        """Pixel coordinates to camera-frame directions with z = 1, shape (..., 3)."""
        u, v = self.undistort((x - self.cx) / self.fx, (y - self.cy) / self.fy)
        return np.stack([u, v, np.ones_like(u)], axis=-1)

    def pixel_rays(self) -> np.ndarray:
        """Directions (z = 1) through every pixel centre, shape (height, width, 3), float32."""
        ys, xs = np.mgrid[0 : self.height, 0 : self.width].astype(np.float64)
        return self.rays(xs + 0.5, ys + 0.5).astype(np.float32)


def quat_to_r(q: Iterable[float]) -> np.ndarray:
    qw, qx, qy, qz = (float(v) for v in q)
    n = math.sqrt(qw * qw + qx * qx + qy * qy + qz * qz) or 1.0
    qw, qx, qy, qz = qw / n, qx / n, qy / n, qz / n
    return np.array(
        [
            [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)],
            [2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)],
            [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)],
        ]
    )


def r_to_quat(r: np.ndarray) -> tuple[float, float, float, float]:
    m = np.asarray(r, dtype=np.float64)
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
    if q[0] < 0:
        q = (-q[0], -q[1], -q[2], -q[3])
    return q


@dataclass
class View:
    """One registered photo: its camera, pose (world to camera) and file."""

    id: int
    name: str
    camera: Camera
    r: np.ndarray  # 3x3 world to camera
    t: np.ndarray  # 3
    path: Path | None = None

    @property
    def centre(self) -> np.ndarray:
        return -self.r.T @ self.t

    @property
    def axis(self) -> np.ndarray:
        """Viewing direction in the world (the camera's +z)."""
        return self.r[2]

    def to_cam(self, xw: np.ndarray) -> np.ndarray:
        return np.asarray(xw, dtype=np.float64).reshape(-1, 3) @ self.r.T + self.t

    def project(self, xw: np.ndarray, camera: Camera | None = None):
        """World points to pixel x, y and depth with this view's camera (or a scaled copy)."""
        return (camera or self.camera).project_cam(self.to_cam(xw))


@dataclass
class SparseModel:
    views: list[View]
    points: np.ndarray  # (n, 3) world
    colours: np.ndarray  # (n, 3) uint8
    #: image ids that observe each point (empty lists when the model has no tracks)
    tracks: list[list[int]] = field(default_factory=list)

    def view(self, vid: int) -> View:
        for v in self.views:
            if v.id == vid:
                return v
        raise KeyError(vid)


# ------------------------------------------------------------------------------- reading models


def _read_text(folder: Path) -> SparseModel:
    cams: dict[int, Camera] = {}
    for line in (folder / "cameras.txt").read_text("utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        p = line.split()
        cams[int(p[0])] = Camera(p[1], int(p[2]), int(p[3]), tuple(float(x) for x in p[4:]))
    views: list[View] = []
    lines = [ln for ln in (folder / "images.txt").read_text("utf-8").splitlines() if not ln.startswith("#")]
    i = 0
    while i < len(lines):
        head = lines[i].strip()
        if not head:
            i += 1
            continue
        p = head.split(maxsplit=9)
        if len(p) < 10:
            raise JobError(f"The sparse model's images.txt has a short line: {head[:80]}")
        cid = int(p[8])
        if cid not in cams:
            raise JobError(f"Image {p[9]} uses camera {cid}, which the model does not have.")
        views.append(
            View(
                id=int(p[0]),
                name=p[9],
                camera=cams[cid],
                r=quat_to_r(float(x) for x in p[1:5]),
                t=np.array([float(x) for x in p[5:8]]),
            )
        )
        i += 2  # the points2D line follows
    pts: list[list[float]] = []
    cols: list[list[int]] = []
    tracks: list[list[int]] = []
    p3 = folder / "points3D.txt"
    if p3.is_file():
        for line in p3.read_text("utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            p = line.split()
            pts.append([float(p[1]), float(p[2]), float(p[3])])
            cols.append([int(p[4]), int(p[5]), int(p[6])])
            tracks.append(sorted({int(x) for x in p[8::2]}))
    return SparseModel(
        views,
        np.array(pts, dtype=np.float64).reshape(-1, 3),
        np.array(cols, dtype=np.uint8).reshape(-1, 3),
        tracks,
    )


class _Reader:
    def __init__(self, data: bytes):
        self.d, self.o = data, 0

    def take(self, fmt: str) -> tuple[Any, ...]:
        v = struct.unpack_from("<" + fmt, self.d, self.o)
        self.o += struct.calcsize("<" + fmt)
        return v

    def cstr(self) -> str:
        end = self.d.index(b"\0", self.o)
        s = self.d[self.o : end].decode("utf-8")
        self.o = end + 1
        return s


def _read_binary(folder: Path) -> SparseModel:
    r = _Reader((folder / "cameras.bin").read_bytes())
    cams: dict[int, Camera] = {}
    for _ in range(r.take("Q")[0]):
        cid, mid, w, h = r.take("iiQQ")
        if mid not in MODELS:
            raise JobError(f"The camera model id {mid} is not supported; align with OPENCV or simpler.")
        name, n = MODELS[mid]
        cams[cid] = Camera(name, int(w), int(h), tuple(r.take(f"{n}d")))
    r = _Reader((folder / "images.bin").read_bytes())
    views: list[View] = []
    for _ in range(r.take("Q")[0]):
        iid, qw, qx, qy, qz, tx, ty, tz, cid = r.take("idddddddi")
        name = r.cstr()
        (n2,) = r.take("Q")
        r.o += n2 * 24
        views.append(View(int(iid), name, cams[cid], quat_to_r((qw, qx, qy, qz)), np.array([tx, ty, tz])))
    pts: list[tuple[float, float, float]] = []
    cols: list[tuple[int, int, int]] = []
    tracks: list[list[int]] = []
    p3 = folder / "points3D.bin"
    if p3.is_file():
        r = _Reader(p3.read_bytes())
        for _ in range(r.take("Q")[0]):
            _pid, x, y, z, cr, cg, cb, _err, n = r.take("QdddBBBdQ")
            track = r.take(f"{2 * n}i") if n else ()
            pts.append((x, y, z))
            cols.append((cr, cg, cb))
            tracks.append(sorted(set(track[0::2])))
    return SparseModel(
        views,
        np.array(pts, dtype=np.float64).reshape(-1, 3),
        np.array(cols, dtype=np.uint8).reshape(-1, 3),
        tracks,
    )


def read_model(folder: Path) -> SparseModel:
    """A COLMAP model folder (text or binary); the first one found under ``folder`` (``0/``...)."""
    for cand in (folder, folder / "0"):
        if (cand / "images.bin").is_file() and (cand / "cameras.bin").is_file():
            return _read_binary(cand)
        if (cand / "images.txt").is_file() and (cand / "cameras.txt").is_file():
            return _read_text(cand)
    raise JobError("The run has no sparse model (photogrammetry/<run>/sparse/); align the photos first.")


def write_text_model(folder: Path, model: SparseModel) -> None:
    """Write a model as COLMAP text (used for tests and for handing a model to native tools)."""
    folder.mkdir(parents=True, exist_ok=True)
    cams: dict[Camera, int] = {}
    for v in model.views:
        cams.setdefault(v.camera, len(cams) + 1)
    lines = ["# Camera list: CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]"]
    for cam, cid in cams.items():
        lines.append(
            f"{cid} {cam.model} {cam.width} {cam.height} " + " ".join(repr(float(p)) for p in cam.params)
        )
    (folder / "cameras.txt").write_text("\n".join(lines) + "\n", "utf-8")
    lines = ["# IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME"]
    for v in model.views:
        q = r_to_quat(v.r)
        lines.append(
            f"{v.id} " + " ".join(repr(float(x)) for x in (*q, *v.t)) + f" {cams[v.camera]} {v.name}"
        )
        lines.append("")
    (folder / "images.txt").write_text("\n".join(lines) + "\n", "utf-8")
    lines = ["# POINT3D_ID, X, Y, Z, R, G, B, ERROR, TRACK[] as (IMAGE_ID, POINT2D_IDX)"]
    for i, p in enumerate(model.points):
        c = model.colours[i] if len(model.colours) > i else (128, 128, 128)
        track = model.tracks[i] if i < len(model.tracks) else []
        tr = " ".join(f"{iid} 0" for iid in track)
        lines.append(
            f"{i + 1} {float(p[0])!r} {float(p[1])!r} {float(p[2])!r} {int(c[0])} {int(c[1])} {int(c[2])} 0.5 {tr}".rstrip()
        )
    (folder / "points3D.txt").write_text("\n".join(lines) + "\n", "utf-8")


# ------------------------------------------------------------------------------------- the run


@dataclass
class Run:
    id: str
    dir: Path
    doc: dict[str, Any]
    model: SparseModel
    #: added to model coordinates to get project CRS coordinates
    offset: np.ndarray
    epsg: int | None
    manifest: dict[str, Any]

    @property
    def origin(self) -> np.ndarray:
        o = self.manifest.get("origin")
        if isinstance(o, list) and len(o) == 3 and all(isinstance(v, int | float) for v in o):
            return np.array(o, dtype=np.float64)
        raise JobError("The project has no origin, so the products cannot be placed.")


def read_json(path: Path, what: str) -> dict[str, Any]:
    try:
        doc = json.loads(path.read_text("utf-8-sig"))
    except FileNotFoundError as e:
        raise JobError(f"{what} is missing ({path.name}).") from e
    except (OSError, ValueError) as e:
        raise JobError(f"{what} could not be read: {e}") from e
    if not isinstance(doc, dict):
        raise JobError(f"{what} is not a JSON object.")
    return doc


def _photo_roots(project: Path, doc: dict[str, Any], manifest: dict[str, Any]) -> list[Path]:
    src = ((doc.get("photos") or {}).get("source")) or {}
    roots: list[Path] = []
    for f in src.get("folders") or []:
        if isinstance(f, str) and f:
            p = Path(f)
            roots.append(p if p.is_absolute() else project / p)
    layer = src.get("layer")
    if isinstance(layer, str):
        for lay in manifest.get("layers") or []:
            if isinstance(lay, dict) and lay.get("id") == layer and lay.get("kind") == "photos":
                for item in lay.get("items") or []:
                    rel = ((item or {}).get("src") or {}).get("path")
                    if isinstance(rel, str):
                        parent = safe_project_path(project, rel).parent
                        if parent not in roots:
                            roots.append(parent)
    roots.append(project)
    return roots


def resolve_photos(project: Path, doc: dict[str, Any], manifest: dict[str, Any], views: list[View]) -> None:
    """Set ``view.path`` for every view; refuse with the first photo that cannot be found."""
    roots = _photo_roots(project, doc, manifest)
    missing: list[str] = []
    for v in views:
        name = v.name.replace("\\", "/")
        cands = [Path(name)] if Path(name).is_absolute() else [r / name for r in roots]
        # "<folder index>/<name>" when the run has several folders
        head, _, tail = name.partition("/")
        if head.isdigit() and tail:
            folders = ((doc.get("photos") or {}).get("source") or {}).get("folders") or []
            if int(head) < len(folders):
                cands.insert(0, Path(folders[int(head)]) / tail)
        v.path = next((c for c in cands if c.is_file()), None)
        if v.path is None:
            missing.append(v.name)
    if missing:
        more = f" and {len(missing) - 1} more" if len(missing) > 1 else ""
        raise JobError(
            f"The photo {missing[0]}{more} cannot be found where the run says; reconnect the photos."
        )


def load_run(project: Path, run_id: str) -> Run:
    rdir = safe_project_path(project, f"photogrammetry/{run_id}")
    if not rdir.is_dir():
        raise JobError(f'The project has no run "{run_id}".')
    doc = read_json(rdir / "run.json", f'The run "{run_id}"')
    manifest = read_json(safe_project_path(project, "manifest.json"), "The project manifest")
    model = read_model(rdir / "sparse")
    if len(model.views) < 2:
        raise JobError("The run registered fewer than two photos; there is nothing to match.")
    off = doc.get("sparseOffset") or [0, 0, 0]
    if not (isinstance(off, list) and len(off) == 3 and all(isinstance(v, int | float) for v in off)):
        raise JobError('The run\'s "sparseOffset" is not three numbers.')
    crs = doc.get("crs") or manifest.get("crs") or {}
    epsg = crs.get("epsg") if isinstance(crs.get("epsg"), int) else None
    resolve_photos(project, doc, manifest, model.views)
    return Run(run_id, rdir, doc, model, np.array(off, dtype=np.float64), epsg, manifest)


def load_image(path: Path, scale: float = 1.0, gray: bool = False) -> np.ndarray:
    """A photo as uint8 RGB (or grey), resized by ``scale``; EXIF orientation is not applied (the
    model's cameras are in the stored pixel grid, as COLMAP reads it)."""
    from PIL import Image

    try:
        with Image.open(path) as im:
            im = im.convert("L" if gray else "RGB")
            if abs(scale - 1.0) > 1e-9:
                w, h = max(1, round(im.width * scale)), max(1, round(im.height * scale))
                im = im.resize((w, h), Image.Resampling.LANCZOS if scale < 1 else Image.Resampling.BILINEAR)
            return np.asarray(im)
    except OSError as e:
        raise JobError(f"The photo {path.name} could not be read: {e}") from e
