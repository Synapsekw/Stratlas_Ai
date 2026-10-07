"""Ground control: ``gcp.json`` (``aio.gcp/1``), GCP text files, mark prediction and outliers.

- ``read_gcp_file`` checks a run's ``gcp.json`` the way ``@aio/schema`` ``GcpFile`` does.
- ``parse_gcp_text`` reads the files people bring: CSV or TXT ``id, x, y, z`` (or ``id, lat, lon,
  h`` with EPSG 4326), with an optional role column (``control``/``check``) and accuracy columns,
  and ODM's ``gcp_list.txt`` (a CRS line, then ``x y z px py image [id]`` per mark).
- ``predict_marks`` projects every point into every aligned photo that sees it, with a search
  radius from the cameras' uncertainty: the drafts G4 shows a person (``predicted``).
- ``control_outliers`` names a control point whose surveyed position disagrees with the others
  (leave-one-out similarity of the marked positions); it is left out of the adjustment and the
  report says so. Nothing is hidden: its residual is still listed.

Mark pixels are in original image pixels with the top-left corner of the image at (0, 0) (x
right, y down), the same convention as the sparse model (``photo/model.py``).
"""

from __future__ import annotations

import csv
import io
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from ..runtime import JobError
from . import crs as C
from .bundle import similarity
from .model import SparseModel, project_points

GCP_SCHEMA = "aio.gcp/1"
#: Default stated accuracy of an imported point without one (one sigma, metres).
DEFAULT_ACCURACY = {"horizontalM": 0.02, "verticalM": 0.03}
MIN_MARKS = 3


def read_gcp_file(path: Path) -> dict[str, Any]:
    """A run's ``gcp.json``, checked (unknown keys are kept, as ``looseObject`` does)."""
    try:
        data = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError) as e:
        raise JobError(f"The ground control file {path.name} cannot be read: {e}") from e
    if not isinstance(data, dict) or data.get("schema") != GCP_SCHEMA:
        raise JobError(f"{path.name} is not a ground control file ({GCP_SCHEMA}).")
    C.crs_of(data.get("crs"))
    seen: set[str] = set()
    for p in data.get("points") or []:
        pid = p.get("id")
        if not isinstance(pid, str) or not pid:
            raise JobError("A ground control point has no id.")
        if pid in seen:
            raise JobError(f'Duplicate point "{pid}".')
        seen.add(pid)
        if p.get("role") not in ("control", "check"):
            raise JobError(f'Point "{pid}" must be a control or a check point.')
        xyz = p.get("xyz")
        if not (isinstance(xyz, list) and len(xyz) == 3 and all(isinstance(v, int | float) for v in xyz)):
            raise JobError(f'Point "{pid}" needs three coordinates.')
        acc = p.get("accuracy") or {}
        if not (acc.get("horizontalM", 0) > 0 and acc.get("verticalM", 0) > 0):
            raise JobError(f'Point "{pid}" needs a stated accuracy.')
        for m in p.get("marks") or []:
            px = m.get("px")
            if not (isinstance(px, list) and len(px) == 2) or m.get("state") not in (
                "draft",
                "confirmed",
                "skipped",
            ):
                raise JobError(f'A mark of point "{pid}" is not valid.')
    return data


def usable_marks(point: dict[str, Any]) -> list[tuple[str, tuple[float, float]]]:
    """Confirmed marks only: a draft (detector or prediction) is not a measurement yet."""
    return [
        (m["photo"], (float(m["px"][0]), float(m["px"][1])))
        for m in point.get("marks") or []
        if m.get("state") == "confirmed"
    ]


# ------------------------------------------------------------------------------- text files

_ROLE = {
    "control": "control",
    "gcp": "control",
    "c": "control",
    "check": "check",
    "chk": "check",
    "cp": "check",
}


def _num(v: str) -> float | None:
    try:
        return float(v)
    except ValueError:
        return None


def _crs_line(line: str):
    s = line.strip()
    m = re.match(r"^EPSG:(\d+)$", s, re.I)
    if m:
        return C.crs_of(int(m.group(1)))
    m = re.match(r"^WGS84 UTM (\d{1,2})([NS])$", s, re.I)
    if m:
        z = int(m.group(1))
        return C.crs_of((32600 if m.group(2).upper() == "N" else 32700) + z)
    if s.startswith("+proj"):
        return C.crs_of(s)
    return None


def parse_gcp_text(
    text: str, name: str, epsg: int | None = None, now: str = "1970-01-01T00:00:00Z"
) -> dict[str, Any]:
    """A GCP text file as an ``aio.gcp/1`` record (no marks, unless it is ODM's ``gcp_list.txt``)."""
    lines = [ln for ln in text.splitlines() if ln.strip() and not ln.lstrip().startswith("#")]
    if not lines:
        raise JobError(f"{name} has no points.")
    odm_crs = _crs_line(lines[0])
    if odm_crs is not None:
        return _parse_odm(lines[1:], odm_crs, name, now)
    if epsg is None:
        raise JobError(f"Choose the coordinate system of {name} (an EPSG code).")
    crs = C.crs_of(epsg)
    dialect = csv.Sniffer().sniff(lines[0], delimiters=",;\t ")
    rows = list(csv.reader(io.StringIO("\n".join(lines)), dialect))
    header = [c.strip().lower() for c in rows[0]]
    has_header = _num(rows[0][1].strip()) is None if len(rows[0]) > 1 else True
    body = rows[1:] if has_header else rows
    geographic = crs.to_epsg() == 4326
    points: list[dict[str, Any]] = []
    for k, row in enumerate(body):
        row = [c.strip() for c in row if c.strip() != ""]
        if len(row) < 4:
            raise JobError(f"Line {k + 1 + int(has_header)} of {name} needs an id and three coordinates.")
        pid = row[0]
        vals = [_num(v) for v in row[1:4]]
        if any(v is None for v in vals):
            raise JobError(f"Line {k + 1 + int(has_header)} of {name} has a coordinate that is not a number.")
        a, b, c = vals  # type: ignore[misc]
        xyz = [b, a, c] if geographic else [a, b, c]  # lat, lon in the file; lon first here
        role = "control"
        acc = dict(DEFAULT_ACCURACY)
        numbers = []
        for i, v in enumerate(row[4:]):
            key = header[4 + i] if has_header and 4 + i < len(header) else ""
            if v.lower() in _ROLE:
                role = _ROLE[v.lower()]
            elif _num(v) is not None:
                numbers.append((key, float(v)))
        for i, (key, v) in enumerate(numbers):  # accuracy columns: horizontal then vertical
            vertical = any(t in key for t in ("vert", "sv", "acc_v", "accv", "z")) if key else i == 1
            acc["verticalM" if vertical else "horizontalM"] = v
        if acc["horizontalM"] <= 0 or acc["verticalM"] <= 0:
            raise JobError(f'Point "{pid}" in {name} has an accuracy that is not positive.')
        points.append({"id": pid, "role": role, "xyz": xyz, "accuracy": acc, "marks": []})
    _no_duplicates(points, name)
    return {"schema": GCP_SCHEMA, "crs": C.crs_record(crs), "importedFrom": Path(name).name, "points": points}


def _parse_odm(lines: list[str], crs, name: str, now: str) -> dict[str, Any]:
    by_id: dict[str, dict[str, Any]] = {}
    for k, line in enumerate(lines):
        p = line.split()
        if len(p) < 6:
            raise JobError(f"Line {k + 2} of {name} needs x y z px py image.")
        nums = [_num(v) for v in p[:5]]
        if any(v is None for v in nums):
            raise JobError(f"Line {k + 2} of {name} has a value that is not a number.")
        x, y, z, px, py = nums  # type: ignore[misc]
        pid = p[6] if len(p) > 6 else f"{x:.3f}_{y:.3f}"
        pt = by_id.setdefault(
            pid,
            {"id": pid, "role": "control", "xyz": [x, y, z], "accuracy": dict(DEFAULT_ACCURACY), "marks": []},
        )
        if max(abs(pt["xyz"][0] - x), abs(pt["xyz"][1] - y), abs(pt["xyz"][2] - z)) > 1e-6:
            raise JobError(f'Point "{pid}" has two different positions in {name}.')
        pt["marks"].append({"photo": p[5], "px": [px, py], "by": "import", "at": now, "state": "confirmed"})
    points = list(by_id.values())
    _no_duplicates(points, name)
    return {"schema": GCP_SCHEMA, "crs": C.crs_record(crs), "importedFrom": Path(name).name, "points": points}


def _no_duplicates(points: list[dict[str, Any]], name: str) -> None:
    seen: set[str] = set()
    for p in points:
        if p["id"] in seen:
            raise JobError(f'{name} lists point "{p["id"]}" twice.')
        seen.add(p["id"])


# ------------------------------------------------------------------------------- frames


def points_to_geodetic(gcp: dict[str, Any]) -> dict[str, tuple[float, float, float]]:
    """Every point as longitude, latitude and its height (the file's height system)."""
    crs = C.crs_of(gcp["crs"])
    pts = gcp.get("points") or []
    if not pts:
        return {}
    xyz = np.array([p["xyz"] for p in pts], dtype=np.float64)
    if crs.to_epsg() == 4326 or crs.is_geographic:
        lon, lat = (
            (xyz[:, 0], xyz[:, 1]) if crs.to_epsg() == 4326 else C.crs_to_geodetic(crs, xyz[:, 0], xyz[:, 1])
        )
    else:
        lon, lat = C.crs_to_geodetic(crs, xyz[:, 0], xyz[:, 1])
    return {p["id"]: (float(lon[i]), float(lat[i]), float(xyz[i, 2])) for i, p in enumerate(pts)}


# ------------------------------------------------------------------------------- prediction


def predict_marks(
    model: SparseModel,
    points_enu: dict[str, np.ndarray],
    sigma_m: float,
    names: dict[int, str] | None = None,
    margin_px: float = 0.0,
) -> dict[str, list[dict[str, Any]]]:
    """Where each point should appear in each aligned photo: ``{ id: [{photo, px, radiusPx}] }``."""
    out: dict[str, list[dict[str, Any]]] = {}
    for pid, X in points_enu.items():
        preds = []
        for im in model.images.values():
            cam = model.cameras[im.camera_id]
            uv, z = project_points(cam, im.R, im.centre, X[None])
            x, y = uv[0]
            if z[0] <= 0 or not (
                -margin_px <= x < cam.width + margin_px and -margin_px <= y < cam.height + margin_px
            ):
                continue
            radius = cam.focal * sigma_m / max(float(z[0]), 1e-3) * 3 + 8
            preds.append(
                {
                    "photo": names.get(im.id, im.name) if names else im.name,
                    "px": [round(float(x), 2), round(float(y), 2)],
                    "radiusPx": round(min(radius, max(cam.width, cam.height)), 1),
                }
            )
        out[pid] = preds
    return out


# ------------------------------------------------------------------------------- outliers


@dataclass
class Outlier:
    id: str
    distance_m: float


def control_outliers(
    measured: dict[str, np.ndarray],
    surveyed: dict[str, np.ndarray],
    sigma: dict[str, tuple[float, float]],
    floor_m: float = 0.10,
) -> list[Outlier]:
    """Control points that disagree with the others (leave-one-out similarity, metric frame).

    ``measured`` is where the marks put each point through the current cameras, ``surveyed`` its
    stated position. A point is an outlier when the similarity fitted to the *other* points puts
    it further from its survey than ``max(floor_m, 5 sigma, 3 x the median of the others)``.
    One point at a time, the worst first, while at least three points remain.
    """
    ids = [i for i in measured if i in surveyed]
    out: list[Outlier] = []
    while len(ids) >= 4:
        worst: tuple[str, float, float] | None = None
        dists = {}
        for i in ids:
            others = [j for j in ids if j != i]
            sim = similarity(np.array([measured[j] for j in others]), np.array([surveyed[j] for j in others]))
            s, r, t = sim
            d = float(np.linalg.norm(s * r @ measured[i] + t - surveyed[i]))
            dists[i] = d
        for i in ids:
            rest = [dists[j] for j in ids if j != i]
            limit = max(floor_m, 5 * max(sigma.get(i, (0.02, 0.03))), 3 * float(np.median(rest)))
            if dists[i] > limit and (worst is None or dists[i] / limit > worst[2]):
                worst = (i, dists[i], dists[i] / limit)
        if worst is None:
            break
        out.append(Outlier(worst[0], worst[1]))
        ids.remove(worst[0])
    return out
