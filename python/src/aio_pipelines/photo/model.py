"""The sparse model in plain numpy: cameras, images, observations and 3D points.

Engine-neutral, so georeferencing, the GCP adjustment and the accuracy report run without the
SfM engine, and ``photo.products`` and ``opf.export`` can read a run's model without pycolmap.

Conventions are COLMAP's: an image's pose is world-to-camera (``x_cam = R @ X + t``, the camera
looks along +z with image x right and y down; centre ``C = -R.T @ t``); pixel coordinates have
the image's top-left corner at (0, 0), so the first pixel's centre is (0.5, 0.5). Camera models
``SIMPLE_PINHOLE``, ``PINHOLE``, ``SIMPLE_RADIAL``, ``RADIAL``, ``OPENCV`` and ``FULL_OPENCV``.

Files:
- ``sparse/`` holds a COLMAP text model (``cameras.txt``, ``images.txt``, ``points3D.txt``),
  written compacted: an image lists only its 2D points that have a 3D point.
- ``model.npz`` is the exchange file between the engine worker and the pipeline (fast to read).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from ..runtime import JobError

#: Parameter names per camera model (COLMAP order).
CAMERA_MODELS: dict[str, tuple[str, ...]] = {
    "SIMPLE_PINHOLE": ("f", "cx", "cy"),
    "PINHOLE": ("fx", "fy", "cx", "cy"),
    "SIMPLE_RADIAL": ("f", "cx", "cy", "k"),
    "RADIAL": ("f", "cx", "cy", "k1", "k2"),
    "OPENCV": ("fx", "fy", "cx", "cy", "k1", "k2", "p1", "p2"),
    "FULL_OPENCV": ("fx", "fy", "cx", "cy", "k1", "k2", "p1", "p2", "k3", "k4", "k5", "k6"),
}


@dataclass
class Camera:
    id: int
    model: str
    width: int
    height: int
    params: np.ndarray

    def __post_init__(self):
        if self.model not in CAMERA_MODELS:
            raise JobError(f"Camera model {self.model} is not supported.")
        self.params = np.asarray(self.params, dtype=np.float64)
        if len(self.params) != len(CAMERA_MODELS[self.model]):
            raise JobError(f"Camera model {self.model} needs {len(CAMERA_MODELS[self.model])} parameters.")

    @property
    def focal(self) -> float:
        p = self.params
        return (
            float(p[0])
            if self.model in ("SIMPLE_PINHOLE", "SIMPLE_RADIAL", "RADIAL")
            else float((p[0] + p[1]) / 2)
        )

    def canonical(self) -> np.ndarray:
        return canonical_params(self.model, self.params[None])[0]


def canonical_params(model: str, params: np.ndarray) -> np.ndarray:
    """Any model's parameters as FULL_OPENCV (fx, fy, cx, cy, k1, k2, p1, p2, k3, k4, k5, k6)."""
    p = np.atleast_2d(np.asarray(params, dtype=np.float64))
    out = np.zeros((len(p), 12))
    if model == "SIMPLE_PINHOLE":
        out[:, 0] = out[:, 1] = p[:, 0]
        out[:, 2:4] = p[:, 1:3]
    elif model == "PINHOLE":
        out[:, 0:4] = p[:, 0:4]
    elif model == "SIMPLE_RADIAL":
        out[:, 0] = out[:, 1] = p[:, 0]
        out[:, 2:4] = p[:, 1:3]
        out[:, 4] = p[:, 3]
    elif model == "RADIAL":
        out[:, 0] = out[:, 1] = p[:, 0]
        out[:, 2:4] = p[:, 1:3]
        out[:, 4:6] = p[:, 3:5]
    elif model == "OPENCV":
        out[:, 0:8] = p[:, 0:8]
    elif model == "FULL_OPENCV":
        out[:, :] = p[:, :12]
    else:
        raise JobError(f"Camera model {model} is not supported.")
    return out


def distort(canon: np.ndarray, u: np.ndarray, v: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Normalised image coordinates to distorted ones (COLMAP's OPENCV and FULL_OPENCV formulas)."""
    c = np.atleast_2d(canon)
    k1, k2, p1, p2, k3, k4, k5, k6 = (c[:, i] for i in range(4, 12))
    u2, v2, uv = u * u, v * v, u * v
    r2 = u2 + v2
    num = 1 + k1 * r2 + k2 * r2 * r2 + k3 * r2 * r2 * r2
    den = 1 + k4 * r2 + k5 * r2 * r2 + k6 * r2 * r2 * r2
    radial = num / den
    ud = u * radial + 2 * p1 * uv + p2 * (r2 + 2 * u2)
    vd = v * radial + 2 * p2 * uv + p1 * (r2 + 2 * v2)
    return ud, vd


def project_canonical(canon: np.ndarray, R: np.ndarray, C: np.ndarray, X: np.ndarray):
    """Project points per observation: canon (k, 12) or (12,), R (k, 3, 3), C (k, 3), X (k, 3)."""
    d = X - C
    cam = np.einsum("kij,kj->ki", R, d) if R.ndim == 3 else d @ R.T
    z = cam[:, 2]
    zs = np.where(np.abs(z) < 1e-12, 1e-12, z)
    u, v = cam[:, 0] / zs, cam[:, 1] / zs
    ud, vd = distort(canon, u, v)
    c = np.atleast_2d(canon)
    x = c[:, 0] * ud + c[:, 2]
    y = c[:, 1] * vd + c[:, 3]
    return np.stack([x, y], axis=1), z


def project_points(camera: Camera, R: np.ndarray, C: np.ndarray, X: np.ndarray):
    """Project world points through one camera: pixels (n, 2) and depths (n,)."""
    X = np.asarray(X, dtype=np.float64).reshape(-1, 3)
    return project_canonical(camera.canonical(), np.asarray(R), np.asarray(C), X)


def undistort_pixels(camera: Camera, uv: np.ndarray, iterations: int = 30) -> np.ndarray:
    """Pixels to normalised, undistorted image coordinates (fixed-point inversion)."""
    c = camera.canonical()
    uv = np.asarray(uv, dtype=np.float64).reshape(-1, 2)
    ud = (uv[:, 0] - c[2]) / c[0]
    vd = (uv[:, 1] - c[3]) / c[1]
    u, v = ud.copy(), vd.copy()
    for _ in range(iterations):
        du, dv = distort(c, u, v)
        u = u + (ud - du)
        v = v + (vd - dv)
    return np.stack([u, v], axis=1)


# ---------------------------------------------------------------------------- rotations


def rotmat_to_qvec(R: np.ndarray) -> np.ndarray:
    """A rotation matrix as a unit quaternion (w, x, y, z), w >= 0."""
    m = np.asarray(R, dtype=np.float64)
    tr = m[0, 0] + m[1, 1] + m[2, 2]
    if tr > 0:
        s = math.sqrt(tr + 1.0) * 2
        q = [0.25 * s, (m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s]
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        q = [(m[2, 1] - m[1, 2]) / s, 0.25 * s, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s]
    elif m[1, 1] > m[2, 2]:
        s = math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        q = [(m[0, 2] - m[2, 0]) / s, (m[0, 1] + m[1, 0]) / s, 0.25 * s, (m[1, 2] + m[2, 1]) / s]
    else:
        s = math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        q = [(m[1, 0] - m[0, 1]) / s, (m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, 0.25 * s]
    q = np.array(q)
    q /= np.linalg.norm(q)
    return -q if q[0] < 0 else q


def qvec_to_rotmat(q) -> np.ndarray:
    w, x, y, z = np.asarray(q, dtype=np.float64) / np.linalg.norm(q)
    return np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
            [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
            [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
        ]
    )


def rodrigues(w: np.ndarray) -> np.ndarray:
    """Rotation vectors (k, 3) to matrices (k, 3, 3)."""
    w = np.atleast_2d(np.asarray(w, dtype=np.float64))
    th = np.linalg.norm(w, axis=1)
    small = th < 1e-12
    k = np.where(small[:, None], 0.0, w / np.where(small, 1.0, th)[:, None])
    kx = np.zeros((len(w), 3, 3))
    kx[:, 0, 1], kx[:, 0, 2] = -k[:, 2], k[:, 1]
    kx[:, 1, 0], kx[:, 1, 2] = k[:, 2], -k[:, 0]
    kx[:, 2, 0], kx[:, 2, 1] = -k[:, 1], k[:, 0]
    s = np.sin(th)[:, None, None]
    c = (1 - np.cos(th))[:, None, None]
    return np.eye(3)[None] + s * kx + c * (kx @ kx)


def rotation_angle_deg(a: np.ndarray, b: np.ndarray) -> float:
    c = (np.trace(a.T @ b) - 1) / 2
    return math.degrees(math.acos(min(1.0, max(-1.0, c))))


# ---------------------------------------------------------------------------- the model


@dataclass
class Image:
    id: int
    name: str
    camera_id: int
    R: np.ndarray
    t: np.ndarray
    xys: np.ndarray = field(default_factory=lambda: np.zeros((0, 2)))
    point3D_ids: np.ndarray = field(default_factory=lambda: np.zeros(0, np.int64))

    def __post_init__(self):
        self.R = np.asarray(self.R, dtype=np.float64).reshape(3, 3)
        self.t = np.asarray(self.t, dtype=np.float64).reshape(3)
        self.xys = np.asarray(self.xys, dtype=np.float64).reshape(-1, 2)
        self.point3D_ids = np.asarray(self.point3D_ids, dtype=np.int64).reshape(-1)

    @property
    def centre(self) -> np.ndarray:
        return -self.R.T @ self.t

    def set_pose(self, R: np.ndarray, C: np.ndarray) -> None:
        self.R = np.asarray(R, dtype=np.float64)
        self.t = -self.R @ np.asarray(C, dtype=np.float64)


class SparseModel:
    def __init__(self):
        self.cameras: dict[int, Camera] = {}
        self.images: dict[int, Image] = {}
        self.point_ids = np.zeros(0, np.int64)
        self.xyz = np.zeros((0, 3))
        self.rgb = np.zeros((0, 3), np.uint8)
        self.error = np.zeros(0)

    # ---- building
    def add_point(self, pid: int, xyz, rgb, error: float, track: list[tuple[int, int]]) -> None:
        """Add one point (small models; fixtures). ``track`` is ``(image id, 2D point index)``."""
        self.point_ids = np.append(self.point_ids, pid)
        self.xyz = np.vstack([self.xyz, np.asarray(xyz, dtype=np.float64).reshape(1, 3)])
        self.rgb = np.vstack([self.rgb, np.asarray(rgb, dtype=np.uint8).reshape(1, 3)])
        self.error = np.append(self.error, error)
        for image_id, idx in track:
            self.images[image_id].point3D_ids[idx] = pid

    def set_points(self, ids, xyz, rgb=None, error=None) -> None:
        self.point_ids = np.asarray(ids, dtype=np.int64)
        self.xyz = np.asarray(xyz, dtype=np.float64).reshape(-1, 3)
        n = len(self.point_ids)
        self.rgb = (
            np.zeros((n, 3), np.uint8) if rgb is None else np.asarray(rgb, dtype=np.uint8).reshape(-1, 3)
        )
        self.error = np.zeros(n) if error is None else np.asarray(error, dtype=np.float64)

    # ---- views
    def image_by_name(self) -> dict[str, Image]:
        return {im.name: im for im in self.images.values()}

    def observations(self) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Every observation of a 3D point: (image ids, point indices into ``xyz``, pixels)."""
        order = np.argsort(self.point_ids, kind="stable")
        sorted_ids = self.point_ids[order]

        def lookup(ids: np.ndarray) -> np.ndarray:
            pos = np.clip(np.searchsorted(sorted_ids, ids), 0, max(len(sorted_ids) - 1, 0))
            hit = sorted_ids[pos] == ids
            return np.where(hit, order[pos], -1)

        img_ids, pts, xys = [], [], []
        for im in self.images.values():
            mask = im.point3D_ids >= 0
            if not mask.any() or len(sorted_ids) == 0:
                continue
            pi = lookup(im.point3D_ids[mask])
            ok = pi >= 0
            img_ids.append(np.full(int(ok.sum()), im.id, np.int64))
            pts.append(pi[ok])
            xys.append(im.xys[mask][ok])
        if not img_ids:
            return np.zeros(0, np.int64), np.zeros(0, np.int64), np.zeros((0, 2))
        return np.concatenate(img_ids), np.concatenate(pts), np.concatenate(xys)

    def reprojection_errors(self) -> np.ndarray:
        """Pixel error of every observation."""
        img_ids, pts, xys = self.observations()
        if len(img_ids) == 0:
            return np.zeros(0)
        out = np.empty(len(img_ids))
        for iid in np.unique(img_ids):
            m = img_ids == iid
            im = self.images[int(iid)]
            uv, _ = project_points(self.cameras[im.camera_id], im.R, im.centre, self.xyz[pts[m]])
            out[m] = np.linalg.norm(uv - xys[m], axis=1)
        return out

    def mean_reprojection_error(self) -> float:
        e = self.reprojection_errors()
        return float(e.mean()) if len(e) else 0.0

    def track_lengths(self) -> np.ndarray:
        _, pts, _ = self.observations()
        return (
            np.bincount(pts, minlength=len(self.point_ids))
            if len(pts)
            else np.zeros(len(self.point_ids), int)
        )

    def transform(self, scale: float, rot: np.ndarray, trans: np.ndarray) -> None:
        """Apply ``X' = scale * rot @ X + trans`` to points and cameras."""
        rot = np.asarray(rot, dtype=np.float64)
        trans = np.asarray(trans, dtype=np.float64)
        if len(self.xyz):
            self.xyz = scale * self.xyz @ rot.T + trans
        for im in self.images.values():
            c = scale * rot @ im.centre + trans
            im.set_pose(im.R @ rot.T, c)

    def copy(self) -> SparseModel:
        m = SparseModel()
        m.cameras = {
            k: Camera(c.id, c.model, c.width, c.height, c.params.copy()) for k, c in self.cameras.items()
        }
        m.images = {
            k: Image(i.id, i.name, i.camera_id, i.R.copy(), i.t.copy(), i.xys.copy(), i.point3D_ids.copy())
            for k, i in self.images.items()
        }
        m.set_points(self.point_ids.copy(), self.xyz.copy(), self.rgb.copy(), self.error.copy())
        return m

    # ---- files
    def write_text(self, folder: Path) -> None:
        """A COLMAP text model, compacted (an image lists only 2D points with a 3D point)."""
        folder.mkdir(parents=True, exist_ok=True)
        lines = ["# Camera list: CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]"]
        for c in sorted(self.cameras.values(), key=lambda c: c.id):
            lines.append(
                f"{c.id} {c.model} {c.width} {c.height} " + " ".join(repr(float(v)) for v in c.params)
            )
        (folder / "cameras.txt").write_text("\n".join(lines) + "\n", "utf-8")
        valid = set(int(p) for p in self.point_ids)
        tracks: dict[int, list[str]] = {}
        out = [
            "# Image list: IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME",
            "#   POINTS2D[] as (X, Y, POINT3D_ID)",
        ]
        for im in sorted(self.images.values(), key=lambda i: i.id):
            if " " in im.name:
                raise JobError(
                    f'The photo name "{im.name}" has a space, which COLMAP text files cannot hold.'
                )
            pose = " ".join(repr(float(v)) for v in (*rotmat_to_qvec(im.R), *im.t))
            out.append(f"{im.id} {pose} {im.camera_id} {im.name}")
            parts = []
            k = 0
            for (x, y), pid in zip(im.xys, im.point3D_ids, strict=True):
                if pid < 0 or int(pid) not in valid:
                    continue
                parts.append(f"{x:.3f} {y:.3f} {int(pid)}")
                tracks.setdefault(int(pid), []).append(f"{im.id} {k}")
                k += 1
            out.append(" ".join(parts))
        (folder / "images.txt").write_text("\n".join(out) + "\n", "utf-8")
        pts = ["# 3D point list: POINT3D_ID, X, Y, Z, R, G, B, ERROR, TRACK[] as (IMAGE_ID, POINT2D_IDX)"]
        for i, pid in enumerate(self.point_ids):
            tr = tracks.get(int(pid))
            if not tr:
                continue
            x, y, z = self.xyz[i]
            r, g, b = (int(v) for v in self.rgb[i])
            pts.append(f"{int(pid)} {x:.6f} {y:.6f} {z:.6f} {r} {g} {b} {self.error[i]:.4f} " + " ".join(tr))
        (folder / "points3D.txt").write_text("\n".join(pts) + "\n", "utf-8")

    @staticmethod
    def read_text(folder: Path) -> SparseModel:
        m = SparseModel()
        try:
            for line in (folder / "cameras.txt").read_text("utf-8").splitlines():
                if not line.strip() or line.startswith("#"):
                    continue
                p = line.split()
                m.cameras[int(p[0])] = Camera(
                    int(p[0]), p[1], int(p[2]), int(p[3]), np.array([float(v) for v in p[4:]])
                )
            lines = [
                ln for ln in (folder / "images.txt").read_text("utf-8").splitlines() if not ln.startswith("#")
            ]
            for k in range(0, len(lines) - 1, 2):
                head = lines[k].split()
                if not head:
                    continue
                q = np.array([float(v) for v in head[1:5]])
                t = np.array([float(v) for v in head[5:8]])
                vals = np.array(lines[k + 1].split(), dtype=np.float64).reshape(-1, 3)
                m.images[int(head[0])] = Image(
                    int(head[0]),
                    " ".join(head[9:]),
                    int(head[8]),
                    qvec_to_rotmat(q),
                    t,
                    vals[:, :2],
                    vals[:, 2].astype(np.int64),
                )
            ids, xyz, rgb, err = [], [], [], []
            for line in (folder / "points3D.txt").read_text("utf-8").splitlines():
                if not line.strip() or line.startswith("#"):
                    continue
                p = line.split()
                ids.append(int(p[0]))
                xyz.append([float(v) for v in p[1:4]])
                rgb.append([int(v) for v in p[4:7]])
                err.append(float(p[7]))
        except (OSError, ValueError, IndexError) as e:
            raise JobError(f"The sparse model in {folder.name} cannot be read: {e}") from e
        m.set_points(ids, np.array(xyz).reshape(-1, 3), np.array(rgb).reshape(-1, 3), err)
        return m

    def save_npz(self, path: Path) -> None:
        cams = sorted(self.cameras.values(), key=lambda c: c.id)
        imgs = sorted(self.images.values(), key=lambda i: i.id)
        counts = np.array([len(i.xys) for i in imgs], np.int64)
        np.savez(
            path,
            cam_ids=np.array([c.id for c in cams], np.int64),
            cam_models=np.array([c.model for c in cams]),
            cam_sizes=np.array([[c.width, c.height] for c in cams], np.int64).reshape(-1, 2),
            cam_params=np.array([np.pad(c.params, (0, 12 - len(c.params))) for c in cams]).reshape(-1, 12),
            img_ids=np.array([i.id for i in imgs], np.int64),
            img_names=np.array([i.name for i in imgs]),
            img_cams=np.array([i.camera_id for i in imgs], np.int64),
            img_R=np.array([i.R for i in imgs]).reshape(-1, 3, 3),
            img_t=np.array([i.t for i in imgs]).reshape(-1, 3),
            img_counts=counts,
            xys=np.concatenate([i.xys for i in imgs]) if imgs else np.zeros((0, 2)),
            p3d=np.concatenate([i.point3D_ids for i in imgs]) if imgs else np.zeros(0, np.int64),
            point_ids=self.point_ids,
            xyz=self.xyz,
            rgb=self.rgb,
            error=self.error,
        )

    @staticmethod
    def load_npz(path: Path) -> SparseModel:
        z = np.load(path, allow_pickle=False)
        m = SparseModel()
        for cid, model, size, params in zip(
            z["cam_ids"], z["cam_models"], z["cam_sizes"], z["cam_params"], strict=True
        ):
            n = len(CAMERA_MODELS[str(model)])
            m.cameras[int(cid)] = Camera(int(cid), str(model), int(size[0]), int(size[1]), params[:n])
        off = 0
        for iid, name, cam, R, t, cnt in zip(
            z["img_ids"], z["img_names"], z["img_cams"], z["img_R"], z["img_t"], z["img_counts"], strict=True
        ):
            m.images[int(iid)] = Image(
                int(iid), str(name), int(cam), R, t, z["xys"][off : off + cnt], z["p3d"][off : off + cnt]
            )
            off += int(cnt)
        m.set_points(z["point_ids"], z["xyz"], z["rgb"], z["error"])
        return m

    @staticmethod
    def load(path: Path) -> SparseModel:
        """A model from a COLMAP text folder or a ``model.npz``."""
        if path.is_file() and path.suffix == ".npz":
            return SparseModel.load_npz(path)
        if (path / "model.npz").is_file():
            return SparseModel.load_npz(path / "model.npz")
        return SparseModel.read_text(path)
