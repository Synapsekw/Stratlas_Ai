"""geo.calibration: a controller file, 12d parameters or point pairs to a site calibration.

Parameters as ``GeoCalibrationParams`` (``packages/schema/src/jobs.ts``): ``src`` (a file, with an
optional ``format``) or ``pairs``, not both; ``crs`` the base projection; ``verticalDatum?`` and
``geoid?``. The result is a draft ``SiteCalibration`` (``aio.site-calibration/1``) with residuals;
a person applies it with ``geodesy:applyCalibration`` (never this job).

The model (ADR 0010, data-conventions section 25), in the controller's order:

1. WGS84 latitude, longitude and ellipsoidal height to the base projection (``crs``), through PROJ;
   heights to the calibration's geoid when it has one (``H = h - N``);
2. horizontal similarity about an origin: ``local = origin + shift + scale * R(rotation) * (grid -
   origin)``, rotation counter-clockwise positive;
3. vertical: ``dz = shiftM + slopeN * (N' - originN) + slopeE * (E' - originE)`` on the local
   (calibrated) coordinates ``E', N'``.

Sources (decision 8 and the G1 format findings in the M11 plan):

- ``jobxml``: Trimble JobXML (``.jxl``, the published JobXML schema): the coordinate system's
  ``HorizontalAdjustment`` and ``VerticalAdjustment`` (or the last ``...AdjustmentRecord`` in the
  field book), the ``CalibrationPointRecord`` pairs with the controller's own residuals, and the
  ``PointRecord`` positions of both points of each pair. The file's parameters are kept as they are;
  our residuals are computed through PROJ and shown beside the controller's. The rotation sign and
  the coordinates the inclined plane uses are not stated by the schema: every reading is tried and
  the one that reproduces the controller's residuals is kept (``conventions`` in the result).
- ``12d``: the transformation parameters 12d reports, typed into a key and value text file
  (``key = value`` lines, ``#`` comments; keys ``origin_e``, ``origin_n``, ``shift_e``,
  ``shift_n``, ``rotation_deg`` (counter-clockwise), ``scale``, and optionally ``v_origin_e``,
  ``v_origin_n``, ``v_shift``, ``slope_n``, ``slope_e``). 12d publishes no export format for them.
- ``pairs``: **Compute from point pairs** (any vendor): least squares of the same model.
- ``dc`` and ``cal``: refused. No public specification was found (M11 plan, G1 format findings).

Hostile files: at most 50 MB, no DTD entity declarations, unknown elements ignored.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import shutil
import uuid
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

import numpy as np

from ..runtime import JobError, Step, StepContext, atomic_write_json, now_iso
from ..stub import NotBuiltYet, exactly_one

MAX_FILE_BYTES = 50 * 1024 * 1024
CALIBRATION_FILE = "survey/calibration.json"
CALIBRATION_DIR = "survey/calibration"

FORMATS_BY_SUFFIX = {".jxl": "jobxml", ".xml": "jobxml", ".dc": "dc", ".cal": "cal", ".txt": "12d"}


# ------------------------------------------------------------------------------------------ model


def _rot(theta: float) -> np.ndarray:
    c, s = math.cos(theta), math.sin(theta)
    return np.array([[c, -s], [s, c]])


def apply_horizontal(h: dict[str, Any] | None, e, n) -> tuple[np.ndarray, np.ndarray]:
    """Base projection E, N to local E', N' (the model's step 2), in numpy for solving."""
    e = np.asarray(e, dtype=np.float64)
    n = np.asarray(n, dtype=np.float64)
    if not h:
        return e.copy(), n.copy()
    d = np.vstack([e - h["originE"], n - h["originN"]])
    out = h["scale"] * (_rot(h["rotationRad"]) @ d)
    return out[0] + h["originE"] + h["shiftE"], out[1] + h["originN"] + h["shiftN"]


def plane_dz(v: dict[str, Any] | None, le, ln) -> np.ndarray:
    le = np.asarray(le, dtype=np.float64)
    if not v:
        return np.zeros_like(le)
    return v["shiftM"] + v["slopeN"] * (np.asarray(ln) - v["originN"]) + v["slopeE"] * (le - v["originE"])


def solve_horizontal(grid_e, grid_n, local_e, local_n) -> dict[str, Any]:
    """Least-squares Helmert 2D about the centroid of the grid points (1 pair: a shift only)."""
    ge, gn = np.asarray(grid_e, float), np.asarray(grid_n, float)
    le, ln = np.asarray(local_e, float), np.asarray(local_n, float)
    oe, on = float(ge.mean()), float(gn.mean())
    if len(ge) == 1:
        return {
            "originE": oe,
            "originN": on,
            "shiftE": float(le[0] - oe),
            "shiftN": float(ln[0] - on),
            "rotationRad": 0.0,
            "scale": 1.0,
        }
    de, dn = ge - oe, gn - on
    # local_e = ce + a*de - b*dn ; local_n = cn + b*de + a*dn
    rows = len(ge)
    m = np.zeros((2 * rows, 4))
    m[:rows, 0], m[:rows, 2], m[:rows, 3] = 1, de, -dn
    m[rows:, 1], m[rows:, 2], m[rows:, 3] = 1, dn, de
    rhs = np.concatenate([le, ln])
    (ce, cn, a, b), *_ = np.linalg.lstsq(m, rhs, rcond=None)
    return {
        "originE": oe,
        "originN": on,
        "shiftE": float(ce - oe),
        "shiftN": float(cn - on),
        "rotationRad": float(math.atan2(b, a)),
        "scale": float(math.hypot(a, b)),
    }


def solve_vertical(local_e, local_n, dz) -> dict[str, Any]:
    """Least-squares inclined plane about the centroid (fewer than 3 points: a constant shift)."""
    le, ln, d = (np.asarray(x, float) for x in (local_e, local_n, dz))
    oe, on = float(le.mean()), float(ln.mean())
    if len(d) < 3:
        return {"originE": oe, "originN": on, "shiftM": float(d.mean()), "slopeN": 0.0, "slopeE": 0.0}
    m = np.column_stack([np.ones_like(d), ln - on, le - oe])
    (c, sn, se), *_ = np.linalg.lstsq(m, d, rcond=None)
    return {"originE": oe, "originN": on, "shiftM": float(c), "slopeN": float(sn), "slopeE": float(se)}


# ------------------------------------------------------------------------------------------ PROJ side


def _geoid_n(geoid: str | None, lon, lat, geoid_dirs=None) -> np.ndarray:
    lon = np.asarray(lon, float)
    if not geoid:
        return np.zeros_like(lon)
    from .site import geoid_file, undulation

    n = undulation(geoid_file(geoid, geoid_dirs), lon, lat)
    if np.isnan(n).any():
        raise JobError(f"A calibration point is outside the {geoid} geoid grid.")
    return n


def to_base(pairs: list[dict[str, Any]], crs: Any, geoid: str | None, geoid_dirs=None) -> np.ndarray:
    """Each pair's global position in the base projection: rows of (E, N, height), metres."""
    from pyproj import CRS, Transformer

    from .site import crs_of, metres_per_unit, network_off

    network_off()
    base = crs_of(crs)
    scale = metres_per_unit(base)
    out = np.full((len(pairs), 3), np.nan)
    wgs = [i for i, p in enumerate(pairs) if p.get("wgs84") is not None]
    if wgs:
        geog = CRS.from_epsg(4979)
        t = Transformer.from_crs(geog, base, always_xy=True)
        lat = np.array([pairs[i]["wgs84"][0] for i in wgs], float)
        lon = np.array([pairs[i]["wgs84"][1] for i in wgs], float)
        h = np.array([pairs[i]["wgs84"][2] for i in wgs], float)
        x, y = t.transform(lon, lat, errcheck=True)
        out[wgs, 0] = np.asarray(x) * scale
        out[wgs, 1] = np.asarray(y) * scale
        out[wgs, 2] = h - _geoid_n(geoid, lon, lat, geoid_dirs)
    for i, p in enumerate(pairs):
        if p.get("wgs84") is None:
            g = p.get("grid")
            if g is None:
                raise JobError(f"Pair {p.get('name', i + 1)} needs a WGS84 or grid position.")
            out[i] = (float(g[1]), float(g[0]), float(g[2]))  # grid is (N, E, Z)
    return out


def proj_local(cal: dict[str, Any], base_xyz: np.ndarray) -> np.ndarray:
    """Base projection (E, N, height) to local (E', N', Z') through the PROJ affine pipeline."""
    from pyproj import Transformer

    from .site import calibration_pipeline

    pipe = calibration_pipeline(cal)
    if pipe is None:
        return base_xyz.copy()
    x, y, z = Transformer.from_pipeline(pipe).transform(base_xyz[:, 0], base_xyz[:, 1], base_xyz[:, 2])
    return np.column_stack([x, y, z])


def residuals(cal: dict[str, Any], pairs: list[dict[str, Any]], base: np.ndarray) -> dict[str, Any]:
    """Set each pair's ``residualH`` (>= 0) and ``residualV`` (local minus computed), and the RMS."""
    pred = proj_local(cal, base)
    sq_h: list[float] = []
    sq_v: list[float] = []
    for p, (pe, pn, pz) in zip(pairs, pred, strict=True):
        ln, le, lz = (float(v) for v in p["local"])
        rh = math.hypot(le - pe, ln - pn)
        rv = lz - pz
        p["residualH"] = round(rh, 6)
        p["residualV"] = round(rv, 6)
        if p.get("useH", True):
            sq_h.append(rh * rh)
        if p.get("useV", True):
            sq_v.append(rv * rv)
    out: dict[str, Any] = {}
    if sq_h:
        out["rmsH"] = round(math.sqrt(sum(sq_h) / len(sq_h)), 6)
    if sq_v:
        out["rmsV"] = round(math.sqrt(sum(sq_v) / len(sq_v)), 6)
    return out


def solve_pairs(
    pairs: list[dict[str, Any]], crs: Any, geoid: str | None = None, geoid_dirs=None
) -> dict[str, Any]:
    """**Compute from point pairs**: the model's parameters by least squares, with residuals."""
    pairs = [_pair(p, i) for i, p in enumerate(pairs)]
    base = to_base(pairs, crs, geoid, geoid_dirs)
    use_h = [i for i, p in enumerate(pairs) if p["useH"]]
    use_v = [i for i, p in enumerate(pairs) if p["useV"]]
    if not use_h and not use_v:
        raise JobError("No pair is used for the horizontal or the vertical adjustment.")
    cal: dict[str, Any] = {}
    if use_h:
        cal["horizontal"] = solve_horizontal(
            base[use_h, 0],
            base[use_h, 1],
            [pairs[i]["local"][1] for i in use_h],
            [pairs[i]["local"][0] for i in use_h],
        )
    le, ln = apply_horizontal(cal.get("horizontal"), base[:, 0], base[:, 1])
    if use_v:
        dz = [pairs[i]["local"][2] - base[i, 2] for i in use_v]
        cal["vertical"] = solve_vertical(le[use_v], ln[use_v], dz)
    cal.update(residuals(cal, pairs, base))
    cal["pairs"] = pairs
    return cal


def _pair(p: dict[str, Any], i: int) -> dict[str, Any]:
    q = dict(p)
    q["name"] = str(q.get("name") or f"P{i + 1}")[:120]
    q["useH"] = bool(q.get("useH", True))
    q["useV"] = bool(q.get("useV", True))
    q["local"] = [float(v) for v in q["local"]]
    return q


# ------------------------------------------------------------------------------------------ JobXML


def _read_limited(path: Path) -> bytes:
    size = path.stat().st_size
    if size > MAX_FILE_BYTES:
        raise JobError(f"{path.name} is {size // (1024 * 1024)} MB; a calibration file is at most 50 MB.")
    return path.read_bytes()


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _child(el: ET.Element | None, name: str) -> ET.Element | None:
    if el is None:
        return None
    for c in el:
        if _local(c.tag) == name:
            return c
    return None


def _text(el: ET.Element | None, name: str) -> str | None:
    c = _child(el, name)
    if c is None or c.text is None:
        return None
    t = c.text.strip()
    return t or None


def _num(el: ET.Element | None, name: str) -> float | None:
    t = _text(el, name)
    if t is None:
        return None
    try:
        v = float(t)
    except ValueError:
        return None
    return v if math.isfinite(v) else None


def _iter(root: ET.Element, name: str):
    for el in root.iter():
        if _local(el.tag) == name:
            yield el


def parse_jobxml(data: bytes) -> ET.Element:
    if re.search(rb"<!ENTITY", data[:65536]) or re.search(rb"<!ENTITY", data):
        raise JobError("The JobXML file declares entities, which are not read (hostile input).")
    try:
        root = ET.fromstring(data)
    except ET.ParseError as e:
        raise JobError(f"The JobXML file could not be read: {e}") from e
    if _local(root.tag) != "JOBFile":
        raise JobError("This is not a Trimble JobXML file (no JOBFile element).")
    return root


def _last(root: ET.Element, env_name: str, record_name: str) -> ET.Element | None:
    """The field book's last record of a kind, else the environment's element."""
    records = list(_iter(root, record_name))
    if records:
        return records[-1]
    env = _child(root, "Environment")
    return _child(_child(env, "CoordinateSystem"), env_name)


def _geoid_id(name: str | None) -> str | None:
    if not name:
        return None
    n = name.strip()
    low = re.sub(r"[^a-z0-9]", "", n.lower())
    if low.startswith("egm2008") or low.startswith("egm08"):
        return "egm2008"
    if low.startswith("egm96"):
        return "egm96"
    safe = re.sub(r"[^A-Za-z0-9._-]", "-", n)[:80].strip("-._") or "geoid"
    return safe


def _base_crs_from_jobxml(root: ET.Element) -> dict[str, Any] | None:
    env = _child(root, "Environment")
    cs = _child(env, "CoordinateSystem")
    epsg = _num(cs, "ProjectedCoordinateReferenceSystemEPSG")
    if epsg and epsg > 0:
        return {"epsg": int(epsg)}
    proj = _child(cs, "Projection")
    kind = (_text(proj, "Type") or "").lower()
    if "transversemercator" in kind.replace(" ", ""):
        ell = _child(cs, "Ellipsoid")
        a = _num(ell, "EarthRadius") or 6378137.0
        f = _num(ell, "Flattening") or 1 / 298.257223563
        lon0 = _num(proj, "CentralMeridian") or 0.0
        lat0 = _num(proj, "OriginLatitude") or 0.0
        k = _num(proj, "Scale") or 1.0
        fe = _num(proj, "FalseEasting") or 0.0
        fn = _num(proj, "FalseNorthing") or 0.0
        from pyproj import CRS

        p4 = (
            f"+proj=tmerc +lat_0={lat0!r} +lon_0={lon0!r} +k={k!r} +x_0={fe!r} +y_0={fn!r} "
            f"+a={a!r} +rf={1 / f!r} +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs"
        )
        return {"wkt": CRS.from_proj4(p4).to_wkt()}
    return None


def jobxml_calibration(data: bytes) -> dict[str, Any]:
    """The calibration parameters, pairs and controller residuals of a JobXML file (as the file has them).

    Answers ``horizontal`` and ``vertical`` (the schema's raw values, rotation in degrees), the
    ``pairs`` with ``wgs84`` and ``local`` positions, the base ``projection`` when the file names
    one, and the ``geoid`` the vertical adjustment sits on.
    """
    root = parse_jobxml(data)
    out: dict[str, Any] = {}
    h = _last(root, "HorizontalAdjustment", "HorizontalAdjustmentRecord")
    if h is not None and (_text(h, "Type") or "PlaneAdjustment") != "NoAdjustment":
        vals = {
            k: _num(h, k)
            for k in (
                "OriginNorth",
                "OriginEast",
                "TranslationNorth",
                "TranslationEast",
                "Rotation",
                "ScaleFactor",
            )
        }
        if all(v is not None for v in vals.values()):
            out["horizontalRaw"] = vals
    v = _last(root, "VerticalAdjustment", "VerticalAdjustmentRecord")
    if v is not None:
        vtype = _text(v, "Type") or "InclinedPlane"
        if "Geoid" in vtype:
            out["geoid"] = _geoid_id(_text(v, "GeoidName"))
        if "InclinedPlane" in vtype:
            vals = {
                k: _num(v, k)
                for k in (
                    "OriginNorth",
                    "OriginEast",
                    "SlopeNorthPerUnit",
                    "SlopeEastPerUnit",
                    "ConstantAdjustment",
                )
            }
            if all(x is not None for x in vals.values()):
                out["verticalRaw"] = vals
    base = _base_crs_from_jobxml(root)
    if base:
        out["projection"] = base
    points: dict[str, dict[str, Any]] = {}
    for pr in _iter(root, "PointRecord"):
        if (_text(pr, "Deleted") or "false").lower() == "true":
            continue
        name = _text(pr, "Name")
        if not name:
            continue
        rec = points.setdefault(name, {})
        g = _child(pr, "Grid")
        if g is not None and _num(g, "North") is not None and _num(g, "East") is not None:
            rec["grid"] = [_num(g, "North"), _num(g, "East"), _num(g, "Elevation") or 0.0]
        w = _child(pr, "WGS84")
        if w is not None and _num(w, "Latitude") is not None and _num(w, "Longitude") is not None:
            rec["wgs84"] = [_num(w, "Latitude"), _num(w, "Longitude"), _num(w, "Height") or 0.0]
    pairs: dict[str, dict[str, Any]] = {}
    records = list(_iter(root, "CalibrationPointRecord"))
    if not records:
        env = _child(root, "Environment")
        cpp = _child(_child(env, "CoordinateSystem"), "CalibrationPointPairs")
        records = [c for c in (cpp if cpp is not None else []) if _local(c.tag) == "CalibrationPointPair"]
    for r in records:
        gname, wname = _text(r, "GridPointName"), _text(r, "WGS84PointName")
        if not gname or not wname:
            continue
        local = points.get(gname, {}).get("grid")
        wgs = points.get(wname, {}).get("wgs84")
        if local is None or wgs is None:
            raise JobError(
                f"Calibration pair {gname}: the file has no grid position for {gname} or no WGS84 position for {wname}."
            )
        dim = (_text(r, "Dimension") or "3D").upper()
        pair: dict[str, Any] = {
            "name": gname[:120],
            "local": [float(x) for x in local],
            "wgs84": [float(x) for x in wgs],
            "useH": dim in ("2D", "3D"),
            "useV": dim in ("1D", "3D"),
        }
        rh, rv = _num(r, "HorizontalResidual"), _num(r, "VerticalResidual")
        if rh is not None:
            pair["controllerResidualH"] = abs(rh)
        if rv is not None:
            pair["controllerResidualV"] = rv
        pairs[gname] = pair  # the last record of a point wins
    out["pairs"] = list(pairs.values())
    if "horizontalRaw" not in out and "verticalRaw" not in out:
        raise JobError("The JobXML file has no site calibration (no horizontal or vertical adjustment).")
    return out


def _from_raw(raw: dict[str, Any], rot_sign: float, plane: str) -> dict[str, Any]:
    cal: dict[str, Any] = {}
    hr = raw.get("horizontalRaw")
    if hr:
        cal["horizontal"] = {
            "originE": hr["OriginEast"],
            "originN": hr["OriginNorth"],
            "shiftE": hr["TranslationEast"],
            "shiftN": hr["TranslationNorth"],
            "rotationRad": rot_sign * math.radians(hr["Rotation"]),
            "scale": hr["ScaleFactor"],
        }
    vr = raw.get("verticalRaw")
    if vr:
        v = {
            "originE": vr["OriginEast"],
            "originN": vr["OriginNorth"],
            "shiftM": vr["ConstantAdjustment"],
            "slopeN": vr["SlopeNorthPerUnit"],
            "slopeE": vr["SlopeEastPerUnit"],
        }
        if plane == "grid" and cal.get("horizontal"):
            v = _plane_grid_to_local(v, cal["horizontal"])
        cal["vertical"] = v
    return cal


def _plane_grid_to_local(v: dict[str, Any], h: dict[str, Any]) -> dict[str, Any]:
    """The same plane, given on base projection coordinates, about the same origin in local ones."""
    ge = np.array([v["originE"], v["originE"] + 1000.0, v["originE"]])
    gn = np.array([v["originN"], v["originN"], v["originN"] + 1000.0])
    dz = plane_dz(v, ge, gn)
    le, ln = apply_horizontal(h, ge, gn)
    return solve_vertical(le, ln, dz) | {
        "originE": float(le[0]),
        "originN": float(ln[0]),
        "shiftM": float(dz[0]),
    }


def import_jobxml(data: bytes, crs: Any, geoid_dirs=None) -> dict[str, Any]:
    raw = jobxml_calibration(data)
    projection = raw.get("projection") or crs
    geoid = raw.get("geoid")
    pairs = [_pair(p, i) for i, p in enumerate(raw["pairs"])]
    base = to_base(pairs, projection, geoid, geoid_dirs) if pairs else np.zeros((0, 3))
    best: tuple[float, dict[str, Any], dict[str, Any]] | None = None
    readings = [(s, pl) for s in (1.0, -1.0) for pl in ("local", "grid")]
    for sign, plane in readings:
        cal = _from_raw(raw, sign, plane)
        if not pairs:
            best = (0.0, cal, {"rotation": "ccw", "plane": "local"})
            break
        trial = [dict(p) for p in pairs]
        stats = residuals(cal, trial, base)
        score = 0.0
        for p in trial:
            if "controllerResidualH" in p:
                score += (p["residualH"] - p["controllerResidualH"]) ** 2
            if "controllerResidualV" in p:
                score += (p["residualV"] - p["controllerResidualV"]) ** 2
        if not any("controllerResidualH" in p or "controllerResidualV" in p for p in trial):
            score = stats.get("rmsH", 0.0) ** 2 + stats.get("rmsV", 0.0) ** 2
        conv = {"rotation": "ccw" if sign > 0 else "cw", "plane": plane}
        if best is None or score < best[0] - 1e-12:
            best = (score, cal | stats | {"pairs": trial}, conv)
    assert best is not None
    cal = best[1]
    cal["conventions"] = best[2]
    cal["projection"] = projection
    if geoid:
        cal["geoid"] = geoid
    cal.setdefault("pairs", pairs)
    return cal


# ------------------------------------------------------------------------------------------ 12d


TWELVE_D_KEYS = {
    "origin_e": ("h", "originE"),
    "origin_n": ("h", "originN"),
    "shift_e": ("h", "shiftE"),
    "shift_n": ("h", "shiftN"),
    "rotation_deg": ("h", "rotationDeg"),
    "scale": ("h", "scale"),
    "v_origin_e": ("v", "originE"),
    "v_origin_n": ("v", "originN"),
    "v_shift": ("v", "shiftM"),
    "slope_n": ("v", "slopeN"),
    "slope_e": ("v", "slopeE"),
}


def import_12d(text: str) -> dict[str, Any]:
    """12d transformation parameters typed as ``key = value`` lines (see the module docstring)."""
    h: dict[str, float] = {}
    v: dict[str, float] = {}
    for i, line in enumerate(text.splitlines(), 1):
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        if "=" not in line:
            raise JobError(f"Line {i} is not key = value.")
        key, _, value = (s.strip() for s in line.partition("="))
        spec = TWELVE_D_KEYS.get(key.lower())
        if spec is None:
            raise JobError(f'Line {i}: "{key}" is not a 12d transformation parameter.')
        try:
            num = float(value)
        except ValueError as e:
            raise JobError(f'Line {i}: "{value}" is not a number.') from e
        (h if spec[0] == "h" else v)[spec[1]] = num
    cal: dict[str, Any] = {}
    if h:
        need = {"originE", "originN", "shiftE", "shiftN", "rotationDeg", "scale"}
        if not need <= set(h):
            raise JobError(f"The horizontal transformation needs: {', '.join(sorted(need - set(h)))}.")
        cal["horizontal"] = {
            "originE": h["originE"],
            "originN": h["originN"],
            "shiftE": h["shiftE"],
            "shiftN": h["shiftN"],
            "rotationRad": math.radians(h["rotationDeg"]),
            "scale": h["scale"],
        }
    if v:
        cal["vertical"] = {
            "originE": v.get("originE", 0.0),
            "originN": v.get("originN", 0.0),
            "shiftM": v.get("shiftM", 0.0),
            "slopeN": v.get("slopeN", 0.0),
            "slopeE": v.get("slopeE", 0.0),
        }
    if not cal:
        raise JobError("The 12d parameters file has no transformation parameters.")
    cal["pairs"] = []
    return cal


# ------------------------------------------------------------------------------------------ pipeline


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def compute_calibration(
    params: dict[str, Any], project: Path | None = None, geoid_dirs=None
) -> dict[str, Any]:
    """The draft ``SiteCalibration`` for the job's parameters (no file is written here)."""
    crs = params["crs"]
    geoid = params.get("geoid")
    source: dict[str, Any]
    if params.get("pairs") is not None:
        body = solve_pairs(params["pairs"], crs, geoid, geoid_dirs)
        body["projection"] = crs
        if geoid:
            body["geoid"] = geoid
        source = {"format": "pairs"}
        name = "Computed from point pairs"
    else:
        src = Path(params["src"])
        if not src.is_file():
            raise JobError(f'The calibration file "{src}" does not exist.')
        fmt = params.get("format") or FORMATS_BY_SUFFIX.get(src.suffix.lower())
        if fmt is None:
            raise JobError(f"{src.name}: give the format (JobXML, or 12d parameters).")
        if fmt in ("dc", "cal"):
            raise JobError(
                f"Trimble .{fmt} files have no public specification, so they are not read. Export the job "
                "from the controller as JobXML (.jxl), or compute the calibration from point pairs."
            )
        data = _read_limited(src)
        if fmt == "jobxml":
            body = import_jobxml(data, crs, geoid_dirs)
        elif fmt == "12d":
            body = import_12d(data.decode("utf-8-sig", errors="strict"))
            body["projection"] = crs
            if geoid:
                body["geoid"] = geoid
        else:
            raise JobError(f"The {fmt} format is not read.")
        source = {"format": fmt, "sha256": _sha256(data), "name": src.name}
        name = src.stem[:200] or "Site calibration"
    cal_id = f"cal-{uuid.uuid4().hex[:12]}"
    out = {
        "schema": "aio.site-calibration/1",
        "id": cal_id,
        "name": name,
        "source": source,
        **body,
        "computedAt": now_iso(),
    }
    if len(out["pairs"]) > 500:
        raise JobError("A calibration has at most 500 point pairs.")
    return json.loads(json.dumps(out))


class GeoCalibration(NotBuiltYet):
    name = "geo.calibration"
    title = "Site calibration"
    description = (
        "A Trimble JobXML or .dc, a 12d transform or point pairs to a site calibration with residuals."
    )
    keys = frozenset({"src", "format", "pairs", "crs", "verticalDatum", "geoid"})
    required = frozenset({"crs"})
    choices = {  # noqa: RUF012 - read only, as the base class declares
        "format": frozenset({"jobxml", "dc", "12d", "cal", "pairs"}),
    }

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        out = super().validate(params)
        exactly_one(
            params.get("src") is not None,
            params.get("pairs") is not None,
            "Give a file or point pairs, not both.",
        )
        return out

    def plan(self, params: dict[str, Any]) -> list[Step]:
        def compute(ctx: StepContext) -> dict[str, Any]:
            ctx.progress(0.1, "Reading the calibration")
            cal = compute_calibration(ctx.params, ctx.project)
            atomic_write_json(ctx.stage("calibration.json"), cal, indent=2)
            return {"calibration": cal["id"]}

        def commit(ctx: StepContext) -> dict[str, Any]:
            cal = json.loads(ctx.stage("calibration.json").read_text(encoding="utf-8"))
            keep_dir = ctx.out(f"{CALIBRATION_DIR}/{cal['id']}")
            keep_dir.mkdir(parents=True, exist_ok=True)
            src = ctx.params.get("src")
            if src:
                name = re.sub(r"[^A-Za-z0-9._-]", "_", Path(src).name)[:100] or "source"
                shutil.copyfile(src, keep_dir / name)
                cal["source"]["file"] = f"{CALIBRATION_DIR}/{cal['id']}/{name}"
                cal["source"].pop("name", None)
            else:
                cal["source"].pop("name", None)
            # the draft is always kept beside its source; survey/calibration.json only when no
            # calibration is applied, so an import never changes a reported number
            atomic_write_json(keep_dir / "calibration.json", cal, indent=2)
            current = ctx.out(CALIBRATION_FILE)
            applied = False
            if current.is_file():
                try:
                    applied = bool(json.loads(current.read_text(encoding="utf-8")).get("appliedAt"))
                except (ValueError, OSError):
                    applied = False
            if not applied:
                atomic_write_json(current, cal, indent=2)
                ctx.artifact(CALIBRATION_FILE)
            ctx.artifact(f"{CALIBRATION_DIR}/{cal['id']}/calibration.json")
            return {
                "calibration": cal,
                "draft": f"{CALIBRATION_DIR}/{cal['id']}/calibration.json",
                "replacedCurrent": not applied,
            }

        return [
            Step("compute", "Compute the calibration and its residuals", compute, weight=3),
            Step("commit", "Keep the draft calibration", commit),
        ]
