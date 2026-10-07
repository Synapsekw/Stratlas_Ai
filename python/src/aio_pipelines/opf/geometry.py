"""Frames, rotations and lenses shared by ``opf.import`` and ``opf.export``.

Conventions (OPF 1.0 specification, CC-BY-4.0, Pix4D; Stratlas data-conventions sections 1 and 21):

- **OPF processing CRS**: the scene reference frame's base CRS made right-handed and isometric
  (``canonical = shift + swap(scale * base)``), centred near (0, 0, 0) by ``shift``.
- **OPF image CS**: right, top, back (the camera looks along -Z), which is also the three.js camera
  frame of a photos layer's ``q``. Calibrated orientations are Omega-Phi-Kappa angles of
  ``R = Rx(omega) Ry(phi) Rz(kappa)`` from the image CS to the processing CRS.
- **COLMAP**: ``qvec``/``tvec`` map world to camera, camera axes right, down, front, so
  ``R_colmap = F @ R_opf.T`` with ``F = diag(1, -1, -1)``. Pixel centres are at +0.5 in both.
- **A run's sparse model** (``photogrammetry/<run>/sparse/``) is in the project CRS: easting,
  northing and height, unshifted (``E, N, H``).
- **The local frame** of the manifest: ``x = E - origin[0]``, ``y = H - origin[2]``,
  ``z = -(N - origin[1])`` (Y up, X east, Z south).
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Any

import numpy as np

from ..runtime import JobError

#: OPF image CS (right, top, back) to and from COLMAP's camera axes (right, down, front).
FLIP = np.diag([1.0, -1.0, -1.0])
#: Project ENU (east, north, up) directions to the local frame (x east, y up, z south).
ENU_TO_LOCAL = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0]])
#: glTF scene (Y up) to the OPF processing frame (Z up): the inverse of the spec's Z-up to Y-up node matrix.
GLTF_TO_ZUP = np.array(
    [[1.0, 0.0, 0.0, 0.0], [0.0, 0.0, -1.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0]]
)
ZUP_TO_GLTF = np.linalg.inv(GLTF_TO_ZUP)


# ---------------------------------------------------------------- rotations


def opk_matrix(angles_deg) -> np.ndarray:
    """``Rx(omega) Ry(phi) Rz(kappa)`` from Omega-Phi-Kappa angles in degrees."""
    w, p, k = (math.radians(float(a)) for a in angles_deg)
    cw, sw, cp, sp, ck, sk = math.cos(w), math.sin(w), math.cos(p), math.sin(p), math.cos(k), math.sin(k)
    rx = np.array([[1, 0, 0], [0, cw, -sw], [0, sw, cw]])
    ry = np.array([[cp, 0, sp], [0, 1, 0], [-sp, 0, cp]])
    rz = np.array([[ck, -sk, 0], [sk, ck, 0], [0, 0, 1]])
    return rx @ ry @ rz


def opk_angles(r: np.ndarray) -> list[float]:
    """Omega-Phi-Kappa angles in degrees of a rotation matrix (the inverse of :func:`opk_matrix`)."""
    phi = math.asin(max(-1.0, min(1.0, float(r[0, 2]))))
    if abs(r[0, 2]) < 1 - 1e-12:
        omega = math.atan2(-r[1, 2], r[2, 2])
        kappa = math.atan2(-r[0, 1], r[0, 0])
    else:  # gimbal lock: kappa folded into omega
        omega = math.atan2(r[2, 1], r[1, 1])
        kappa = 0.0
    return [math.degrees(omega), math.degrees(phi), math.degrees(kappa)]


def quat_wxyz_to_matrix(q) -> np.ndarray:
    w, x, y, z = (float(v) for v in q)
    n = math.sqrt(w * w + x * x + y * y + z * z) or 1.0
    w, x, y, z = w / n, x / n, y / n, z / n
    return np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ]
    )


def matrix_to_quat_wxyz(r: np.ndarray) -> list[float]:
    """Unit quaternion (w, x, y, z) of a rotation matrix, with w >= 0."""
    m = np.asarray(r, dtype=np.float64)
    t = m[0, 0] + m[1, 1] + m[2, 2]
    if t > 0:
        s = math.sqrt(t + 1.0) * 2
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
    n = math.sqrt(sum(v * v for v in q)) or 1.0
    q = [v / n for v in q]
    return [-v for v in q] if q[0] < 0 else q


def nearest_rotation(m: np.ndarray) -> np.ndarray:
    """The rotation closest to ``m`` (polar decomposition): turns a local Jacobian into axes."""
    u, _, vt = np.linalg.svd(m)
    r = u @ vt
    if np.linalg.det(r) < 0:
        u[:, -1] *= -1
        r = u @ vt
    return r


def opf_to_colmap(r_opf: np.ndarray, centre) -> tuple[list[float], list[float]]:
    """COLMAP ``qvec`` (w, x, y, z) and ``tvec`` of a camera at ``centre`` with OPF rotation ``r_opf``."""
    r_cw = FLIP @ r_opf.T
    t = -r_cw @ np.asarray(centre, dtype=np.float64)
    return matrix_to_quat_wxyz(r_cw), [float(v) for v in t]


def colmap_to_opf(qvec, tvec) -> tuple[np.ndarray, np.ndarray]:
    """OPF rotation (image CS to world) and camera centre from COLMAP ``qvec``/``tvec``."""
    r_cw = quat_wxyz_to_matrix(qvec)
    centre = -r_cw.T @ np.asarray(tvec, dtype=np.float64)
    return r_cw.T @ FLIP, centre


def local_pose(r_enu: np.ndarray, enh, origin) -> tuple[list[float], list[float]]:
    """A photos layer's ``pos`` (local frame) and ``q`` (three.js x, y, z, w) of a camera.

    ``r_enu`` maps the OPF image CS (the three.js camera frame) to east, north, up.
    """
    e, n, h = (float(v) for v in enh)
    pos = [e - float(origin[0]), h - float(origin[2]), -(n - float(origin[1]))]
    w, x, y, z = matrix_to_quat_wxyz(ENU_TO_LOCAL @ r_enu)
    return [round(v, 4) for v in pos], [round(x, 7), round(y, 7), round(z, 7), round(w, 7)]


# ---------------------------------------------------------------- lenses


@dataclass
class Lens:
    """A perspective lens in OPF terms (pixels; principal point from the image's top-left corner)."""

    width: int
    height: int
    focal_px: float
    cx: float
    cy: float
    radial: tuple[float, float, float] = (0.0, 0.0, 0.0)
    tangential: tuple[float, float] = (0.0, 0.0)

    def pinhole(self) -> dict[str, Any]:
        """The manifest's ``LensModel`` (the distortion and principal point stay in the run)."""
        hfov = math.degrees(2 * math.atan(self.width / (2 * self.focal_px)))
        return {"model": "pinhole", "hfovDeg": round(hfov, 6), "aspect": round(self.width / self.height, 6)}


#: COLMAP camera models we read (name -> parameter count) and their ids in the binary format.
COLMAP_MODELS = {
    "SIMPLE_PINHOLE": (0, 3),
    "PINHOLE": (1, 4),
    "SIMPLE_RADIAL": (2, 4),
    "RADIAL": (3, 5),
    "OPENCV": (4, 8),
    "OPENCV_FISHEYE": (5, 8),
    "FULL_OPENCV": (6, 12),
    "FOV": (7, 5),
    "SIMPLE_RADIAL_FISHEYE": (8, 4),
    "RADIAL_FISHEYE": (9, 5),
    "THIN_PRISM_FISHEYE": (10, 12),
    "RAD_TAN_THIN_PRISM_FISHEYE": (11, 16),
}
COLMAP_MODEL_NAMES = {mid: name for name, (mid, _) in COLMAP_MODELS.items()}


def lens_from_colmap(model: str, width: int, height: int, params: list[float]) -> tuple[Lens, list[str]]:
    """An OPF perspective lens from a COLMAP camera, with notes on what could not be carried."""
    p = [float(v) for v in params]
    notes: list[str] = []

    def focal(fx: float, fy: float) -> float:
        if abs(fx - fy) > 1e-9 * max(abs(fx), 1.0):
            notes.append(f"fx {fx:.3f} and fy {fy:.3f} differ; OPF has one focal length, their mean is used")
        return (fx + fy) / 2

    if model == "SIMPLE_PINHOLE":
        return Lens(width, height, p[0], p[1], p[2]), notes
    if model == "PINHOLE":
        return Lens(width, height, focal(p[0], p[1]), p[2], p[3]), notes
    if model == "SIMPLE_RADIAL":
        return Lens(width, height, p[0], p[1], p[2], (p[3], 0.0, 0.0)), notes
    if model == "RADIAL":
        return Lens(width, height, p[0], p[1], p[2], (p[3], p[4], 0.0)), notes
    if model == "OPENCV":
        return Lens(width, height, focal(p[0], p[1]), p[2], p[3], (p[4], p[5], 0.0), (p[6], p[7])), notes
    if model == "FULL_OPENCV":
        if any(abs(v) > 0 for v in p[9:12]):
            notes.append("the rational distortion terms k4 to k6 have no OPF equivalent and are left out")
        return (
            Lens(width, height, focal(p[0], p[1]), p[2], p[3], (p[4], p[5], p[8]), (p[6], p[7])),
            notes,
        )
    raise JobError(f"The COLMAP camera model {model} has no OPF perspective equivalent.")


def lens_to_colmap(lens: Lens) -> tuple[str, list[float]]:
    """COLMAP ``OPENCV`` (or ``FULL_OPENCV`` when R3 is set) parameters of an OPF perspective lens."""
    f = lens.focal_px
    k1, k2, k3 = lens.radial
    p1, p2 = lens.tangential
    if k3 == 0:
        return "OPENCV", [f, f, lens.cx, lens.cy, k1, k2, p1, p2]
    return "FULL_OPENCV", [f, f, lens.cx, lens.cy, k1, k2, p1, p2, k3, 0.0, 0.0, 0.0]


# ---------------------------------------------------------------- coordinate reference systems


def _balanced(text: str, start: int) -> str:
    """The WKT node that starts at ``start`` (``KEYWORD[...]``), brackets balanced."""
    depth = 0
    for i in range(text.index("[", start), len(text)):
        if text[i] == "[":
            depth += 1
        elif text[i] == "]":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    raise ValueError("unbalanced WKT")


@dataclass
class CrsInfo:
    """An OPF CRS definition read for this build: its horizontal CRS and what the heights are."""

    definition: str
    horizontal: Any | None  # rasterio CRS; None for an arbitrary (engineering) frame
    vertical: str | None  # what the definition says about heights, for the report
    arbitrary: bool


def read_crs(definition: str) -> CrsInfo:
    """Parse an OPF CRS definition (``EPSG:a``, ``EPSG:a+b``, ``EPSG:a+EPSG:b`` or WKT 2).

    Compound definitions keep their horizontal part; heights are used as they are and the
    vertical part is named in the report. Engineering CRSs (an arbitrary site frame) and
    definitions PROJ cannot read are ``arbitrary``.
    """
    from rasterio.crs import CRS
    from rasterio.errors import CRSError

    d = (definition or "").strip()
    m = re.fullmatch(r"([A-Za-z]+):(\d+)(?:\+(?:([A-Za-z]+):)?(\d+))?", d)
    try:
        if m:
            auth, code, vauth, vcode = m.groups()
            horizontal = CRS.from_user_input(f"{auth.upper()}:{code}")
            vertical = f"{(vauth or auth).upper()}:{vcode}" if vcode else None
            return CrsInfo(d, horizontal, vertical, False)
        head = d.split("[", 1)[0].strip().upper()
        if head in ("ENGCRS", "ENGINEERINGCRS", "LOCAL_CS") or not d:
            return CrsInfo(d, None, None, True)
        if head in ("COMPOUNDCRS", "COMPD_CS"):
            sub = re.search(r"\b(PROJCRS|PROJECTEDCRS|PROJCS|GEOGCRS|GEOGRAPHICCRS|GEOGCS)\[", d[len(head) :])
            vsub = re.search(r"\b(VERTCRS|VERTICALCRS|VERT_CS)\[\s*\"([^\"]*)\"", d)
            if not sub:
                return CrsInfo(d, None, None, True)
            start = len(head) + sub.start()
            horizontal = CRS.from_wkt(_balanced(d, start))
            return CrsInfo(d, horizontal, vsub.group(2) if vsub else "a vertical CRS", False)
        return CrsInfo(d, CRS.from_wkt(d), None, False)
    except (CRSError, ValueError):
        return CrsInfo(d, None, None, True)


def north_first(crs) -> bool:
    """True when the CRS's first axis points north (latitude first, or northing before easting)."""
    if crs is None:
        return False
    try:
        wkt = crs.to_wkt(version="WKT2_2019")
    except TypeError:  # older rasterio
        wkt = crs.to_wkt()
    m = re.search(r'AXIS\["[^"]*",\s*(\w+)', wkt)
    return bool(m and m.group(1).lower() in ("north", "south"))


def same_crs(a, b) -> bool:
    if a is None or b is None:
        return False
    try:
        if a == b:
            return True
        ea, eb = a.to_epsg(), b.to_epsg()
        return ea is not None and ea == eb
    except Exception:
        return False


def project_crs(manifest: dict[str, Any]):
    from rasterio.crs import CRS
    from rasterio.errors import CRSError

    c = manifest.get("crs") or {}
    try:
        if isinstance(c.get("epsg"), int):
            return CRS.from_epsg(c["epsg"])
        if isinstance(c.get("wkt"), str):
            return CRS.from_wkt(c["wkt"])
    except CRSError as e:
        raise JobError(f"The project CRS could not be read: {e}") from e
    raise JobError("The project manifest has no CRS.")


def crs_definition(manifest: dict[str, Any]) -> str:
    """The project CRS as an OPF CRS definition (``EPSG:n`` or WKT 2)."""
    c = manifest.get("crs") or {}
    if isinstance(c.get("epsg"), int):
        return f"EPSG:{c['epsg']}"
    crs = project_crs(manifest)
    try:
        return crs.to_wkt(version="WKT2_2019")
    except TypeError:
        return crs.to_wkt()


class SceneFrame:
    """OPF processing coordinates to the project's E, N, H (and camera axes with them).

    ``arbitrary`` frames (no reference frame, or an engineering CRS) are placed with the processing
    origin on the project origin, unscaled and unrotated, and the report says so.
    """

    def __init__(self, srf: Any | None, project: Any, origin) -> None:
        self.origin = np.asarray(origin, dtype=np.float64)
        self.project = project
        self.notes: list[str] = []
        if srf is None:
            self.info = CrsInfo("", None, None, True)
            self.shift = np.zeros(3)
            self.scale = np.ones(3)
            self.swap = False
        else:
            self.info = read_crs(srf.crs.definition)
            b2c = srf.base_to_canonical
            self.shift = np.asarray(b2c.shift, dtype=np.float64)
            self.scale = np.asarray(b2c.scale, dtype=np.float64)
            self.swap = bool(b2c.swap_xy)
        if np.any(self.scale == 0) or not np.all(np.isfinite(self.scale)):
            raise JobError("The OPF scene reference frame has a zero scale.")
        self.arbitrary = self.info.arbitrary
        self.same = not self.arbitrary and same_crs(self.info.horizontal, project)
        self.base_north_first = north_first(self.info.horizontal)
        if self.arbitrary:
            self.notes.append(
                "The OPF has no georeference (an arbitrary or unknown frame): its cameras and points "
                "are placed with their processing origin on the project origin, unrotated."
            )
        elif not self.same:
            self.notes.append(
                f"The OPF CRS ({_short(self.info.definition)}) differs from the project CRS: positions "
                "are reprojected horizontally, heights are kept as they are."
            )
        if self.info.vertical:
            self.notes.append(f"OPF heights refer to {self.info.vertical}; they are used as they are.")

    def _base(self, p: np.ndarray) -> np.ndarray:
        q = p - self.shift
        if self.swap:
            q = q[:, [1, 0, 2]]
        return q / self.scale

    def to_project(self, proc) -> np.ndarray:
        """(n, 3) processing coordinates to (n, 3) project easting, northing, height."""
        p = np.atleast_2d(np.asarray(proc, dtype=np.float64))
        if self.arbitrary:
            return p + self.origin
        base = self._base(p)
        trad = base[:, [1, 0, 2]] if self.base_north_first else base
        if self.same:
            return trad.copy()
        from rasterio.warp import transform

        xs, ys = transform(self.info.horizontal, self.project, trad[:, 0].tolist(), trad[:, 1].tolist())
        out = np.column_stack([np.asarray(xs), np.asarray(ys), trad[:, 2]])
        if not np.all(np.isfinite(out)):
            raise JobError("Some OPF coordinates could not be reprojected into the project CRS.")
        return out

    def axes_at(self, proc_point) -> np.ndarray:
        """The rotation taking processing-frame directions to project east, north, up at a point."""
        if self.arbitrary:
            return np.eye(3)
        p = np.asarray(proc_point, dtype=np.float64).reshape(1, 3)
        step = 1.0
        pts = np.vstack([p, p + np.eye(3) * step])
        f = self.to_project(pts)
        jac = np.column_stack([(f[i + 1] - f[0]) / step for i in range(3)])
        return nearest_rotation(jac)


def _short(definition: str) -> str:
    d = definition.strip()
    if len(d) <= 40:
        return d
    m = re.search(r'^\w+\[\s*"([^"]+)"', d)
    return m.group(1) if m else d[:40] + "..."
