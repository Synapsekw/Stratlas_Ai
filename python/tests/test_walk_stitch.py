"""Fisheye map, stitcher and ffmpeg helpers (aio_pipelines.walk.lens, .stitch, .ffmpeg).

Geometry is checked against the camera frame (x right, y down, z forward) and the lens convention:
lens 0 looks along +z and is the left half of the side-by-side frame, lens 1 looks along -z and is
the right half; image x is camera +x for lens 0 and camera -x for lens 1, image y is camera +y."""

from __future__ import annotations

import math
import os
import subprocess
import sys
import time
import warnings
from pathlib import Path

import numpy as np
import pytest

from aio_pipelines.photo import native
from aio_pipelines.runtime import Cancelled
from aio_pipelines.walk import ffmpeg as ff
from aio_pipelines.walk import lens as L
from aio_pipelines.walk import stitch as S
from aio_pipelines.walk.calib import Lens, default_lenses


def rz(deg: float) -> np.ndarray:
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])


def ry(deg: float) -> np.ndarray:
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]])


# --- geometry -------------------------------------------------------------------------------


def test_equirect_dirs_centre_and_top_row():
    d = L.equirect_dirs(64, 32)
    assert d.shape == (32, 64, 3)
    np.testing.assert_allclose(np.linalg.norm(d, axis=2), 1.0, atol=1e-6)
    # The four pixels around the picture centre straddle (0, 0, 1).
    centre = d[15:17, 31:33].reshape(-1, 3).mean(axis=0)
    np.testing.assert_allclose(centre / np.linalg.norm(centre), [0.0, 0.0, 1.0], atol=1e-6)
    # Top row is up (-y), bottom row down (+y), within half a pixel of the pole.
    assert np.all(d[0, :, 1] < -math.cos(math.pi / 32) + 1e-6)
    assert np.all(d[-1, :, 1] > math.cos(math.pi / 32) - 1e-6)
    # Right of centre is camera +x; the left and right edges look backward.
    assert d[16, 48, 0] > 0.99
    assert d[16, 0, 2] < -0.99 and d[16, -1, 2] < -0.99


def test_lens_axis_maps_to_lens_centre():
    lens0 = Lens(cx=310.0, cy=330.0, radius=300.0, fov_deg=195.0)
    lens1 = Lens(cx=325.0, cy=315.0, radius=300.0, fov_deg=195.0)
    x, y = L.project(lens0, 0, np.array([[0.0, 0.0, 1.0]]))
    assert (x[0], y[0]) == pytest.approx((310.0, 330.0))
    x, y = L.project(lens1, 1, np.array([[0.0, 0.0, -1.0]]))
    assert (x[0], y[0]) == pytest.approx((325.0, 315.0))


def test_lens_image_axes_follow_the_convention():
    lens = Lens(cx=320.0, cy=320.0, radius=320.0, fov_deg=195.0)
    right_down = np.array([[0.1, 0.1, 1.0]])
    x, y = L.project(lens, 0, right_down / np.linalg.norm(right_down))
    assert x[0] > 320 and y[0] > 320  # lens 0: camera +x is image right
    back_right_down = np.array([[0.1, 0.1, -1.0]])
    x, y = L.project(lens, 1, back_right_down / np.linalg.norm(back_right_down))
    assert x[0] < 320 and y[0] > 320  # lens 1: camera +x is image left


def test_edge_of_field_lands_on_the_circle():
    lens = Lens(cx=320.0, cy=320.0, radius=320.0, fov_deg=195.0)
    a = math.radians(97.5)
    for phi in (0.0, 0.7, 2.0, -1.2):
        d = np.array([[math.sin(a) * math.cos(phi), math.sin(a) * math.sin(phi), math.cos(a)]])
        x, y = L.project(lens, 0, d)
        assert math.hypot(x[0] - 320, y[0] - 320) == pytest.approx(320.0, abs=1e-6)
        x, y = L.project(lens, 1, d * np.array([1.0, 1.0, -1.0]))
        assert math.hypot(x[0] - 320, y[0] - 320) == pytest.approx(320.0, abs=1e-6)


def test_dual_map_centre_and_back_pixels():
    lenses = default_lenses(256, 256)
    mx, my, w = L.dual_fisheye_map(lenses, 256, 512, 256, map_scale=1)
    assert mx.shape == my.shape == (2, 256, 512) and w.shape == (256, 512)
    assert mx.dtype == np.float32 and w.dtype == np.float32
    # Picture centre: lens 0's centre in the left half.
    assert mx[0, 127:129, 255:257].mean() == pytest.approx(128.0 - 0.5, abs=0.6)
    assert my[0, 127:129, 255:257].mean() == pytest.approx(128.0 - 0.5, abs=0.6)
    assert w[128, 256] == 1.0
    # The left edge looks backward: lens 1's centre in the right half, weight 0.
    assert mx[1, 128, 0] == pytest.approx(256 + 128.0 - 0.5, abs=2.0)
    assert w[128, 0] == 0.0


def test_seam_weight_is_half_on_the_meridian_and_feathered_over_4_degrees():
    lenses = default_lenses(256, 256)
    _, _, w = L.dual_fisheye_map(lenses, 256, 3600, 1800, map_scale=1)
    row = w[900]
    # Columns: lon = ((j + 0.5) / 3600 - 0.5) * 360 degrees; 10 columns per degree.
    lon = (np.arange(3600) + 0.5) / 10.0 - 180.0
    assert np.interp(90.0, lon, row) == pytest.approx(0.5, abs=0.01)
    assert np.interp(-90.0, lon, row) == pytest.approx(0.5, abs=0.01)
    assert np.all(row[np.abs(lon) < 88.0] == 1.0)
    assert np.all(row[np.abs(lon) > 92.0] == 0.0)
    band = (np.abs(lon) > 88.2) & (np.abs(lon) < 91.8)
    assert np.all((row[band] > 0.0) & (row[band] < 1.0))


@pytest.mark.parametrize("rotated", [False, True])
def test_quarter_size_map_matches_full_size(rotated):
    lenses = (
        Lens(cx=318.0, cy=323.0, radius=322.0, fov_deg=195.0, yaw_deg=0.3, pitch_deg=-0.4),
        Lens(cx=322.0, cy=317.0, radius=321.0, fov_deg=195.0, roll_deg=0.5),
    )
    rot = rz(8.0) @ ry(5.0) if rotated else None
    full = L.dual_fisheye_map(lenses, 640, 1184, 592, rotation=rot, map_scale=1)
    quarter = L.dual_fisheye_map(lenses, 640, 1184, 592, rotation=rot, map_scale=4)
    w = full[2]
    for k, used in ((0, w > 0), (1, w < 1)):
        err = np.hypot(full[0][k] - quarter[0][k], full[1][k] - quarter[1][k])[used]
        assert err.max() < 0.25, (k, err.max())
    assert np.abs(full[2] - quarter[2]).max() < 0.1


def test_roll_rotation_moves_a_point_as_expected():
    lenses = default_lenses(640, 640)
    rot = rz(10.0)  # camera rolled 10 degrees (x towards y) relative to the levelled frame
    mx, my, _ = L.dual_fisheye_map(lenses, 640, 1440, 720, rotation=rot, map_scale=1)
    # Output pixel at lat 0, lon 45 degrees (column (45 + 180) * 4 - 0.5 sits between two pixels).
    j, i = 899, 359
    d = L.equirect_dirs(1440, 720)[i, j]
    src = rot.T @ d
    ex, ey = L.project(lenses[0], 0, src[None, :])
    # The map is in remap's pixel-centre coordinates, half a pixel less than project's.
    assert (mx[0, i, j] + 0.5, my[0, i, j] + 0.5) == pytest.approx((ex[0], ey[0]), abs=1e-3)
    # The point moved up: the angle from the lens centre is the roll, against the image's x axis.
    ang = math.degrees(math.atan2(my[0, i, j] - 319.5, mx[0, i, j] - 319.5))
    assert ang == pytest.approx(-10.0, abs=0.3)


def test_equirect_rotate_map_identity_and_yaw():
    mx, my = L.equirect_rotate_map(720, 360, np.eye(3), map_scale=1)
    jj, ii = np.meshgrid(np.arange(720), np.arange(360))
    np.testing.assert_allclose(mx, jj, atol=1e-3)
    np.testing.assert_allclose(my, ii, atol=1e-3)
    # A camera turned 90 degrees right (about y down): what was right of centre is now ahead.
    mx, my = L.equirect_rotate_map(720, 360, ry(90.0), map_scale=4)
    # Output centre samples the source 90 degrees to one side (a quarter of the width away).
    assert abs(float(mx[180, 360]) - 360.0) == pytest.approx(180.0, abs=0.6)


def test_per_frame_map_and_remap_time():
    lenses = default_lenses(2880, 2880)
    frame = np.random.default_rng(1).integers(0, 255, (2880, 5760, 3), dtype=np.uint8)
    stitcher = S.Stitcher("insv-dual-stream", lenses, 2880, 3840, 1920)
    stitcher.apply(frame, rz(1.0))  # warm up
    t0 = time.perf_counter()
    out = stitcher.apply(frame, rz(3.0))
    ms = (time.perf_counter() - t0) * 1000.0
    assert out.shape == (1920, 3840, 3)
    print(f"per-frame map + remap at 3840 x 1920: {ms:.1f} ms")
    if ms > 60.0:
        warnings.warn(f"per-frame map + remap took {ms:.0f} ms (budget 60 ms)", stacklevel=1)


def test_output_fps_takes_every_kth_source_frame():
    assert S.output_fps(30.0, 60000 / 1001) == pytest.approx(30000 / 1001)
    assert S.output_fps(60.0, 60.0) == pytest.approx(30.0)
    assert S.output_fps(10.0, 20.0) == pytest.approx(10.0)
    assert S.output_fps(0.0, 25.0) == pytest.approx(25.0)
    assert S.output_fps(24.0, 25.0) == pytest.approx(12.5)
    assert S.output_fps(15.0, None) == pytest.approx(15.0)


def test_stitch_output_size():
    assert S.output_size(default_lenses(2880, 2880)[0]) == (3840, 1920)
    w, h = S.output_size(default_lenses(640, 640)[0])
    assert w == 2 * h and w % 32 == 0 and 1100 < w < 1250


# --- ffmpeg ---------------------------------------------------------------------------------


def test_encode_args_are_the_playback_copy_settings():
    args = ff.encode_args("out.mp4", 3840, 1920, 29.97, None)
    s = " ".join(args)
    assert "-pix_fmt yuv420p" in s
    assert "+faststart" in s
    assert "-c:v libx264" in s
    assert args[args.index("-g") + 1] == "15"  # a keyframe every 0.5 s at 29.97 fps
    assert args[args.index("-maxrate") + 1] == "16M"
    assert "-s 3840x1920" in s and "bgr24" in s and args[-1] == "out.mp4"
    assert "-c:a" not in args
    with_audio = ff.encode_args("out.mp4", 1920, 960, 30.0, "src.insv")
    assert "src.insv" in with_audio and "aac" in with_audio
    assert with_audio[with_audio.index("-ac") + 1] == "2"


def test_decode_args():
    two = ff.decode_args("a.insv", "insv-dual-stream", 29.97, 5.0)
    s = " ".join(two)
    assert "hstack" in s and "[0:v:0]" in s and "[0:v:1]" in s and "fps=" in s
    assert two[two.index("-t") + 1] == "5"
    assert two.index("-t") < two.index("-i")
    assert two[-1] == "pipe:1" and "bgr24" in two and "rawvideo" in two
    one = ff.decode_args("a.mp4", "equirect", 30.0, None)
    assert "hstack" not in " ".join(one) and "-t" not in one


def test_find_ffmpeg_order(tmp_path, monkeypatch):
    exe = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
    env_tool = tmp_path / "env" / exe
    env_tool.parent.mkdir()
    env_tool.write_bytes(b"")
    pack = tmp_path / "pack"
    (pack / "python").mkdir(parents=True)
    lib = pack / "tools" / "ffmpeg" / "Library" / "bin" / exe
    binp = pack / "tools" / "ffmpeg" / "bin" / exe
    monkeypatch.setattr(sys, "prefix", str(pack / "python"))
    monkeypatch.setattr(native.shutil, "which", lambda name: f"/on/path/{name}")

    monkeypatch.setenv("QUADRION_FFMPEG", str(env_tool))
    assert ff.find_ffmpeg() == str(env_tool)
    monkeypatch.delenv("QUADRION_FFMPEG")
    assert ff.find_ffmpeg() == "/on/path/ffmpeg"
    binp.parent.mkdir(parents=True)
    binp.write_bytes(b"")
    assert ff.find_ffmpeg() == str(binp)
    lib.parent.mkdir(parents=True)
    lib.write_bytes(b"")
    assert ff.find_ffmpeg() == str(lib)
    monkeypatch.setattr(native.shutil, "which", lambda name: None)
    lib.unlink()
    binp.unlink()
    assert ff.find_ffmpeg() is None
    assert "ffmpeg" in ff.FFMPEG_MISSING


# --- run_frames on a tiny clip --------------------------------------------------------------


def _ffmpeg_or_skip() -> str:
    exe = ff.find_ffmpeg()
    if exe is None:
        if os.environ.get("CI"):
            pytest.fail("ffmpeg is needed in CI (QUADRION_FFMPEG or the PATH)")
        pytest.skip("no ffmpeg on this machine")
    return exe


def _two_stream_clip(exe: str, path: Path, seconds: float, rate: int) -> None:
    src = f"testsrc=size=128x128:rate={rate}:duration={seconds}"
    src2 = f"testsrc2=size=128x128:rate={rate}:duration={seconds}"
    subprocess.run(
        [exe, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", src, "-f", "lavfi", "-i", src2,
         "-map", "0:v", "-map", "1:v", "-c:v", "mpeg4", "-q:v", "3", str(path)],
        check=True,
    )  # fmt: skip


def test_run_frames_two_stream_clip(tmp_path):
    exe = _ffmpeg_or_skip()
    clip = tmp_path / "clip.mp4"
    _two_stream_clip(exe, clip, 1.0, 20)
    seen: list[tuple[int, float, tuple[int, ...]]] = []
    fracs: list[float] = []
    out = tmp_path / "out.mp4"
    res = S.run_frames(
        [str(clip)], "insv-dual-stream", None, 10.0, None, out,
        [S.FrameSink(lambda i, t, f: seen.append((i, t, f.shape)))], lambda: None, fracs.append,
    )  # fmt: skip
    assert res["frames"] == 10 and res["fps"] == pytest.approx(10.0)
    w, h = res["width"], res["height"]
    assert w == 2 * h
    assert [s[0] for s in seen] == list(range(10))
    assert [s[1] for s in seen] == pytest.approx([i / 10.0 for i in range(10)])
    assert all(s[2] == (h, w, 3) for s in seen)
    assert fracs and fracs[-1] == pytest.approx(1.0) and all(0 <= f <= 1 for f in fracs)
    info = ff.probe(str(out))
    v = [st for st in info["streams"] if st["type"] == "video"]
    assert (v[0]["width"], v[0]["height"]) == (w, h)
    assert info["frames"] in (None, 10)


def test_run_frames_chapters_levelled_and_cancel(tmp_path):
    exe = _ffmpeg_or_skip()
    a, b = tmp_path / "a.mp4", tmp_path / "b.mp4"
    _two_stream_clip(exe, a, 0.5, 10)
    _two_stream_clip(exe, b, 0.5, 10)
    times: list[float] = []
    res = S.run_frames(
        [str(a), str(b)], "insv-dual-stream", None, 10.0, lambda t: rz(5.0 * t), None,
        [S.FrameSink(lambda i, t, f: times.append(t))], lambda: None, lambda f: None,
    )  # fmt: skip
    assert res["frames"] == 10
    assert times == pytest.approx([i / 10.0 for i in range(10)])

    calls = {"n": 0}

    def check():
        calls["n"] += 1
        if calls["n"] > 3:
            raise Cancelled()

    with pytest.raises(Cancelled):
        S.run_frames(
            [str(a)], "insv-dual-stream", None, 10.0, None, tmp_path / "c.mp4", [], check, lambda f: None
        )


def test_run_frames_caps_a_fast_source_at_30_fps(tmp_path):
    exe = _ffmpeg_or_skip()
    clip = tmp_path / "fast.mp4"
    _two_stream_clip(exe, clip, 0.5, 60)
    res = S.run_frames(
        [str(clip)], "insv-dual-stream", None, 60.0, None, None, [], lambda: None, lambda f: None
    )
    assert res["fps"] == pytest.approx(30.0)
    assert res["frames"] == 15
