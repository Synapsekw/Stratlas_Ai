"""``walk.process`` end to end on the synthetic walk (tests/walk_synth.py), plus its still picking
and file writers.

Comparing with the truth: ``walk_synth`` gives ``truth_q``, camera to world (z up), in OUR camera
axes (x right, y down, z forward), frame 0 level at yaw 0. The pipeline writes three.js camera axes
(x right, y up, looking down -z) in its raw frame: ``R_T = R_C @ D`` with ``D = diag(1, -1, -1)``,
so a record's ``R_C = R_T @ D``. The raw frame is the SfM frame (an unknown rotation, scale and
offset from the world) or, pins-only, the gravity frame (the world itself, yaw 0 at frame 0).
Orientation is compared after removing that constant rotation, taken from frame 0.
"""

from __future__ import annotations

import itertools
import json
import math
import os
import re
import shutil
import subprocess
from pathlib import Path

import cv2
import numpy as np
import pytest

import walk_synth as ws
from aio_pipelines.runtime import JobError
from aio_pipelines.walk import lens as lensmap
from aio_pipelines.walk import motion, outputs, pipeline, stills
from aio_pipelines.walk.calib import parse_offset
from aio_pipelines.walk.pipeline import TOO_SHORT, WalkProcess
from aio_pipelines.walk.sfm import umeyama
from aio_pipelines.walk.stitch import run_frames
from conftest import run_job

WID = "vid-20261012-120000-00-001"
FPS = 15
SCHEMA_FIXTURES = (
    Path(__file__).resolve().parents[2] / "packages" / "schema" / "src" / "__fixtures__" / "walk"
)
D = np.diag([1.0, -1.0, -1.0])


def _angle_deg(ra: np.ndarray, rb: np.ndarray) -> float:
    c = (np.trace(np.asarray(ra).T @ np.asarray(rb)) - 1.0) / 2.0
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


def _vec_angle_deg(a, b) -> float:
    a, b = np.asarray(a, float), np.asarray(b, float)
    return math.degrees(math.acos(np.clip(a @ b / np.linalg.norm(a) / np.linalg.norm(b), -1.0, 1.0)))


# =============================================================================== units (no ffmpeg)


def test_sfm_times_keep_the_first_and_last_still_of_each_stop():
    times = stills.pick_sfm_times(6.0, 2.0, [(0.0, 1.8), (3.9, 5.1)])
    assert times == [0.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0, 5.5]
    assert stills.pick_sfm_times(1.0, 4.0, []) == [0.0, 0.25, 0.5, 0.75]
    assert stills.pick_sfm_times(0.0, 2.0, []) == []


def test_map_stills_are_a_metre_apart_by_steps_and_at_most_one_a_second():
    times = [k * 0.5 for k in range(21)]  # 0 .. 10 s
    fast = stills.pick_map_stills(times, lambda t: 2.0 * t, 0.7)  # 1.4 m/s: the 1 s rule decides
    assert [times[i] for i in fast] == [float(k) for k in range(11)]
    slow = stills.pick_map_stills(times, lambda t: 1.0 * t, 0.7)  # 0.7 m/s: 1.43 steps -> 1.5 s
    assert [times[i] for i in slow] == [0.0, 1.5, 3.0, 4.5, 6.0, 7.5, 9.0]
    standing = stills.pick_map_stills(times, lambda t: 0.0, 0.7)
    assert standing == [0]
    no_imu = stills.pick_map_stills(times, None, 0.7)
    assert [times[i] for i in no_imu] == [float(k) for k in range(11)]
    count = stills.steps_counter([0.5, 1.0, 1.5])
    assert [count(t) for t in (0.0, 0.5, 1.2, 9.0)] == [0.0, 1.0, 2.0, 3.0]


def test_still_names_and_sizes():
    assert stills.still_name(12) == "still_000012.jpg"
    assert stills.map_name(7) == "00007.jpg" and stills.map_name(123456) == "123456.jpg"
    assert stills.sfm_size(3840, 1920) == (1920, 960)
    assert stills.sfm_size(1184, 592) == (1024, 512)
    assert stills.sfm_size(800, 400) == (800, 400)


def test_threejs_axes_and_xyzw_order():
    # our camera at rest (looking along +z of the frame) is a three.js camera turned half way about x
    assert outputs.quat_xyzw(outputs.to_threejs(np.eye(3))) == pytest.approx([1, 0, 0, 0])
    rng = np.random.default_rng(1)
    for _ in range(5):
        r = outputs.nearest_rotation(rng.normal(size=(3, 3)))
        q = outputs.quat_xyzw(outputs.to_threejs(r))
        back = outputs.from_threejs(outputs.matrix_from_xyzw(q))
        assert np.allclose(back, r, atol=1e-9)
        # three.js looks down its -z: the same direction as our +z
        assert np.allclose(outputs.matrix_from_xyzw(q) @ [0, 0, -1], r @ [0, 0, 1], atol=1e-9)


def test_gravity_to_raw_recovers_a_known_rotation():
    rng = np.random.default_rng(2)
    m = outputs.nearest_rotation(rng.normal(size=(3, 3)))
    grav = [outputs.nearest_rotation(rng.normal(size=(3, 3))) for _ in range(8)]
    noise = [outputs.nearest_rotation(np.eye(3) + 0.002 * rng.normal(size=(3, 3))) for _ in grav]
    raw = [n @ m @ g for n, g in zip(noise, grav, strict=True)]
    assert _angle_deg(outputs.gravity_to_raw(raw, grav), m) < 0.2


def test_orientation_records_round_trip(tmp_path: Path):
    t = np.arange(5) / 10.0
    rs = np.stack(
        [motion.quat_to_matrix(motion.quat_from_rotvec(np.array([0.0, 0.0, 0.3 * k]))) for k in range(5)]
    )
    header = outputs.write_orientation(tmp_path, t, rs, 10.0)
    assert header == {
        "schema": "aio.walkorient/1",
        "rateHz": 10.0,
        "count": 5,
        "convention": "xyzw-camera-threejs",
        "frame": "raw",
        "startOffsetS": 0,
        "data": "orientation.bin",
        "layout": "f32le-t-xyzw",
    }
    assert (tmp_path / "orientation.bin").stat().st_size == 5 * 20
    h2, rows = outputs.read_orientation(tmp_path)
    assert h2 == header and rows[:, 0] == pytest.approx(t)
    for k in range(5):
        assert _angle_deg(outputs.from_threejs(outputs.matrix_from_xyzw(rows[k, 1:])), rs[k]) < 1e-3
    with pytest.raises(ValueError):
        outputs.write_orientation(tmp_path, np.zeros(3), rs[:3], 10.0)


def test_the_golden_schema_fixtures_pass_the_python_checks():
    outputs.check_process(json.loads((SCHEMA_FIXTURES / "process.synthetic.json").read_text("utf-8")))
    outputs.check_raw_path(json.loads((SCHEMA_FIXTURES / "raw-path.synthetic.json").read_text("utf-8")))
    outputs.check_orientation(json.loads((SCHEMA_FIXTURES / "orientation.synthetic.json").read_text("utf-8")))


def test_the_checks_refuse_what_the_schemas_refuse():
    good = json.loads((SCHEMA_FIXTURES / "process.synthetic.json").read_text("utf-8"))
    for bad in (
        {**good, "extra": 1},
        {**good, "outputs": {"rawPath": "../x.json"}},
        {**good, "outputs": {"rawPath": "C:/x.json"}},
        {**good, "stabilize": {"levelled": True, "keptYaw": False}},
        {**good, "path": {**good["path"], "registeredFraction": 1.5}},
        {**good, "input": {**good["input"], "calibration": "guess"}},
        {**good, "warnings": ["x" * 401]},
        {k: v for k, v in good.items() if k != "timings"},
    ):
        with pytest.raises(outputs.SchemaError):
            outputs.check_process(bad)
    raw = {"schema": "aio.walkpath/1", "walk": "w", "source": "sfm", "stills": [{"n": 0, "t": 0, "steps": 0}]}
    outputs.check_raw_path(raw)
    for bad in (
        {**raw, "stills": []},
        {**raw, "source": "gps"},
        {**raw, "stills": [{"n": -1, "t": 0, "steps": 0}]},
        {**raw, "stills": [{"n": 0, "t": 0, "steps": 0, "q": [0, 0, 1]}]},
        {**raw, "scale": "arbitrary"},
    ):
        with pytest.raises(outputs.SchemaError):
            outputs.check_raw_path(bad)


def test_a_chapter_of_another_clip_is_refused(tmp_path: Path):
    a = tmp_path / "VID_1_00_001.insv"
    b = tmp_path / "VID_2_00_002.insv"
    a.write_bytes(b"x")
    b.write_bytes(b"y")
    source = {"file": a.name, "bytes": 1}
    with pytest.raises(JobError, match="not a chapter"):
        pipeline.check_src([str(a), str(b)], source)
    with pytest.raises(JobError, match=r"The original VID_1_00_001\.insv was not found or has changed"):
        pipeline.check_src([str(a)], {**source, "bytes": 2})
    with pytest.raises(JobError, match=r"The original VID_1_00_002\.insv was not found or has changed"):
        pipeline.check_src([str(a), str(tmp_path / "VID_1_00_002.insv")], source)
    c = tmp_path / "VID_1_00_002.insv"
    c.write_bytes(b"z")
    pipeline.check_src([str(a), str(c)], source)


# =============================================================================== the job (ffmpeg)


def _ffmpeg_or_skip() -> None:
    if ws.find_ffmpeg() is None:
        if os.environ.get("CI"):
            pytest.fail("ffmpeg is needed in CI (QUADRION_FFMPEG or the PATH)")
        pytest.skip("ffmpeg is not available (set QUADRION_FFMPEG or put it on PATH)")


def _playback(walk: ws.SynthWalk, out: Path) -> Path:
    """An equirect playback copy of the synthetic walk (our stitch, its calibration, not levelled)."""
    lp = round(walk.lens[0] * 2)
    lenses = parse_offset(walk.offset, lp, lp)
    run_frames([str(walk.path)], "insv-dual-stream", lenses, FPS, None, out, [], lambda: None, lambda f: None)
    return out


def _project(root: Path, walk: ws.SynthWalk, playback: Path, *, trailer: bool = True) -> Path:
    """A project folder with the walk as the import writes it (walk.json and playback.mp4)."""
    folder = root / "walks" / WID
    folder.mkdir(parents=True)
    shutil.copyfile(playback, folder / "playback.mp4")
    lp = round(walk.lens[0] * 2)
    w = cv2.VideoCapture(str(playback))
    width, height = int(w.get(cv2.CAP_PROP_FRAME_WIDTH)), int(w.get(cv2.CAP_PROP_FRAME_HEIGHT))
    w.release()
    doc = {
        "schema": "aio.walk/1",
        "id": WID,
        "name": "Synthetic walk",
        "createdAt": "2026-10-12T12:00:00Z",
        "source": {
            "file": walk.path.name,
            "bytes": walk.path.stat().st_size,
            "layout": "insv-dual-stream",
            "trailer": trailer,
            "capturedAt": "2026-10-12T12:00:00",
            "streams": [{"width": lp, "height": lp, "codec": "avc1", "fps": FPS}] * 2,
        },
        "video": {
            "src": f"walks/{WID}/playback.mp4",
            "width": width,
            "height": height,
            "durationS": float(len(walk.truth_t)) / FPS,
            "fps": FPS,
            "audio": False,
        },
        "stitch": {"tool": "ffmpeg", "filter": "v360=dfisheye:equirect", "fovDeg": 195, "encoder": "libx264"},
    }
    (folder / "walk.json").write_text(json.dumps(doc, indent=1), "utf-8")
    return root


def _read(project: Path, name: str):
    return json.loads((project / "walks" / WID / name).read_text("utf-8"))


def _records(project: Path) -> tuple[dict, np.ndarray]:
    return outputs.read_orientation(project / "walks" / WID)


def _check_files(project: Path) -> dict:
    """Every JSON validates; the binary files have the lengths their headers say."""
    folder = project / "walks" / WID
    rec = _read(project, "process.json")
    outputs.check_process(rec)
    golden = json.loads((SCHEMA_FIXTURES / "process.synthetic.json").read_text("utf-8"))
    assert set(rec) == set(golden)
    assert set(rec["stabilize"]) == set(golden["stabilize"]) and set(rec["path"]) == set(golden["path"])
    assert set(rec["timings"]) == {"read", "frames", "sfm", "finish"}
    raw = _read(project, "raw-path.json")
    outputs.check_raw_path(raw)
    assert rec["outputs"]["rawPath"] == f"walks/{WID}/raw-path.json"
    for key, rel in rec["outputs"].items():
        assert (project / rel).exists(), key
    if "orientation" in rec["outputs"]:
        header, rows = _records(project)
        outputs.check_orientation(header)
        assert (folder / "orientation.bin").stat().st_size == header["count"] * 20
        assert np.all(np.diff(rows[:, 0]) > 0) and rows[0, 0] == 0.0
    if "imu" in rec["outputs"]:
        assert (folder / "imu.bin").stat().st_size % 28 == 0
    assert rec["stills"] == {"sfm": len(raw["stills"]), "map": len(raw.get("kept", []))}
    kept = raw.get("kept", [])
    assert set(kept) <= {s["n"] for s in raw["stills"]}
    names = sorted(p.name for p in (folder / "stills").iterdir()) if kept else []
    assert names == sorted(stills.map_name(n) for n in kept)
    return rec


@pytest.fixture(scope="module")
def synth(tmp_path_factory) -> ws.SynthWalk:
    _ffmpeg_or_skip()
    return ws.make_synth_walk(tmp_path_factory.mktemp("synth"))


@pytest.fixture(scope="module")
def playback(synth, tmp_path_factory) -> Path:
    return _playback(synth, tmp_path_factory.mktemp("playback") / "playback.mp4")


@pytest.fixture(scope="module")
def processed(synth, playback, tmp_path_factory):
    project = _project(tmp_path_factory.mktemp("project"), synth, playback)
    result, rec = run_job(WalkProcess(), project, {"walk": WID, "src": [str(synth.path)]})
    return project, result, rec


def test_the_job_writes_every_file_and_they_validate(processed, synth):
    project, result, _ = processed
    assert result["status"] == "done"
    rec = _check_files(project)
    assert rec["walk"] == WID
    assert rec["input"]["file"] == synth.path.name
    assert rec["input"]["layout"] == "insv-dual-stream"
    assert rec["input"]["calibration"] == "trailer" and rec["input"]["imu"] is True
    assert rec["input"]["camera"] == "X4"
    for got, want in zip(rec["input"]["lenses"], synth.lenses, strict=True):
        assert (got["cx"], got["cy"], got["radius"]) == pytest.approx(want, abs=0.01)
    assert set(rec["outputs"]) == {"rawPath", "orientation", "imu", "sparse", "stills", "stabilized"}
    assert rec["stabilize"] == {"levelled": True, "keptYaw": True}
    assert rec["path"]["source"] == "sfm" and rec["path"]["segments"] == 1
    header, rows = _records(project)
    assert header["rateHz"] == FPS and header["count"] == len(synth.truth_t)
    raw = _read(project, "raw-path.json")
    assert raw["source"] == "sfm" and len(raw["up"]) == 3
    assert raw["walking"]["startT"] == pytest.approx(2.0, abs=0.5)
    print("timings", rec["timings"], "warnings", rec["warnings"])


def test_orientation_within_a_degree_of_the_truth(processed, synth):
    project, _, _ = processed
    _, rows = _records(project)
    r_raw = outputs.from_threejs(outputs.matrix_from_xyzw(rows[:, 1:].astype(np.float64)))
    r_true = motion.quat_to_matrix(synth.truth_q)
    a = r_raw[0] @ r_true[0].T  # world to raw frame, from frame 0
    err = [_angle_deg(r_raw[k], a @ r_true[k]) for k in range(len(r_true))]
    print(f"orientation error: max {max(err):.3f} deg, mean {np.mean(err):.3f} deg")
    assert max(err) < 1.0
    # the raw frame's up is the world's up taken by the same rotation
    raw = _read(project, "raw-path.json")
    print(f"up error {_vec_angle_deg(a @ [0, 0, 1], raw['up']):.3f} deg")
    assert _vec_angle_deg(a @ [0, 0, 1], raw["up"]) < 1.0


def test_records_agree_with_the_stills(processed):
    project, _, _ = processed
    _, rows = _records(project)
    raw = _read(project, "raw-path.json")
    errs = []
    for s in raw["stills"]:
        if "q" in s and s["segment"] == 0:
            errs.append(
                _angle_deg(
                    outputs.matrix_from_xyzw(np.array(s["q"])), outputs.matrix_from_xyzw(rows[s["n"], 1:])
                )
            )
    print(f"records vs stills: max {max(errs):.3f} deg")
    assert errs and max(errs) < 1.0


def test_path_registers_and_has_the_true_shape(processed, synth):
    project, _, _ = processed
    rec = _read(project, "process.json")
    raw = _read(project, "raw-path.json")
    assert rec["path"]["registeredFraction"] >= 0.9
    reg = [s for s in raw["stills"] if "pos" in s]
    assert len(reg) >= 0.9 * len(raw["stills"])
    truth = np.array([synth.truth_pos[s["n"]] for s in reg])
    pos = np.array([s["pos"] for s in reg])
    s_, r_, t_ = umeyama(truth, pos)
    resid = np.linalg.norm(s_ * truth @ r_.T + t_ - pos, axis=1) / s_
    length = float(np.sum(np.linalg.norm(np.diff(synth.truth_pos[:, :2], axis=0), axis=1)))
    print(
        f"path: {len(reg)}/{len(raw['stills'])} registered, max error {resid.max():.3f} m of {length:.1f} m"
    )
    assert resid.max() < 0.02 * length


def test_map_stills_about_a_metre_apart_and_standing_stills_dropped(processed, synth):
    project, result, _ = processed
    raw = _read(project, "raw-path.json")
    rec = _read(project, "process.json")
    by_n = {s["n"]: s for s in raw["stills"]}
    kept = raw["kept"]
    assert kept[0] == 0 and len(kept) >= 8
    gaps = []
    for a, b in itertools.pairwise(kept):
        sa, sb = by_n[a], by_n[b]
        assert sb["t"] - sa["t"] >= 1.0 - 1e-6
        assert (sb["steps"] - sa["steps"]) * 0.7 >= 1.0 - 1e-6
        gaps.append(float(np.linalg.norm(synth.truth_pos[b, :2] - synth.truth_pos[a, :2])))
    print("map still gaps (m)", [round(g, 2) for g in gaps])
    assert all(0.8 <= g <= 2.2 for g in gaps[1:])  # the first gap starts at the stop
    img = cv2.imread(str(project / "walks" / WID / "stills" / stills.map_name(kept[1])))
    assert img.shape[1] == 2 * img.shape[0] and img.shape[1] >= 1024
    # 2 s standing at the start (found from the accelerometer): only its first and last still
    stops = result["outputs"]["read"]["standing"]
    assert len(stops) == 1 and stops[0][0] == 0.0 and 1.9 <= stops[0][1] <= 2.6
    inside = [s["t"] for s in raw["stills"] if s["t"] <= stops[0][1]]
    assert len(inside) == 2 and inside[0] == 0.0 and inside[1] >= stops[0][1] - 0.5
    after = [s["t"] for s in raw["stills"] if s["t"] > stops[0][1]]
    assert after[0] - inside[1] <= 0.55 and all(
        b - a == pytest.approx(0.5, abs=0.07) for a, b in itertools.pairwise(after)
    )
    assert rec["stills"]["sfm"] == len(raw["stills"])


def _decode_grey(path: Path, index: int, w: int, h: int) -> np.ndarray:
    proc = subprocess.run(
        [ws.find_ffmpeg(), "-v", "error", "-i", str(path), "-vf", f"select=eq(n\\,{index})", "-frames:v", "1",
         "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        capture_output=True, check=True,
    )  # fmt: skip
    return np.frombuffer(proc.stdout, np.uint8).reshape(h, w)


def _pixel_dirs(pts: np.ndarray, w: int, h: int) -> np.ndarray:
    lon = ((pts[:, 0] + 0.5) / w - 0.5) * 2 * math.pi
    lat = (0.5 - (pts[:, 1] + 0.5) / h) * math.pi
    return np.stack([np.cos(lat) * np.sin(lon), -np.sin(lat), np.cos(lat) * np.cos(lon)], axis=1)


def test_levelled_copy_horizon_within_one_and_a_half_degrees(processed, synth):
    """Frames of ``stabilized.mp4`` against the scene rendered from the same spot by a truly level
    camera with the true yaw: SIFT matches between the two pictures fix the rotation between them,
    whose tilt (the angle it moves the up axis by) is the levelling error."""
    project, _, _ = processed
    rec = _read(project, "process.json")
    path = project / rec["outputs"]["stabilized"]
    cap = cv2.VideoCapture(str(path))
    w, h = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    cap.release()
    scene = ws.Scene(seed=7, textured=True)
    dirs = lensmap.equirect_dirs(w, h).reshape(-1, 3)
    sift = cv2.SIFT_create(nfeatures=3000)
    matcher = cv2.BFMatcher(cv2.NORM_L2)
    tilts = []
    for k in (30, 60, 100, 130, 170):  # standing, walking, turning, after the turn
        r_true = motion.quat_to_matrix(synth.truth_q[k])
        lvl = motion.level_rotation(synth.truth_q[k][None])[0]
        r_level = r_true @ lvl.T  # the truly level camera with the true yaw, camera to world
        val, _ = scene.shade(synth.truth_pos[k], (dirs @ r_level.T).T.astype(np.float32))
        ref = val.reshape(h, w)
        got = _decode_grey(path, k, w, h)
        ka, da = sift.detectAndCompute(got, None)
        kb, db = sift.detectAndCompute(ref, None)
        pairs = [m for m, n in matcher.knnMatch(da, db, k=2) if m.distance < 0.75 * n.distance]
        a = _pixel_dirs(np.array([ka[m.queryIdx].pt for m in pairs]), w, h)
        b = _pixel_dirs(np.array([kb[m.trainIdx].pt for m in pairs]), w, h)
        keep = np.ones(len(a), bool)
        for _ in range(4):  # rotation b ~ Q a, outliers out
            q = outputs.nearest_rotation(b[keep].T @ a[keep])
            res = np.degrees(np.arccos(np.clip(np.sum((a @ q.T) * b, axis=1), -1, 1)))
            keep = res < max(0.3, 3 * np.median(res[keep]))
        assert keep.sum() > 50
        tilts.append(_vec_angle_deg(q @ [0, -1, 0], [0, -1, 0]))
    print("levelled copy tilt (deg)", [round(t, 3) for t in tilts])
    assert max(tilts) < 1.5


def test_a_second_run_replaces_the_outputs_together_with_the_record_last(processed, tmp_path, monkeypatch):
    project = tmp_path / "again"
    shutil.copytree(processed[0], project, ignore=shutil.ignore_patterns("jobs"))
    folder = project / "walks" / WID
    first = _read(project, "process.json")
    seen: dict = {}
    write = outputs.write_process

    def spy(path, record):
        # the moment the record is written: every file it names is in place, nothing stale is left
        seen["files"] = sorted(p.name for p in folder.iterdir())
        seen["stills"] = sorted(p.name for p in (folder / "stills").iterdir())
        seen["record_existed"] = (folder / "process.json").exists()
        seen["latest"] = max(p.stat().st_mtime_ns for p in folder.rglob("*") if p.is_file())
        write(path, record)

    monkeypatch.setattr(outputs, "write_process", spy)
    src = json.loads((folder / "walk.json").read_text("utf-8"))["source"]["file"]
    original = Path(processed[1]["outputs"]["read"]["files"][0])
    assert original.name == src
    result, _ = run_job(
        WalkProcess(),
        project,
        {"walk": WID, "src": [str(original)], "sfm": False, "stabilize": False, "strideM": 0.3},
        job_id="j2",
    )
    assert result["status"] == "done"
    rec = _check_files(project)
    assert rec["createdAt"] >= first["createdAt"]
    assert seen["record_existed"] is False  # the old record went first
    assert "stabilized.mp4" not in seen["files"] and "sparse.ply" not in seen["files"]
    assert {"raw-path.json", "orientation.json", "orientation.bin", "imu.bin"} <= set(seen["files"])
    raw = _read(project, "raw-path.json")
    assert raw["source"] == "pins-only" and all("pos" not in s and "q" not in s for s in raw["stills"])
    assert seen["stills"] == sorted(stills.map_name(n) for n in raw["kept"])
    assert len(raw["kept"]) < first["stills"]["map"]
    assert (folder / "process.json").stat().st_mtime_ns >= seen["latest"]
    assert rec["path"] == {"source": "pins-only", "registeredFraction": 0.0, "segments": 0}
    assert rec["stabilize"]["levelled"] is False and "stabilized" not in rec["outputs"]


def test_an_original_of_another_size_is_refused_with_its_name(synth, playback, tmp_path):
    project = _project(tmp_path / "p", synth, playback)
    other = tmp_path / "moved" / synth.path.name
    other.parent.mkdir()
    shutil.copyfile(synth.path, other)
    with other.open("ab") as f:
        f.write(b"\0")
    with pytest.raises(
        JobError, match=re.escape(f"The original {synth.path.name} was not found or has changed")
    ):
        run_job(WalkProcess(), project, {"walk": WID, "src": [str(other)]})
    renamed = tmp_path / "moved" / "VID_20261012_120000_00_009.insv"
    shutil.copyfile(synth.path, renamed)
    with pytest.raises(
        JobError, match=re.escape(f"The original {synth.path.name} was not found or has changed")
    ):
        run_job(WalkProcess(), project, {"walk": WID, "src": [str(renamed)]}, job_id="j2")
    assert not (project / "walks" / WID / "process.json").exists()


def test_without_the_original_it_works_from_the_playback_copy(synth, playback, tmp_path):
    project = _project(tmp_path, synth, playback)
    result, _ = run_job(WalkProcess(), project, {"walk": WID})
    assert result["status"] == "done"
    rec = _check_files(project)
    assert rec["input"] == {"layout": "equirect", "calibration": "none", "imu": False}
    assert rec["stabilize"]["levelled"] is False
    assert not {"stabilized", "orientation", "imu"} & set(rec["outputs"])
    assert rec["stills"]["sfm"] >= 20  # no standing detection without motion data: every still
    print("from playback:", rec["path"], rec["warnings"])


def test_a_walk_under_10_s_is_pins_only_too_short_for_a_path(tmp_path):
    _ffmpeg_or_skip()
    walk = ws.make_synth_walk(tmp_path / "w", seconds=6.0, standing_s=1.0, lens_px=320)
    project = _project(tmp_path / "p", walk, _playback(walk, tmp_path / "pb.mp4"))
    result, _ = run_job(WalkProcess(), project, {"walk": WID, "src": [str(walk.path)], "stabilize": False})
    assert result["status"] == "done"
    rec = _check_files(project)
    assert rec["path"]["source"] == "pins-only"
    assert TOO_SHORT in rec["warnings"] and TOO_SHORT.startswith("Too short for a path")
    assert rec["stills"]["sfm"] < 20


def test_an_untextured_walk_is_pins_only_with_orientation_in_the_gravity_frame(tmp_path):
    _ffmpeg_or_skip()
    walk = ws.make_synth_walk(tmp_path / "w", textured=False, lens_px=320)
    project = _project(tmp_path / "p", walk, _playback(walk, tmp_path / "pb.mp4"))
    result, _ = run_job(WalkProcess(), project, {"walk": WID, "src": [str(walk.path)], "stabilize": False})
    assert result["status"] == "done"
    rec = _check_files(project)
    assert rec["path"]["source"] == "pins-only" and rec["warnings"]
    raw = _read(project, "raw-path.json")
    assert "up" not in raw and all("pos" not in s for s in raw["stills"])
    # pins-only: the raw frame is the gravity frame, which is the world (frame 0 level, yaw 0)
    _, rows = _records(project)
    r_raw = outputs.from_threejs(outputs.matrix_from_xyzw(rows[:, 1:].astype(np.float64)))
    r_true = motion.quat_to_matrix(walk.truth_q)
    err = [_angle_deg(r_raw[k], r_true[k]) for k in range(len(r_true))]
    print(f"gravity-frame orientation error: max {max(err):.3f} deg; warnings {rec['warnings']}")
    assert max(err) < 1.0


def test_without_a_trailer_no_levelled_copy_and_the_default_lens(tmp_path):
    _ffmpeg_or_skip()
    walk = ws.make_synth_walk(tmp_path / "w", trailer=False, lens_px=320)
    project = _project(tmp_path / "p", walk, _playback(walk, tmp_path / "pb.mp4"), trailer=False)
    result, _ = run_job(WalkProcess(), project, {"walk": WID, "src": [str(walk.path)]})
    assert result["status"] == "done"
    rec = _check_files(project)
    assert rec["input"]["calibration"] == "default" and rec["input"]["imu"] is False
    assert rec["input"]["lenses"][0]["fovDeg"] == 195
    assert rec["stabilize"]["levelled"] is False
    assert not {"stabilized", "orientation", "imu"} & set(rec["outputs"])
    assert any("trailer" in w for w in rec["warnings"])
    print("no trailer:", rec["path"], rec["warnings"])
