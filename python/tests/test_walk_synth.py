"""The synthetic 360 walk (tests/walk_synth.py): file layout, trailer, truth and geometry."""

from __future__ import annotations

import os
import re
import subprocess
import time
from pathlib import Path

import numpy as np
import pytest

import walk_synth as ws
from aio_pipelines.walk.calib import parse_offset
from aio_pipelines.walk.trailer import INSTA360_MARK, read_trailer

FFMPEG = ws.find_ffmpeg()
if FFMPEG is None and not os.environ.get("CI"):
    pytest.skip("ffmpeg is not available (set QUADRION_FFMPEG or put it on PATH)", allow_module_level=True)

SMALL = {"seconds": 2.5, "fps": 5, "lens_px": 128, "standing_s": 1.0}


def _streams(path: Path) -> list[tuple[int, int]]:
    """(width, height) of every video stream, from ffmpeg's own probe output."""
    assert FFMPEG is not None, "ffmpeg is required in CI"
    proc = subprocess.run([FFMPEG, "-hide_banner", "-i", str(path)], capture_output=True, text=True)
    return [
        (int(m.group(1)), int(m.group(2)))
        for m in re.finditer(r"Stream #0:\d+.*?Video:.*?, (\d+)x(\d+)", proc.stderr)
    ]


def _frame(path: Path, stream: int, index: int, size: int) -> np.ndarray:
    """Decoded frame ``index`` of video stream ``stream``, grey, (size, size) uint8."""
    assert FFMPEG is not None
    proc = subprocess.run(
        [
            FFMPEG, "-v", "error", "-i", str(path), "-map", f"0:v:{stream}",
            "-vf", f"select=eq(n\\,{index})", "-frames:v", "1",
            "-f", "rawvideo", "-pix_fmt", "gray", "-",
        ],
        capture_output=True,
        check=True,
    )  # fmt: skip
    return np.frombuffer(proc.stdout, np.uint8).reshape(size, size)


@pytest.fixture(scope="module")
def walk(tmp_path_factory) -> ws.SynthWalk:
    return ws.make_synth_walk(tmp_path_factory.mktemp("walk"))


def test_two_lens_streams_and_the_insta360_mark(walk):
    assert _streams(walk.path) == [(640, 640), (640, 640)]
    data = walk.path.read_bytes()
    assert data[-32:] == INSTA360_MARK


def test_trailer_reads_back_samples_frame_times_and_offset(walk):
    tr = read_trailer(walk.path)
    assert tr is not None
    assert tr.camera == "X4"
    assert tr.offset == walk.offset
    assert tr.imu is not None and tr.frame_times is not None
    assert len(tr.imu.t) == 12_000
    np.testing.assert_allclose(np.diff(tr.imu.t), 1e-3, atol=1e-9)
    np.testing.assert_allclose(tr.frame_times, walk.truth_t, atol=5e-4)  # stored in whole ms
    assert len(walk.truth_t) == 180
    np.testing.assert_allclose(walk.truth_t, np.arange(180) / 15)
    # standing: the camera is level and still, so 1 g up (-y) and only the gyro bias
    still = tr.imu.t < 1.5
    np.testing.assert_allclose(tr.imu.acc[still].mean(axis=0), [0, -1, 0], atol=0.003)
    np.testing.assert_allclose(tr.imu.gyro[still].mean(axis=0), walk.gyro_bias, atol=0.001)
    # walking: a vertical bounce of about 0.15 g at the step frequency
    moving = tr.imu.t > 4.0
    acc_y = tr.imu.acc[moving, 1]
    assert 0.08 < np.percentile(-acc_y - 1.0, 99) < 0.3


def test_gyro_integrates_to_the_true_orientation(walk):
    """The motion samples agree with the truth: integrating the bias-free gyro from the first
    frame's orientation lands on the last frame's orientation."""
    tr = read_trailer(walk.path)
    gyro = tr.imu.gyro - walk.gyro_bias
    R = ws.quat_to_matrix(walk.truth_q[0])
    dt = 1e-3
    for w in gyro[: round(walk.truth_t[-1] * 1000)]:
        R = R @ ws.rotvec_to_matrix(w * dt)
    R_true = ws.quat_to_matrix(walk.truth_q[-1])
    err = np.degrees(np.linalg.norm(ws.matrix_to_rotvec(R_true.T @ R)))
    assert err < 1.0
    # and the walk did turn 90 degrees to the right (yaw 0 to -90)
    fwd = R_true @ [0, 0, 1]
    assert fwd[0] > 0.95


def test_offset_parses_to_the_lenses_rendered(walk):
    lens0, lens1 = parse_offset(walk.offset, 640, 640)
    for parsed, used in ((lens0, walk.lenses[0]), (lens1, walk.lenses[1])):
        assert (parsed.cx, parsed.cy, parsed.radius) == pytest.approx(used, abs=1e-3)
        assert parsed.fov_deg == 195.0
        assert (parsed.yaw_deg, parsed.pitch_deg, parsed.roll_deg) == (0.0, 0.0, 0.0)
    assert walk.lens == walk.lenses[0]
    assert walk.lenses[1] != walk.lenses[0]  # a known shift, so a reader that ignores it shows


def test_truth_path_stands_then_walks_an_l(walk):
    t, pos = walk.truth_t, walk.truth_pos
    assert pos.shape == (180, 3) and walk.truth_q.shape == (180, 4)
    np.testing.assert_allclose(np.linalg.norm(walk.truth_q, axis=1), 1.0, atol=1e-9)
    standing = t < 2.0
    np.testing.assert_allclose(pos[standing], np.repeat(pos[:1], standing.sum(), axis=0), atol=1e-9)
    assert pos[0, 2] == pytest.approx(1.6)
    length = np.sum(np.linalg.norm(np.diff(pos[:, :2], axis=0), axis=1))
    assert length == pytest.approx(1.2 * (12.0 - 2.0 - ws.RAMP_S / 2), rel=0.01)
    d = pos[-1, :2] - pos[0, :2]
    assert d[0] > 3 and d[1] > 3  # forward along +y, then right along +x
    lo, hi = np.array(ws.ROOM_MIN), np.array(ws.ROOM_MAX)
    assert np.all(pos > lo + 0.5) and np.all(pos < hi - 0.5)


def test_deterministic_for_a_seed(tmp_path):
    a = ws.build_synth_walk(tmp_path / "a", **SMALL, seed=11)
    b = ws.build_synth_walk(tmp_path / "b", **SMALL, seed=11)
    c = ws.build_synth_walk(tmp_path / "c", **SMALL, seed=12)
    assert a.path.read_bytes() == b.path.read_bytes()
    np.testing.assert_array_equal(a.truth_q, b.truth_q)
    fa, fc = _frame(a.path, 0, 0, 128), _frame(c.path, 0, 0, 128)
    assert np.abs(fa.astype(int) - fc).mean() > 5  # another seed, another texture


def test_cache_returns_the_same_walk(tmp_path):
    a = ws.make_synth_walk(tmp_path / "a", **SMALL)
    b = ws.make_synth_walk(tmp_path / "b", **SMALL)
    assert a.path != b.path
    assert a.path.read_bytes() == b.path.read_bytes()
    np.testing.assert_array_equal(a.truth_pos, b.truth_pos)


def test_untextured_walls_are_flat(tmp_path):
    flat = ws.build_synth_walk(tmp_path / "flat", **SMALL, textured=False)
    tex = ws.build_synth_walk(tmp_path / "tex", **SMALL, textured=True)
    for walk, lo, hi in ((flat, 0, 2.0), (tex, 8.0, 255)):
        img = _frame(walk.path, 0, 0, 128).astype(float)
        scene = ws.Scene(seed=7, textured=walk is tex)
        _, face = ws.render_lens(
            scene, walk.lenses[0], 0, 128, walk.truth_pos[0], ws.quat_to_matrix(walk.truth_q[0])
        )
        # the far wall (+y) straight ahead, away from its edges
        sel = face == 3
        sel[1:-1, 1:-1] &= sel[:-2, 1:-1] & sel[2:, 1:-1] & sel[1:-1, :-2] & sel[1:-1, 2:]
        sel[[0, -1], :] = sel[:, [0, -1]] = False
        assert sel.sum() > 50
        assert lo <= img[sel].std() <= hi


def test_no_trailer_gives_a_plain_two_stream_file(tmp_path):
    w = ws.build_synth_walk(tmp_path, **SMALL, trailer=False)
    assert read_trailer(w.path) is None
    assert _streams(w.path) == [(128, 128), (128, 128)]


def test_geometry_floor_below_and_the_box_ahead(walk):
    """Frame 0: level, yaw 0, looking along world +y. Lens 0 sees the floor in its lower half,
    the ceiling in its upper half, and the dark box on the far wall where the projection says;
    lens 1 (looking back) does not see that box there."""
    R = ws.quat_to_matrix(walk.truth_q[0])
    np.testing.assert_allclose(R, ws.R_BASE, atol=1e-12)
    scene = ws.Scene(seed=7, textured=True)
    _, face = ws.render_lens(scene, walk.lenses[0], 0, 640, walk.truth_pos[0], R)
    cx, cy, r = walk.lenses[0]
    assert face[int(cy + 0.6 * r), int(cx)] == 4  # floor
    assert face[int(cy - 0.6 * r), int(cx)] == 5  # ceiling

    box = ws.BOXES[0]
    centre = (np.array(box[0]) + box[1]) / 2
    front = centre.copy()
    front[1] = box[0][1]  # the face towards the camera
    u, v = ws.project(walk.lenses[0], 0, R.T @ (front - walk.truth_pos[0]))
    assert v > cy  # below the horizon, the box is 1.2 m tall and the lens at 1.6 m
    f0 = _frame(walk.path, 0, 0, 640)
    f1 = _frame(walk.path, 1, 0, 640)
    patch0 = f0[round(v) - 2 : round(v) + 3, round(u) - 2 : round(u) + 3]
    patch1 = f1[round(v) - 2 : round(v) + 3, round(u) - 2 : round(u) + 3]
    assert patch0.mean() < 60
    assert patch1.mean() > 60
    assert face[round(v), round(u)] == 6  # box 0
    # the same box seen by lens 1 from the far end of the walk lands where the projection says
    k = len(walk.truth_t) - 1
    Rk = ws.quat_to_matrix(walk.truth_q[k])
    _, face1 = ws.render_lens(scene, walk.lenses[1], 1, 640, walk.truth_pos[k], Rk)
    u1, v1 = ws.project(walk.lenses[1], 1, Rk.T @ (front - walk.truth_pos[k]))
    assert face1[round(v1), round(u1)] == 6


def test_default_walk_builds_in_under_a_minute(tmp_path):
    t0 = time.perf_counter()
    w = ws.build_synth_walk(tmp_path)
    elapsed = time.perf_counter() - t0
    assert w.path.stat().st_size > 100_000
    assert elapsed < 60, f"{elapsed:.1f} s"
