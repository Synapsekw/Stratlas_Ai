"""The files walk.process writes: raw path, orientation records, run record (data-conventions 32).

The TypeScript schemas are the contract (``packages/schema/src/walks.ts`` ``WalkRawPath`` and
``WalkOrientation``, ``walkProcess.ts`` ``WalkProcessFile``); the ``check_*`` functions below are a
Python copy of their field sets and types, run on every document before it is written.

Conventions:

- **Our camera frame** ``C``: x right, y down, z forward (the trailer, ``motion``, SfM/COLMAP).
- **three.js camera axes** ``T``: x right, y up, looking down -z. The same camera, so
  ``v_C = D v_T`` with ``D = diag(1, -1, -1)``, and a camera-to-frame rotation becomes
  ``R_T = R_C @ D``. ``q`` in ``raw-path.json`` and the orientation records are ``R_T`` as
  quaternions in **x y z w** order; ``pos`` is a point and is not touched.
- **Raw frame**: segment 0's SfM frame when the path came from SfM; the gravity frame of
  ``motion.orientation`` (z up, yaw 0 at the first sample) when the path is pins-only.
- **Orientation records** carry the motion-data orientation (gravity frame) taken into the raw
  frame by ``gravity_to_raw``: the rotation that best agrees with the registered stills of segment
  0 (the mean of ``R_sfm_C @ R_grav_C^T`` projected onto a rotation), so the records and the
  stills' ``q`` agree at the stills.
"""

from __future__ import annotations

import math
import re
from pathlib import Path
from typing import Any

import numpy as np

from ..runtime import atomic_write_bytes, atomic_write_json
from . import motion

WALK_PATH_SCHEMA = "aio.walkpath/1"
WALK_ORIENT_SCHEMA = "aio.walkorient/1"
WALK_PROCESS_SCHEMA = "aio.walk-process/1"
ORIENT_CONVENTION = "xyzw-camera-threejs"
ORIENT_LAYOUT = "f32le-t-xyzw"
ORIENT_FILE = "orientation.bin"
IMU_COLUMNS = ("t", "ax", "ay", "az", "gx", "gy", "gz")
IMU_RATE_HZ = 200
MAX_WARNINGS = 50
MAX_WARNING_CHARS = 400

D = np.diag([1.0, -1.0, -1.0])  # our camera axes <-> three.js camera axes (its own inverse)


# --- conversions ---------------------------------------------------------------------------------


def to_threejs(r_c: np.ndarray) -> np.ndarray:
    """Camera-to-frame rotations (..., 3, 3) in our camera axes to three.js camera axes."""
    return np.asarray(r_c, dtype=np.float64) @ D


def from_threejs(r_t: np.ndarray) -> np.ndarray:
    """The inverse of :func:`to_threejs`."""
    return np.asarray(r_t, dtype=np.float64) @ D


def quat_xyzw(r: np.ndarray) -> np.ndarray:
    """Rotation matrices (..., 3, 3) to quaternions (..., 4) in x y z w order, w >= 0."""
    q = motion.quat_from_matrix(r)
    return np.concatenate([q[..., 1:], q[..., :1]], axis=-1)


def matrix_from_xyzw(q: np.ndarray) -> np.ndarray:
    q = np.asarray(q, dtype=np.float64)
    return motion.quat_to_matrix(np.concatenate([q[..., 3:], q[..., :3]], axis=-1))


def nearest_rotation(m: np.ndarray) -> np.ndarray:
    """The rotation closest to ``m`` (Frobenius), through the SVD."""
    u, _, vt = np.linalg.svd(np.asarray(m, dtype=np.float64))
    s = np.diag([1.0, 1.0, np.sign(np.linalg.det(u @ vt)) or 1.0])
    return u @ s @ vt


def gravity_to_raw(r_raw_c: list[np.ndarray], r_grav_c: list[np.ndarray]) -> np.ndarray:
    """The rotation taking gravity-frame vectors into the raw frame that best fits pairs of camera
    rotations seen in both (camera to raw, camera to gravity frame)."""
    if not r_raw_c or len(r_raw_c) != len(r_grav_c):
        raise ValueError("gravity_to_raw needs one gravity-frame rotation per still")
    acc = sum(np.asarray(a) @ np.asarray(b).T for a, b in zip(r_raw_c, r_grav_c, strict=True))
    return nearest_rotation(acc)


# --- writers -------------------------------------------------------------------------------------


def _r(x: float, nd: int = 6) -> float:
    return round(float(x), nd)


def raw_path_doc(
    walk: str,
    source: str,
    stills: list[dict[str, Any]],
    *,
    up: tuple[float, float, float] | None = None,
    walking: tuple[float, float] | None = None,
    kept: list[int] | None = None,
) -> dict[str, Any]:
    """``raw-path.json``. Each still: ``n``, ``t``, ``steps`` and, when registered, ``pos`` (raw
    frame), ``R`` (camera to raw frame, OUR camera axes; converted here) and ``segment``."""
    rows = []
    for s in stills:
        row: dict[str, Any] = {"n": int(s["n"]), "t": _r(s["t"])}
        if s.get("pos") is not None and s.get("R") is not None:
            row["pos"] = [_r(v) for v in s["pos"]]
            row["q"] = [_r(v, 8) for v in quat_xyzw(to_threejs(s["R"]))]
            row["segment"] = int(s.get("segment") or 0)
        row["steps"] = _r(s.get("steps", 0.0), 3)
        rows.append(row)
    doc: dict[str, Any] = {"schema": WALK_PATH_SCHEMA, "walk": walk, "source": source}
    if up is not None:
        doc["up"] = [_r(v) for v in up]
    doc["stills"] = rows
    if walking is not None:
        doc["walking"] = {"startT": _r(walking[0]), "endT": _r(walking[1])}
    if kept is not None:
        doc["kept"] = sorted(int(n) for n in kept)
    check_raw_path(doc)
    return doc


def orientation_records(t: np.ndarray, r_raw_c: np.ndarray) -> np.ndarray:
    """(n, 5) float32 rows ``t, qx, qy, qz, qw`` (three.js camera axes) from camera-to-raw-frame
    rotations in our camera axes."""
    q = quat_xyzw(to_threejs(r_raw_c))
    # one hemisphere from record to record, so a reader's slerp never takes the long way
    for i in range(1, len(q)):
        if float(np.dot(q[i], q[i - 1])) < 0:
            q[i] = -q[i]
    return np.hstack([np.asarray(t, dtype=np.float64)[:, None], q]).astype("<f4")


def write_orientation(folder: Path, t: np.ndarray, r_raw_c: np.ndarray, rate_hz: float) -> dict[str, Any]:
    """``orientation.bin`` then its header ``orientation.json`` into ``folder``; the header."""
    rows = orientation_records(t, r_raw_c)
    if len(rows) > 1 and not np.all(np.diff(rows[:, 0]) > 0):
        raise ValueError("orientation records must have strictly increasing times")
    atomic_write_bytes(Path(folder) / ORIENT_FILE, np.ascontiguousarray(rows, dtype="<f4").tobytes())
    header = {
        "schema": WALK_ORIENT_SCHEMA,
        "rateHz": _r(rate_hz),
        "count": len(rows),
        "convention": ORIENT_CONVENTION,
        "frame": "raw",
        "startOffsetS": 0,
        "data": ORIENT_FILE,
        "layout": ORIENT_LAYOUT,
    }
    check_orientation(header)
    atomic_write_json(Path(folder) / "orientation.json", header)
    return header


def read_orientation(folder: Path) -> tuple[dict[str, Any], np.ndarray]:
    """The header and the (count, 5) float32 records (tests and tools)."""
    import json

    header = json.loads((Path(folder) / "orientation.json").read_text("utf-8"))
    data = np.fromfile(Path(folder) / header["data"], dtype="<f4")
    return header, data.reshape(-1, 5)


def clean_warnings(warnings: list[str]) -> list[str]:
    out: list[str] = []
    for w in warnings:
        w = str(w).strip()
        if w and w not in out:
            out.append(w if len(w) <= MAX_WARNING_CHARS else w[: MAX_WARNING_CHARS - 1] + "…")
    return out[:MAX_WARNINGS]


def write_process(path: Path, record: dict[str, Any]) -> None:
    """``process.json``, checked against the field list first."""
    check_process(record)
    atomic_write_json(Path(path), record)


# --- checks (a Python copy of the zod schemas' field sets) -----------------------------------------


class SchemaError(ValueError):
    pass


def _num(v: Any) -> bool:
    return isinstance(v, int | float) and not isinstance(v, bool) and math.isfinite(v)


def _int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _fail(where: str, msg: str) -> None:
    raise SchemaError(f"{where}: {msg}")


def _keys(where: str, obj: Any, required: set[str], optional: set[str] = frozenset()) -> None:
    if not isinstance(obj, dict):
        _fail(where, "not an object")
    missing = required - set(obj)
    extra = set(obj) - required - set(optional)
    if missing:
        _fail(where, f"missing {sorted(missing)}")
    if extra:
        _fail(where, f"unknown {sorted(extra)}")


def _vec(where: str, v: Any, n: int) -> None:
    if not isinstance(v, list) or len(v) != n or not all(_num(x) for x in v):
        _fail(where, f"not a list of {n} numbers")


_PROJECT_PATH = re.compile(r"^[/\\]|^[a-z]:|(^|[/\\])\.\.([/\\]|$)|\\", re.IGNORECASE)
_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$")
_DATA_NAME = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


def check_raw_path(doc: Any) -> None:
    """``WalkRawPath`` (walks.ts)."""
    _keys("raw-path", doc, {"schema", "walk", "source", "stills"}, {"up", "walking", "kept"})
    if doc["schema"] != WALK_PATH_SCHEMA:
        _fail("raw-path.schema", repr(doc["schema"]))
    if not isinstance(doc["walk"], str) or not doc["walk"]:
        _fail("raw-path.walk", "empty")
    if doc["source"] not in ("sfm", "pins-only"):
        _fail("raw-path.source", repr(doc["source"]))
    if "up" in doc:
        _vec("raw-path.up", doc["up"], 3)
    stills = doc["stills"]
    if not isinstance(stills, list) or not 1 <= len(stills) <= 100_000:
        _fail("raw-path.stills", "1 to 100000 stills")
    for i, s in enumerate(stills):
        w = f"raw-path.stills[{i}]"
        _keys(w, s, {"n", "t", "steps"}, {"pos", "q", "segment"})
        if not _int(s["n"]) or s["n"] < 0:
            _fail(w + ".n", "not a whole number >= 0")
        if not _num(s["t"]) or s["t"] < 0:
            _fail(w + ".t", "not a number >= 0")
        if not _num(s["steps"]) or s["steps"] < 0:
            _fail(w + ".steps", "not a number >= 0")
        if "pos" in s:
            _vec(w + ".pos", s["pos"], 3)
        if "q" in s:
            _vec(w + ".q", s["q"], 4)
        if "segment" in s and (not _int(s["segment"]) or s["segment"] < 0):
            _fail(w + ".segment", "not a whole number >= 0")
    if "walking" in doc:
        _keys("raw-path.walking", doc["walking"], {"startT", "endT"})
        if not (_num(doc["walking"]["startT"]) and _num(doc["walking"]["endT"])):
            _fail("raw-path.walking", "not numbers")
    if "kept" in doc and (
        not isinstance(doc["kept"], list) or not all(_int(n) and n >= 0 for n in doc["kept"])
    ):
        _fail("raw-path.kept", "not whole numbers >= 0")


def check_orientation(doc: Any) -> None:
    """``WalkOrientation`` (walks.ts)."""
    _keys(
        "orientation",
        doc,
        {"schema", "rateHz", "count", "convention", "frame", "startOffsetS", "data", "layout"},
    )
    if doc["schema"] != WALK_ORIENT_SCHEMA:
        _fail("orientation.schema", repr(doc["schema"]))
    if not _num(doc["rateHz"]) or not 1 <= doc["rateHz"] <= 2000:
        _fail("orientation.rateHz", "1 to 2000")
    if not _int(doc["count"]) or not 0 <= doc["count"] <= 50_000_000:
        _fail("orientation.count", "0 to 50000000")
    if doc["convention"] != ORIENT_CONVENTION or doc["frame"] != "raw" or doc["layout"] != ORIENT_LAYOUT:
        _fail("orientation", "convention, frame or layout")
    if not _num(doc["startOffsetS"]):
        _fail("orientation.startOffsetS", "not a number")
    if not isinstance(doc["data"], str) or not _DATA_NAME.match(doc["data"]) or doc["data"] in (".", ".."):
        _fail("orientation.data", "not a file name")


def _project_path(where: str, v: Any) -> None:
    if not isinstance(v, str) or not 1 <= len(v) <= 400 or _PROJECT_PATH.search(v):
        _fail(where, "not a project-relative path")


def check_process(doc: Any) -> None:
    """``WalkProcessFile`` (walkProcess.ts)."""
    _keys(
        "process",
        doc,
        {"schema", "walk", "createdAt", "engine", "input", "outputs", "stabilize", "stills", "path", "timings", "warnings"},
    )  # fmt: skip
    if doc["schema"] != WALK_PROCESS_SCHEMA:
        _fail("process.schema", repr(doc["schema"]))
    if not isinstance(doc["walk"], str) or not 1 <= len(doc["walk"]) <= 80:
        _fail("process.walk", "1 to 80 characters")
    if not isinstance(doc["createdAt"], str) or not _ISO.match(doc["createdAt"]):
        _fail("process.createdAt", "not an ISO time with a zone")
    eng = doc["engine"]
    _keys("process.engine", eng, {"version"}, {"pycolmap", "ffmpeg"})
    if not isinstance(eng["version"], str) or not 1 <= len(eng["version"]) <= 40:
        _fail("process.engine.version", "1 to 40 characters")
    for k, n in (("pycolmap", 40), ("ffmpeg", 80)):
        if k in eng and (not isinstance(eng[k], str) or len(eng[k]) > n):
            _fail(f"process.engine.{k}", f"at most {n} characters")
    inp = doc["input"]
    _keys("process.input", inp, {"layout", "calibration", "imu"}, {"file", "lenses", "camera"})
    if "file" in inp and (not isinstance(inp["file"], str) or not 1 <= len(inp["file"]) <= 260):
        _fail("process.input.file", "1 to 260 characters")
    if inp["layout"] not in ("insv-dual-stream", "dual-fisheye", "equirect"):
        _fail("process.input.layout", repr(inp["layout"]))
    if inp["calibration"] not in ("trailer", "default", "none"):
        _fail("process.input.calibration", repr(inp["calibration"]))
    if not isinstance(inp["imu"], bool):
        _fail("process.input.imu", "not a boolean")
    if "camera" in inp and (not isinstance(inp["camera"], str) or len(inp["camera"]) > 80):
        _fail("process.input.camera", "at most 80 characters")
    if "lenses" in inp:
        if not isinstance(inp["lenses"], list) or len(inp["lenses"]) > 2:
            _fail("process.input.lenses", "at most 2")
        for i, lens in enumerate(inp["lenses"]):
            w = f"process.input.lenses[{i}]"
            _keys(w, lens, {"cx", "cy", "radius", "fovDeg", "yawDeg", "pitchDeg", "rollDeg"})
            if not all(_num(v) for v in lens.values()):
                _fail(w, "not numbers")
            if lens["radius"] <= 0 or not 0 < lens["fovDeg"] <= 360:
                _fail(w, "radius or fovDeg out of range")
    out = doc["outputs"]
    _keys("process.outputs", out, set(), {"rawPath", "orientation", "imu", "sparse", "stills", "stabilized"})
    for k, v in out.items():
        _project_path(f"process.outputs.{k}", v)
    st = doc["stabilize"]
    _keys("process.stabilize", st, {"levelled", "keptYaw"})
    if not isinstance(st["levelled"], bool) or st["keptYaw"] is not True:
        _fail("process.stabilize", "levelled boolean, keptYaw true")
    sc = doc["stills"]
    _keys("process.stills", sc, {"sfm", "map"})
    if not all(_int(v) and v >= 0 for v in sc.values()):
        _fail("process.stills", "whole numbers >= 0")
    p = doc["path"]
    _keys("process.path", p, {"source", "registeredFraction", "segments"})
    if p["source"] not in ("sfm", "pins-only"):
        _fail("process.path.source", repr(p["source"]))
    if not _num(p["registeredFraction"]) or not 0 <= p["registeredFraction"] <= 1:
        _fail("process.path.registeredFraction", "0 to 1")
    if not _int(p["segments"]) or p["segments"] < 0:
        _fail("process.path.segments", "whole number >= 0")
    if not isinstance(doc["timings"], dict) or not all(
        isinstance(k, str) and _num(v) and v >= 0 for k, v in doc["timings"].items()
    ):
        _fail("process.timings", "seconds >= 0 by name")
    ws = doc["warnings"]
    if (
        not isinstance(ws, list)
        or len(ws) > MAX_WARNINGS
        or not all(isinstance(w, str) and len(w) <= MAX_WARNING_CHARS for w in ws)
    ):
        _fail("process.warnings", f"at most {MAX_WARNINGS} texts of {MAX_WARNING_CHARS} characters")
