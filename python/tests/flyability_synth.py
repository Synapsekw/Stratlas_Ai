"""A tiny synthetic Flyability Inspector 5 export with exact truth, for the importer tests.

Same on-disk layout as a real export (`flights/`, `inspections/`, `maps/`, `pois/`, `snapshots/`,
one folder per id, each JSON with `.json.<ms>.backup` revisions beside it), but the content is a
10 x 6 x 4 m box room sampled as a few hundred points. Frames: the inspection frame is the room
(x 0..10, y 0..6, z 0..4, z up). Flight A is relocalised (no `transform`, written in the inspection
frame). Each flight cloud is a different subset of the merged cloud's points. Flight B has a `transform` (flight to inspection frame, row-major 4 x 4) and its cloud,
livetraj and poses are written in its own frame, as Inspector does. Nothing here describes a real
site, person or flight. In the '2024' generation every snapshot `criticality` is null, as in the
real 2024 samples. An Asset-parent decoy map, an asset and an empty `orgs/` folder are included
as in real exports; readers must ignore them.

Runs as a script too (`python flyability_synth.py <root> [--generation 2024|2025]`) and prints a
small JSON summary of the ids; it imports only the standard library and numpy.
"""

from __future__ import annotations

import argparse
import base64
import copy
import json
import math
import random
import struct
import uuid
from dataclasses import dataclass, field
from itertools import pairwise
from pathlib import Path
from typing import Literal

import numpy as np

ROOM = np.array([10.0, 6.0, 4.0])
# A window in the x = 10 wall (y 2.5..3.5, z 1.5..2.5): points are never sampled there and a ray
# that leaves through it hits nothing.
GAP_Y = (2.5, 3.5)
GAP_Z = (1.5, 2.5)
LEVER_ARM = np.array([0.2986, 0.0077, -0.0202])  # camera in the body frame (m)
EMAIL = "operator@example.invalid"
LAUNCH_LAT = 12.3456789
LAUNCH_LON = 45.6789012


def _yaw_shift(deg: float, shift: tuple[float, float, float]) -> list[float]:
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    return [c, -s, 0.0, shift[0], s, c, 0.0, shift[1], 0.0, 0.0, 1.0, shift[2], 0.0, 0.0, 0.0, 1.0]


# Row-major flight -> inspection transform: yaw of 20 degrees plus a shift (m).
YAW_20_SHIFT = _yaw_shift(20.0, (0.4, -0.3, 0.05))

# An 8 x 6 px JPEG.
_JPG_B64 = (
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4"
    "UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2Nj"
    "Y2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAAGAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcI"
    "CQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRol"
    "JicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ip"
    "qrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAA"
    "AAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLR"
    "ChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaX"
    "mJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEA"
    "PwDPooormOg//9k="
)
_JPG = base64.b64decode(_JPG_B64)


@dataclass
class SynthExport:
    root: Path
    inspection_id: str
    flight_ids: list[str]  # [flight A (relocalised), flight B (has `transform`)]
    poi_ids: list[str]  # P1, P2, P3
    snapshot_ids: list[str]  # P1, P2 (Low), P2 (Critical), P3
    email: str = EMAIL
    launch_lat: float = LAUNCH_LAT
    # True distance (m) from each snapshot's camera along its view axis to the room surface, in
    # the inspection frame; `inf` when the ray leaves through the gap (no hit).
    wall: dict[str, float] = field(default_factory=dict)
    # The same hit as a point in the inspection frame (None for no hit).
    hit: dict[str, list[float] | None] = field(default_factory=dict)
    # Camera position in the inspection frame, and the flight that took each snapshot.
    camera_position: dict[str, list[float]] = field(default_factory=dict)
    snapshot_flight: dict[str, str] = field(default_factory=dict)


# ---------------------------------------------------------------------------------------------
# geometry helpers


def _rz(yaw_deg: float) -> np.ndarray:
    c, s = math.cos(math.radians(yaw_deg)), math.sin(math.radians(yaw_deg))
    return np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])


def _ry(deg: float) -> np.ndarray:
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    return np.array([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]])


def _quat(r: np.ndarray) -> dict[str, float]:
    """Rotation matrix to {x, y, z, w} (w >= 0)."""
    t = float(np.trace(r))
    if t > 0:
        s = math.sqrt(t + 1.0) * 2
        q = ((r[2, 1] - r[1, 2]) / s, (r[0, 2] - r[2, 0]) / s, (r[1, 0] - r[0, 1]) / s, s / 4)
    elif r[0, 0] >= r[1, 1] and r[0, 0] >= r[2, 2]:
        s = math.sqrt(1.0 + r[0, 0] - r[1, 1] - r[2, 2]) * 2
        q = (s / 4, (r[0, 1] + r[1, 0]) / s, (r[0, 2] + r[2, 0]) / s, (r[2, 1] - r[1, 2]) / s)
    elif r[1, 1] >= r[2, 2]:
        s = math.sqrt(1.0 + r[1, 1] - r[0, 0] - r[2, 2]) * 2
        q = ((r[0, 1] + r[1, 0]) / s, s / 4, (r[1, 2] + r[2, 1]) / s, (r[0, 2] - r[2, 0]) / s)
    else:
        s = math.sqrt(1.0 + r[2, 2] - r[0, 0] - r[1, 1]) * 2
        q = ((r[0, 2] + r[2, 0]) / s, (r[1, 2] + r[2, 1]) / s, s / 4, (r[1, 0] - r[0, 1]) / s)
    if q[3] < 0:
        q = tuple(-v for v in q)
    return {"x": q[0], "y": q[1], "z": q[2], "w": q[3]}


def _pose(p: np.ndarray, r: np.ndarray) -> dict:
    return {"position": dict(zip("xyz", map(float, p), strict=True)), "orientation": _quat(r)}


def _in_gap(p: np.ndarray) -> bool:
    return GAP_Y[0] <= p[1] <= GAP_Y[1] and GAP_Z[0] <= p[2] <= GAP_Z[1]


def _cast(origin: np.ndarray, direction: np.ndarray) -> tuple[float, np.ndarray | None]:
    """Distance and point where a ray from inside the room first meets its surface."""
    best, axis = math.inf, 0
    for i in range(3):
        if abs(direction[i]) < 1e-12:
            continue
        wall = ROOM[i] if direction[i] > 0 else 0.0
        t = (wall - origin[i]) / direction[i]
        if 0 < t < best:
            best, axis = t, i
    point = origin + best * direction
    if axis == 0 and direction[0] > 0 and _in_gap(point):
        return math.inf, None
    return best, point


def _room_points(rng: np.random.Generator, n: int) -> np.ndarray:
    """`n` points on the six faces of the room (area weighted), none inside the gap."""
    areas = np.array([ROOM[1] * ROOM[2]] * 2 + [ROOM[0] * ROOM[2]] * 2 + [ROOM[0] * ROOM[1]] * 2)
    out: list[np.ndarray] = []
    while len(out) < n:
        face = int(rng.choice(6, p=areas / areas.sum()))
        axis, high = face // 2, face % 2
        p = rng.random(3) * ROOM
        p[axis] = ROOM[axis] if high else 0.0
        if axis == 0 and high and _in_gap(p):
            continue
        out.append(p)
    return np.array(out)


# ---------------------------------------------------------------------------------------------
# file writers


def _write_las(path: Path, xyz: np.ndarray) -> None:
    """LAS 1.4, point format 1, scale 0.001, no CRS, no VLRs."""
    n = len(xyz)
    scale = 0.001
    ints = np.round(xyz / scale).astype("<i4")
    rec = np.zeros(
        n,
        dtype=[
            ("xyz", "<i4", 3),
            ("i", "<u2"),
            ("flags", "u1"),
            ("cls", "u1"),
            ("angle", "i1"),
            ("user", "u1"),
            ("src", "<u2"),
            ("gps", "<f8"),
        ],
    )
    rec["xyz"] = ints
    rec["flags"] = 0x11  # return 1 of 1
    rec["gps"] = np.arange(n) * 0.001
    mins, maxs = xyz.min(axis=0), xyz.max(axis=0)
    header = bytearray(375)
    header[0:4] = b"LASF"
    header[24], header[25] = 1, 4
    header[26:58] = b"FLYABILITY SYNTH".ljust(32, b"\0")
    header[58:90] = b"flyability_synth".ljust(32, b"\0")
    struct.pack_into("<HHH", header, 90, 1, 2026, 375)  # day, year, header size
    struct.pack_into("<II", header, 96, 375, 0)  # offset to points, VLR count
    header[104] = 1
    struct.pack_into("<H", header, 105, rec.dtype.itemsize)
    struct.pack_into("<I", header, 107, n)
    struct.pack_into("<5I", header, 111, n, 0, 0, 0, 0)
    struct.pack_into("<3d", header, 131, scale, scale, scale)
    struct.pack_into("<3d", header, 155, 0.0, 0.0, 0.0)
    struct.pack_into("<6d", header, 179, maxs[0], mins[0], maxs[1], mins[1], maxs[2], mins[2])
    struct.pack_into("<QQI", header, 227, 0, 0, 0)  # waveform, first EVLR, EVLR count
    struct.pack_into("<Q", header, 247, n)
    struct.pack_into("<5Q", header, 255, n, 0, 0, 0, 0)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(bytes(header) + rec.tobytes())


def _write_json(path: Path, data: dict, stale: dict, ms: int) -> None:
    """The JSON plus two `.json.<ms>.backup` revisions that differ from it."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=4, sort_keys=True), encoding="utf-8")
    for i, delta in enumerate((1, 6)):
        old = copy.deepcopy(data)
        old.update(stale)
        old["backup_revision"] = i
        (path.parent / f"{path.name}.{ms + delta * 1000}.backup").write_text(
            json.dumps(old, indent=4, sort_keys=True), encoding="utf-8"
        )


def _audit(created: int) -> dict:
    return {
        "created_by": EMAIL,
        "created_date": created,
        "last_updated_by": EMAIL,
        "last_updated_date": created + 60,
    }


# ---------------------------------------------------------------------------------------------
# the export


# Snapshots: (poi index, flight index, body position in the inspection frame, body yaw deg,
# camera pitch deg, criticality, tags, seconds since boot, wall distance error (m) or None).
_SNAPS = [
    (0, 1, (3.0, 2.0, 1.5), 0.0, -5, "High", ["corrosion"], 30, 0.0),
    (1, 0, (5.0, 2.0, 2.0), 90.0, 0, "Low", [], 30, 0.0),
    (1, 0, (6.0, 3.0, 2.0), 180.0, -10, "Critical", [], 40, 2.0),
    (2, 0, (4.0, 3.0, 2.0), 0.0, 0, None, [], 50, None),
]


def make_export(
    root: Path,
    *,
    generation: Literal["2024", "2025"] = "2025",
    merged: bool = True,
    transform: list[float] | None = YAW_20_SHIFT,
    points: int = 400,
) -> SynthExport:
    rng = random.Random(20261031)
    np_rng = np.random.default_rng(20261031)

    def new_id() -> str:
        return str(uuid.UUID(int=rng.getrandbits(128), version=4))

    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    ext = "bag" if generation == "2024" else "mcap"
    ms = 1732684613000
    epoch = 1732600000

    inspection_id = new_id()
    asset_id = new_id()
    base = _room_points(np_rng, points)  # the merged cloud; flight clouds are subsets
    (root / "orgs").mkdir(exist_ok=True)
    flight_ids = [new_id(), new_id()]
    poi_ids = [new_id() for _ in range(3)]
    snapshot_ids = [new_id() for _ in _SNAPS]
    syn = SynthExport(root, inspection_id, flight_ids, poi_ids, snapshot_ids)

    # Flight B's own frame: p_inspection = R p_flight + t.
    if transform is not None:
        m = np.array(transform, dtype=float).reshape(4, 4)
        rot, shift = m[:3, :3], m[:3, 3]
    else:
        rot, shift = np.eye(3), np.zeros(3)

    def to_flight(fi: int, pos: np.ndarray, r: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        if fi == 1:
            return rot.T @ (pos - shift), rot.T @ r
        return pos, r

    # inspection, pois
    _write_json(
        root / "inspections" / inspection_id / "inspection.json",
        {
            "id": inspection_id,
            "name": "Synthetic room",
            "description": "box room",
            "asset_id": asset_id,
            "tags": [],
            "path": None,
            "files": None,
            "audit": _audit(epoch),
        },
        {"name": "Old name"},
        ms,
    )
    for i, pid in enumerate(poi_ids):
        _write_json(
            root / "pois" / pid / "poi.json",
            {
                "id": pid,
                "name": f"POI-{i + 1}",
                "description": None,
                "asset_id": asset_id,
                "tags": ["corrosion"] if i == 0 else [],
                "path": None,
                "audit": _audit(epoch + 10),
            },
            {"name": "Old POI"},
            ms,
        )

    # per-flight poses, snapshots
    waypoints: dict[int, list[tuple[float, np.ndarray, float]]] = {
        0: [(20.0, np.array([1.0, 1.0, 1.5]), 0.0)],
        1: [(20.0, np.array([1.0, 4.0, 1.5]), 0.0)],
    }
    for sid, (pi, fi, pos_t, yaw, pitch, crit, tags, secs, err) in zip(snapshot_ids, _SNAPS, strict=True):
        pos = np.array(pos_t)
        rb = _rz(yaw)
        cam = pos + rb @ LEVER_ARM
        rc = rb @ _ry(-pitch)
        dist, hit = _cast(cam, rc[:, 0])
        syn.wall[sid] = dist
        syn.hit[sid] = None if hit is None else [float(v) for v in hit]
        syn.camera_position[sid] = [float(v) for v in cam]
        syn.snapshot_flight[sid] = flight_ids[fi]
        waypoints[fi].append((float(secs), pos, yaw))

        dpos, drot = to_flight(fi, pos, rb)
        cpos, crot = to_flight(fi, cam, rc)
        wall_distance = None if err is None else float(dist + err)
        snap_dir = root / "snapshots" / sid
        rgb, ann = f"{sid}_rgb.jpg", "result_annotated.jpg"
        snap_dir.mkdir(parents=True, exist_ok=True)
        for name in (rgb, ann, "result.jpg", "thumbnail.jpg", "001_0001.JPG"):
            (snap_dir / name).write_bytes(_JPG)
        points_ann = (
            [{"x": 0.5, "y": 0.4, "text": "rust patch"}]
            if pi == 0
            else ([{"x": 0.25, "y": 0.75, "text": ""}] if crit == "Critical" else [])
        )
        _write_json(
            snap_dir / "snapshot.json",
            {
                "id": sid,
                "flight_id": flight_ids[fi],
                "poi_id": poi_ids[pi],
                "time": int(secs * 1_000_000),
                "camera_pitch": pitch,
                "camera_pose": _pose(cpos, crot),
                "drone_pose": _pose(dpos, drot),
                "criticality": None if generation == "2024" else crit,
                "comment": f"finding {pi + 1}" if crit else None,
                "tags": tags,
                "wall_distance": wall_distance,
                "path": None,
                "camera_image": "001_0001.JPG",
                "camera_image_file": {"last_updated_date": epoch, "path": "001_0001.JPG"},
                "picture": {
                    "original_rbg": rgb,
                    "original_rbg_file": {"last_updated_date": epoch, "path": rgb},
                    "result_annotated": ann,
                    "result_annotated_file": {"last_updated_date": epoch, "path": ann},
                    "annotations": {"points": points_ann} if points_ann else None,
                    "properties": {"image_size": {"x": 8, "y": 6}},
                },
                "audit": _audit(epoch + 20),
            },
            {
                "criticality": "Low",
                "comment": "stale",
                "wall_distance": 99.0,
                "camera_pose": _pose(cpos + 5.0, crot),
            },
            ms,
        )

    # flights: json, map (cloud + livetraj), logs
    for fi, fid in enumerate(flight_ids):
        identifier = f"SYNTH_{fi + 1:03d}_flight"
        pts = base[np.sort(np_rng.choice(len(base), size=max(1, len(base) * 3 // 5), replace=False))]
        if fi == 1:
            pts = (pts - shift) @ rot  # inspection -> flight frame
        wps = waypoints[fi]
        steps = round((wps[-1][0] - wps[0][0]) * 10)
        rows = ["timestamp[s] pos_x[m] pos_y[m] pos_z[m] rot_x rot_y rot_z rot_w quality"]
        for k in range(steps + 1):
            t = (round(wps[0][0] * 10) + k) / 10
            for (t0, p0, y0), (t1, p1, y1) in pairwise(wps):
                if t0 <= t <= t1:
                    f = (t - t0) / (t1 - t0)
                    p, yaw = p0 + f * (p1 - p0), y0 + f * (y1 - y0)
                    break
            fp, fr = to_flight(fi, p, _rz(yaw))
            q = _quat(fr)
            rows.append(
                f"{t:.1f} {fp[0]:.6f} {fp[1]:.6f} {fp[2]:.6f} "
                f"{q['x']:.6f} {q['y']:.6f} {q['z']:.6f} {q['w']:.6f} 3"
            )
        map_id = new_id()
        mdir = root / "maps" / map_id
        las_name, traj_name = f"{identifier}_livemap.las", f"{identifier}_livetraj.csv"
        _write_las(mdir / las_name, pts)
        (mdir / traj_name).write_text("\n".join(rows) + "\n", encoding="utf-8")
        _write_json(
            mdir / "map.json",
            {
                "id": map_id,
                "parent_type": "Flight",
                "parent_id": fid,
                "source": "Flyaware",
                "folder_path": "",
                "path": None,
                "transform": None,
                "point_clouds": [
                    {
                        "id": new_id(),
                        "file_path": las_name,
                        "octree": None,
                        "file": {"last_updated_date": epoch, "path": las_name},
                    }
                ],
                "trajectories": [
                    {
                        "id": new_id(),
                        "file_path": traj_name,
                        "file": {"last_updated_date": epoch, "path": traj_name},
                    }
                ],
                "audit": _audit(epoch + 30),
            },
            {"parent_type": "Asset", "parent_id": asset_id},
            ms,
        )
        fdir = root / "flights" / fid
        fdir.mkdir(parents=True, exist_ok=True)
        (fdir / f"{identifier}_obcbag.{ext}").write_bytes(b"")
        if fi == 0:
            (fdir / "000_0001.MOV").write_bytes(b"")
        _write_json(
            fdir / "flight.json",
            {
                "id": fid,
                "name": f"Flight #{fi + 1}",
                "identifier": identifier,
                "inspection_id": inspection_id,
                "phase": "Flight",
                "description": None,
                "relocalized": fi == 0,
                "transform": {"v": [float(v) for v in transform]}
                if (fi == 1 and transform is not None)
                else None,
                "datetime_utc": epoch + 100 * fi,
                "duration": 60_000_000,
                "time_sync": {
                    "video_offset": 1_000_000,
                    "phase_start_time": 20_000_000,
                    "phase_end_time": 80_000_000,
                    "av_offset": 0,
                },
                "location": {"latitude": LAUNCH_LAT, "longitude": LAUNCH_LON, "altitude": 321.5},
                "tags": [],
                "path": None,
                "audit": _audit(epoch + 40),
            },
            {"inspection_id": new_id(), "transform": None, "name": "Old flight"},
            ms,
        )

    # merged inspection cloud
    if merged:
        map_id = new_id()
        las_name = "inspection_map1.las" if generation == "2024" else "inspection_map2.las"
        mdir = root / "maps" / map_id
        _write_las(mdir / las_name, base)
        _write_json(
            mdir / "map.json",
            {
                "id": map_id,
                "parent_type": "Inspection",
                "parent_id": inspection_id,
                "source": "Flyaware",
                "folder_path": "",
                "path": None,
                "transform": None,
                "point_clouds": [
                    {
                        "id": new_id(),
                        "file_path": las_name,
                        "octree": None,
                        "file": {"last_updated_date": epoch, "path": las_name},
                    }
                ],
                "trajectories": [],
                "audit": _audit(epoch + 50),
            },
            {"parent_type": "Asset", "parent_id": asset_id},
            ms,
        )
    # asset and its relocalisation map (ignored by readers)
    _write_json(
        root / "assets" / asset_id / "asset.json",
        {
            "id": asset_id,
            "name": "Synthetic chamber",
            "description": None,
            "tags": [],
            "path": None,
            "audit": _audit(epoch - 100),
        },
        {"name": "Old asset"},
        ms,
    )
    map_id = new_id()
    las_name = f"{map_id}_map.las"
    mdir = root / "maps" / map_id
    _write_las(mdir / las_name, _room_points(np_rng, 10) + np.array([50.0, 50.0, 0.0]))
    _write_json(
        mdir / "map.json",
        {
            "id": map_id,
            "parent_type": "Asset",
            "parent_id": asset_id,
            "source": "Flyaware",
            "folder_path": "",
            "path": None,
            "transform": None,
            "point_clouds": [
                {
                    "id": new_id(),
                    "file_path": las_name,
                    "octree": None,
                    "file": {"last_updated_date": epoch, "path": las_name},
                }
            ],
            "trajectories": [],
            "audit": _audit(epoch + 60),
        },
        {"parent_type": "Inspection", "parent_id": inspection_id},
        ms,
    )
    return syn


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("root", type=Path)
    ap.add_argument("--generation", choices=["2024", "2025"], default="2025")
    args = ap.parse_args(argv)
    syn = make_export(args.root, generation=args.generation)
    print(
        json.dumps(
            {
                "root": str(syn.root),
                "inspection_id": syn.inspection_id,
                "flight_ids": syn.flight_ids,
                "poi_ids": syn.poi_ids,
                "snapshot_ids": syn.snapshot_ids,
                "email": syn.email,
                "launch_lat": syn.launch_lat,
                "wall": {k: (None if math.isinf(v) else v) for k, v in syn.wall.items()},
            }
        )
    )


if __name__ == "__main__":
    main()
