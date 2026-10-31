"""The synthetic Flyability Inspector export has the real layout, links and exact geometry truth."""

from __future__ import annotations

import json
import math
import struct
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from flyability_synth import LEVER_ARM, YAW_20_SHIFT, SynthExport, make_export


def _json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _las(path: Path) -> tuple[tuple[int, int], int, int, np.ndarray]:
    raw = path.read_bytes()
    assert raw[:4] == b"LASF"
    major, minor = raw[24], raw[25]
    offset = struct.unpack_from("<I", raw, 96)[0]
    fmt = raw[104]
    length = struct.unpack_from("<H", raw, 105)[0]
    scale = struct.unpack_from("<3d", raw, 131)
    n = struct.unpack_from("<Q", raw, 247)[0]
    assert scale == (0.001, 0.001, 0.001)
    recs = np.frombuffer(raw[offset : offset + n * length], dtype=np.uint8).reshape(n, length)
    xyz = recs[:, :12].copy().view("<i4").reshape(n, 3) * 0.001
    return (major, minor), fmt, n, xyz


def _flights(syn: SynthExport) -> dict[str, dict]:
    return {fid: _json(syn.root / "flights" / fid / "flight.json") for fid in syn.flight_ids}


def _quat_to_r(q: dict) -> np.ndarray:
    x, y, z, w = q["x"], q["y"], q["z"], q["w"]
    return np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ]
    )


def _p(d: dict) -> np.ndarray:
    return np.array([d["x"], d["y"], d["z"]])


def _flight_maps(syn: SynthExport) -> dict[str, tuple[Path, Path]]:
    out = {}
    for mp in (syn.root / "maps").glob("*/map.json"):
        d = _json(mp)
        if d["parent_type"] == "Flight":
            out[d["parent_id"]] = (
                mp.parent / d["point_clouds"][0]["file_path"],
                mp.parent / d["trajectories"][0]["file_path"],
            )
    return out


def test_synth_layout_and_links(tmp_path: Path) -> None:
    syn = make_export(tmp_path / "exp")
    for folder in ("flights", "inspections", "maps", "pois", "snapshots"):
        assert (syn.root / folder).is_dir()
    flights = _flights(syn)
    assert len(flights) == 2
    for fl in flights.values():
        assert fl["inspection_id"] == syn.inspection_id
    maps = [_json(p) for p in (syn.root / "maps").glob("*/map.json")]
    insp = [m for m in maps if m["parent_type"] == "Inspection"]
    assert len(insp) == 1 and insp[0]["parent_id"] == syn.inspection_id
    path = next((syn.root / "maps").glob(f"*/{insp[0]['point_clouds'][0]['file_path']}"))
    version, fmt, n, _ = _las(path)
    assert version == (1, 4) and fmt == 1 and n == 400
    a, b = (flights[f] for f in syn.flight_ids)
    assert a["transform"] is None and a["relocalized"] is True
    assert len(b["transform"]["v"]) == 16
    assert syn.email == "operator@example.invalid" and syn.launch_lat == 12.3456789
    assert len(syn.poi_ids) == 3 and len(syn.snapshot_ids) == 4


def test_flight_clouds_are_in_their_own_frames(tmp_path: Path) -> None:
    syn = make_export(tmp_path / "exp")
    flights = _flights(syn)
    m = np.array(flights[syn.flight_ids[1]]["transform"]["v"]).reshape(4, 4)
    maps = _flight_maps(syn)
    room_a = _las(maps[syn.flight_ids[0]][0])[3]
    room_b = _las(maps[syn.flight_ids[1]][0])[3]
    assert room_a.min() >= -0.01 and room_a[:, 0].max() <= 10.01
    back = room_b @ m[:3, :3].T + m[:3, 3]  # flight B -> inspection frame
    assert back.min() >= -0.01 and back[:, 0].max() <= 10.01
    assert back[:, 1].max() <= 6.01 and back[:, 2].max() <= 4.01
    assert room_b.min() < -0.05  # visibly not in the room frame


def test_poses_lever_arm_and_livetraj(tmp_path: Path) -> None:
    syn = make_export(tmp_path / "exp")
    maps = _flight_maps(syn)
    for sid in syn.snapshot_ids:
        s = _json(syn.root / "snapshots" / sid / "snapshot.json")
        rb = _quat_to_r(s["drone_pose"]["orientation"])
        rc = _quat_to_r(s["camera_pose"]["orientation"])
        np.testing.assert_allclose(
            _p(s["camera_pose"]["position"]),
            _p(s["drone_pose"]["position"]) + rb @ LEVER_ARM,
            atol=1e-5,
        )
        t = math.radians(-s["camera_pitch"])
        ry = np.array([[math.cos(t), 0, math.sin(t)], [0, 1, 0], [-math.sin(t), 0, math.cos(t)]])
        np.testing.assert_allclose(rc, rb @ ry, atol=1e-5)
        rows = maps[s["flight_id"]][1].read_text().splitlines()
        head = "timestamp[s] pos_x[m] pos_y[m] pos_z[m] rot_x rot_y rot_z rot_w quality"
        assert rows[0].split() == head.split()
        data = np.array([[float(v) for v in r.split()] for r in rows[1:]])
        np.testing.assert_allclose(np.diff(data[:, 0]), 0.1, atol=1e-6)
        row = data[np.argmin(abs(data[:, 0] - s["time"] / 1e6))]
        assert abs(row[0] - s["time"] / 1e6) < 1e-6
        np.testing.assert_allclose(row[1:4], _p(s["drone_pose"]["position"]), atol=2e-3)
        assert s["poi_id"] in syn.poi_ids


def test_wall_truth_and_snapshot_fields(tmp_path: Path) -> None:
    syn = make_export(tmp_path / "exp")
    ids = syn.snapshot_ids
    snaps = {sid: _json(syn.root / "snapshots" / sid / "snapshot.json") for sid in ids}
    p1, p2a, p2b, p3 = (snaps[s] for s in ids)
    assert p1["criticality"] == "High" and p1["tags"] == ["corrosion"]
    assert p1["wall_distance"] == pytest.approx(syn.wall[ids[0]], abs=1e-4)
    assert (p2a["criticality"], p2b["criticality"]) == ("Low", "Critical")
    off = [abs(s["wall_distance"] - syn.wall[i]) for s, i in zip((p2a, p2b), ids[1:3], strict=True)]
    assert sorted(round(o, 3) for o in off) == [0.0, 2.0]
    assert p3["criticality"] is None and p3["wall_distance"] is None
    assert math.isinf(syn.wall[ids[3]])
    for sid in ids[:3]:
        assert 1.0 < syn.wall[sid] < 12.0
    assert p1["picture"]["original_rbg"] == f"{ids[0]}_rgb.jpg"
    assert p1["picture"]["annotations"]["points"][0].keys() >= {"x", "y", "text"}
    assert p1["picture"]["properties"]["image_size"] == {"x": 8, "y": 6}
    jpg = syn.root / "snapshots" / ids[0] / "result_annotated.jpg"
    assert jpg.read_bytes()[:2] == b"\xff\xd8"


def test_backups_privacy_and_files(tmp_path: Path) -> None:
    syn = make_export(tmp_path / "exp")
    jsons = list(syn.root.rglob("*.json"))
    assert jsons
    for p in jsons:
        backups = list(p.parent.glob(p.name + ".*.backup"))
        assert backups, p
        assert _json(backups[0]) != _json(p)
    f = _json(syn.root / "flights" / syn.flight_ids[0] / "flight.json")
    assert f["audit"]["created_by"] == syn.email and f["location"]["latitude"] == syn.launch_lat
    assert f["time_sync"].keys() >= {"video_offset", "phase_start_time"}
    logs = list(syn.root.rglob("*_obcbag.mcap"))
    assert len(logs) == 2 and all(p.stat().st_size == 0 for p in logs)
    assert len(list(syn.root.rglob("*.MOV"))) == 1


def test_generation_merged_and_transform_options(tmp_path: Path) -> None:
    syn = make_export(tmp_path / "a", generation="2024", merged=False, transform=None, points=120)
    assert len(list(syn.root.rglob("*_obcbag.bag"))) == 2
    maps = [_json(p) for p in (syn.root / "maps").glob("*/map.json")]
    assert not [m for m in maps if m["parent_type"] == "Inspection"]
    assert all(f["transform"] is None for f in _flights(syn).values())
    assert len(YAW_20_SHIFT) == 16


def test_main_entry_runs_standalone(tmp_path: Path) -> None:
    script = Path(__file__).with_name("flyability_synth.py")
    out = subprocess.run(
        [sys.executable, "-I", str(script), str(tmp_path / "e"), "--generation", "2024"],
        capture_output=True,
        text=True,
        check=True,
    )
    info = json.loads(out.stdout)
    assert (tmp_path / "e" / "inspections" / info["inspection_id"]).is_dir()
    assert len(info["snapshot_ids"]) == 4
