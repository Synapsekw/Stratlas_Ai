"""The ODM project of a run: ``photogrammetry/<run>/odm/`` (ADR 0012).

ODM sees only ASCII paths without cmd.exe metacharacters (C5: spaces are fine, a non-ASCII letter
breaks OpenSfM): a run folder below any other path is reached through a directory junction under
``AIO_ODM_WORK``. ``images/`` holds hard links to the source photos (copies when a link fails, e.g.
across drives), named ``00000.jpg``... in photo order so names never collide; ``names.json`` maps
them back to the photo keys. The folder lives between the jobs of a run; ``clean_intermediates``
removes the heavy stage folders after products commit and keeps the alignment.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ...runtime import JobError, atomic_write_json
from .. import crs as C
from .. import gcp as G

ODM_DIR = "odm"
WORK_ENV = "AIO_ODM_WORK"  # a safe folder for junctions, set by the app
SPACES_OK = True  # C5: spaces work; non-ASCII letters do not
#: what cmd.exe treats specially; ODM's command line passes through it
_CMD_SPECIAL = re.compile(r'[&^%!()<>|"]')
GEOREF_INVALIDATE = (
    "opensfm/reconstruction.json", "opensfm/reconstruction.topocentric.json", "opensfm/config.yaml",
    "opensfm/gcp_list.txt", "opensfm/undistorted", "opensfm/exif", "opensfm/camera_models.json",
    "opensfm/reference_lla.json", "opensfm/stats", "odm_georeferencing",
)  # fmt: skip
INTERMEDIATES = (
    "opensfm/undistorted", "openmvs", "odm_filterpoints", "odm_meshing", "odm_texturing", "odm_25dmeshing",
    "odm_texturing_25d", "odm_dem", "odm_orthophoto", "odm_georeferencing/odm_georeferenced_model.laz",
    "odm_georeferencing/odm_georeferenced_model.copc.laz", "odm_georeferencing/odm_georeferenced_model.las",
)  # fmt: skip
NEED_THREE = "At least three usable control points are needed (each marked in two or more photos)."


def odm_project_dir(project: Path, run: str) -> Path:
    return project / "photogrammetry" / run / ODM_DIR


def is_safe_path(p: Path) -> bool:
    """ASCII and nothing cmd.exe treats specially; spaces are fine when ``SPACES_OK`` (C5, measured).
    A non-ASCII letter breaks OpenSfM. 8.3 short names (``C:\\Users\\RUNNER~1``) are safe."""
    s = str(p)
    if not s.isascii() or _CMD_SPECIAL.search(s):
        return False
    return SPACES_OK or not any(ch.isspace() for ch in s)


def odm_path(real: Path, work_root: Path | None) -> Path:
    if is_safe_path(real):
        return real
    if work_root is None or not is_safe_path(work_root):
        raise JobError(
            "The project folder's path has letters ODM cannot use, and no safe working "
            "folder was given. Reinstall the processing engine in Settings, Processing tools."
        )
    link = work_root / hashlib.sha1(str(real).lower().encode("utf-8")).hexdigest()[:16]
    if link.exists():
        return link
    work_root.mkdir(parents=True, exist_ok=True)
    real.mkdir(parents=True, exist_ok=True)
    import _winapi  # Windows only: a directory junction needs no administrator rights

    _winapi.CreateJunction(str(real), str(link))
    return link


def run_odm_dir(project: Path, run: str, env: Mapping[str, str] | None = None) -> Path:
    """The run's ODM folder as ODM reaches it (through a junction when its real path is unsafe)."""
    env = os.environ if env is None else env
    work = env.get(WORK_ENV)
    return odm_path(odm_project_dir(project, run), Path(work) if work else None)


def link_images(odm_dir: Path, photos: list[tuple[str, Path]]) -> tuple[dict[str, str], int]:
    """Hard-link (or copy) the photos into ``images/``; returns ``({link name: key}, copies)``."""
    images = odm_dir / "images"
    images.mkdir(parents=True, exist_ok=True)
    names: dict[str, str] = {}
    copies = 0
    for i, (key, path) in enumerate(photos):
        name = f"{i:05d}{path.suffix.lower()}"
        names[name] = key
        dst = images / name
        size = path.stat().st_size
        if dst.exists() and dst.stat().st_size == size:
            continue
        if dst.exists():
            dst.unlink()
        try:
            os.link(path, dst)
        except OSError:
            shutil.copy2(path, dst)
            copies += 1
    atomic_write_json(odm_dir / "names.json", names)
    return names, copies


def read_names(odm_dir: Path) -> dict[str, str]:
    path = odm_dir / "names.json"
    if not path.is_file():
        raise JobError("The run's ODM project has no names.json; use Create maps again.")
    return json.loads(path.read_text(encoding="utf-8"))


@dataclass
class GeoRow:
    link: str
    lon: float
    lat: float
    h: float
    yaw: float | None
    pitch: float | None
    roll: float | None
    h_acc: float
    v_acc: float


def write_geo(odm_dir: Path, rows: list[GeoRow]) -> Path | None:
    """``geo.txt``: always 9 columns (C15); ``nan`` for an unknown orientation."""
    if not rows:
        return None

    def a(v: float | None) -> str:
        return "nan" if v is None else f"{v:.3f}"

    lines = ["EPSG:4326"]
    for r in rows:
        lines.append(
            f"{r.link} {r.lon:.8f} {r.lat:.8f} {r.h:.3f} {a(r.yaw)} {a(r.pitch)} {a(r.roll)} "
            f"{r.h_acc:.3f} {r.v_acc:.3f}"
        )
    path = odm_dir / "geo.txt"
    odm_dir.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


@dataclass
class GcpList:
    path: Path
    points: list[str]
    marks: int


def write_gcp_list(
    odm_dir: Path, gcp: dict[str, Any], links_by_key: dict[str, str], exclude: set[str]
) -> GcpList:
    crs = C.crs_of(gcp["crs"])
    epsg = crs.to_epsg()
    lines = [f"EPSG:{epsg}" if epsg else crs.to_proj4()]
    points: list[str] = []
    marks = 0
    for point in gcp.get("points") or []:
        pid = point["id"]
        if point.get("role") != "control" or point.get("disabled") or pid in exclude:
            continue
        usable = [(k, px) for k, px in G.usable_marks(point) if k in links_by_key]
        if len(usable) < 2:
            continue
        x, y, z = (float(v) for v in point["xyz"])
        for key, (px, py) in usable:
            # our marks put the image's top-left corner at 0; ODM puts the first pixel's centre at 0
            lines.append(f"{x:.4f} {y:.4f} {z:.4f} {px - 0.5:.2f} {py - 0.5:.2f} {links_by_key[key]} {pid}")
        points.append(pid)
        marks += len(usable)
    if len(points) < 3:
        raise JobError(NEED_THREE)
    path = odm_dir / "gcp_list.txt"
    odm_dir.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return GcpList(path=path, points=points, marks=marks)


def write_boundary(odm_dir: Path, ring: list[list[float]]) -> Path:
    closed = [list(p) for p in ring]
    if closed and closed[0] != closed[-1]:
        closed.append(list(closed[0]))
    doc = {
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "properties": {}, "geometry": {"type": "Polygon", "coordinates": [closed]}}
        ],
    }
    path = odm_dir / "boundary.geojson"
    odm_dir.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc), encoding="utf-8")
    return path


def _remove(p: Path) -> None:
    if p.is_dir() and not p.is_symlink():
        shutil.rmtree(p)
    elif p.exists() or p.is_symlink():
        p.unlink()


def invalidate(odm_dir: Path, rels: Sequence[str]) -> None:
    for rel in rels:
        _remove(odm_dir / rel)


def _size(p: Path) -> int:
    if p.is_file():
        return p.stat().st_size
    return sum(f.stat().st_size for f in p.rglob("*") if f.is_file())


def clean_intermediates(odm_dir: Path) -> int:
    freed = 0
    for rel in INTERMEDIATES:
        p = odm_dir / rel
        if p.exists():
            freed += _size(p)
            _remove(p)
    return freed


def has_alignment(odm_dir: Path) -> bool:
    return any(
        (odm_dir / "opensfm" / n).is_file()
        for n in ("reconstruction.topocentric.json", "reconstruction.json")
    )
