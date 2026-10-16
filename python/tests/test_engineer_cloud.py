"""Bounded crop, ground removal, axis and taper sections of the engineering evidence."""

from __future__ import annotations

import math
import threading
import tracemalloc
from types import SimpleNamespace

import numpy as np
import pytest

from aio_pipelines.engineer.axis import estimate_axis
from aio_pipelines.engineer.cloud import pdal_translate_args, read_region, remove_ground
from aio_pipelines.engineer.sections import fit_sections, fit_taper
from aio_pipelines.pointcloud import find_pdal
from synth_assets import MONOPOLE, STACK, monopole_cloud, radius_at, stack_cloud, write_las

CTX = SimpleNamespace(check=lambda: None)


def _taper_of(cloud, step=2.0):
    kept, _ = remove_ground(cloud, 0.15)
    axis = estimate_axis(kept)
    slices = fit_sections(kept, axis, step)
    return axis, slices, fit_taper(slices)


def _r_at(taper, y):
    return float(np.interp(y, [p[0] for p in taper.profile], [p[1] for p in taper.profile]))


def test_partial_noisy_stack_taper():
    cloud, truth = stack_cloud(seed=7, partial=True, noise=0.03)
    _, slices, taper = _taper_of(cloud)
    for y in (0.0, 30.0, 100.0):
        want = radius_at(truth["profile"], y)
        assert abs(_r_at(taper, y) - want) / want < 0.02, y
    assert len(taper.profile) <= 8
    # the three flues stand above the shaft and are not part of its sections
    assert max(s.y for s in slices) <= STACK["height"] + 1.5
    # 270 degrees seen: the gap is a quarter turn, bins are 10 degrees
    mid = [s for s in slices if 20 < s.y < 100]
    assert mid
    for s in mid:
        assert 0.68 <= s.coverage <= 0.84, (s.y, s.coverage)
        assert s.support > 100 and s.residual_m < 0.1
    full, _ = stack_cloud(seed=7, partial=False, noise=0.03)
    _, full_slices, _ = _taper_of(full)
    assert min(s.coverage for s in full_slices if 20 < s.y < 100) > 0.95


def test_slices_report_height_above_base_and_centre():
    cloud, _ = stack_cloud(seed=2, partial=False, noise=0.02)
    _, slices, _ = _taper_of(cloud)
    assert slices[0].y < 3
    assert all(abs(s.centre[0]) < 0.1 and abs(s.centre[1]) < 0.1 for s in slices)


def test_axis_tilt():
    cloud, _ = stack_cloud(seed=4, partial=True, noise=0.02, ground=False)
    a = math.radians(2.0)
    rot = np.array([[1, 0, 0], [0, math.cos(a), -math.sin(a)], [0, math.sin(a), math.cos(a)]])
    tilted = cloud @ rot.T
    axis = estimate_axis(tilted)
    assert abs(axis.tilt_deg - 2.0) < 0.2
    assert axis.dir[1] > 0 and abs(np.linalg.norm(axis.dir) - 1) < 1e-9
    upright = estimate_axis(cloud)
    assert upright.tilt_deg < 0.2


def test_ground_removed():
    cloud, _ = stack_cloud(seed=3, partial=False, noise=0.02)
    kept, removed = remove_ground(cloud, 0.15)
    assert removed > 5000 and len(kept) + removed == len(cloud)
    # the ground is the plane y = 0 here: nothing within 0.15 m of it is kept
    assert kept[:, 1].min() >= 0.15 - 0.05
    assert (kept[:, 1] > 1).sum() > 0.9 * len(kept)


def test_ground_of_nothing():
    kept, removed = remove_ground(np.zeros((0, 3)), 0.15)
    assert len(kept) == 0 and removed == 0


def test_read_region_las_crop_and_cap(tmp_path):
    cloud, _ = monopole_cloud(seed=1)
    las = write_las(cloud, tmp_path / "m.las", crs_epsg=32633, offset=(400000, 5600000, 10))
    origin = (400000.0, 5600000.0, 10.0)
    region = {"centre": [0.0, 0.0], "radiusM": 3.0}
    xyz, info = read_region(las, "las", region, 1_000_000, CTX, origin=origin)
    want = int((np.hypot(cloud[:, 0], cloud[:, 2]) <= 3.0).sum())
    assert abs(info["read"] - want) <= 5  # millimetre rounding at the edge
    assert info["kept"] == len(xyz) == info["read"]
    assert np.hypot(xyz[:, 0], xyz[:, 2]).max() <= 3.0 + 0.002
    assert np.allclose(
        np.sort(xyz[:, 1])[[0, -1]],
        np.sort(cloud[np.hypot(cloud[:, 0], cloud[:, 2]) <= 3.0][:, 1])[[0, -1]],
        atol=0.002,
    )
    assert info["crs"] == {"epsg": 32633}
    assert info["bounds"]["min"][1] <= info["bounds"]["max"][1]
    capped, info2 = read_region(las, "las", region, 500, CTX, origin=origin, seed=3)
    again, _ = read_region(las, "las", region, 500, CTX, origin=origin, seed=3)
    assert info2["kept"] == len(capped) == 500 and info2["read"] == info["read"]
    assert np.array_equal(capped, again)
    box = {"min": [-1.0, 0.0, -1.0], "max": [1.0, 5.0, 1.0]}
    inbox, binfo = read_region(las, "las", box, 1_000_000, CTX, origin=origin)
    assert inbox[:, 1].max() <= 5.001 and np.abs(inbox[:, [0, 2]]).max() <= 1.001
    assert binfo["read"] == len(inbox)
    whole, winfo = read_region(las, "las", None, 1_000_000, CTX, origin=origin)
    assert winfo["read"] == len(cloud) == len(whole)


def test_read_region_carries_colour_when_the_cloud_has_it(tmp_path):
    cloud, _ = monopole_cloud(seed=1)
    rgb = np.column_stack(
        [
            (cloud[:, 1] * 8).astype(np.uint8),
            np.full(len(cloud), 90, np.uint8),
            np.zeros(len(cloud), np.uint8),
        ]
    )
    origin = (400000.0, 5600000.0, 10.0)
    las = write_las(cloud, tmp_path / "c.las", offset=origin, rgb=rgb)
    region = {"centre": [0.0, 0.0], "radiusM": 3.0}
    xyz, info = read_region(las, "las", region, 1_000_000, CTX, origin=origin)
    assert info["rgb"] is not None and info["rgb"].dtype == np.uint8 and info["rgb"].shape == (len(xyz), 3)
    # the colour belongs to its point: red follows height
    assert np.abs(info["rgb"][:, 0].astype(float) - np.clip(xyz[:, 1] * 8, 0, 255)).max() <= 9
    assert (info["rgb"][:, 1] == 90).all()
    capped, info2 = read_region(las, "las", region, 400, CTX, origin=origin, seed=2)
    assert info2["rgb"].shape == (400, 3)
    assert np.abs(info2["rgb"][:, 0].astype(float) - np.clip(capped[:, 1] * 8, 0, 255)).max() <= 9
    plain = write_las(cloud, tmp_path / "p.las", offset=origin)
    assert read_region(plain, "las", region, 1000, CTX, origin=origin)[1]["rgb"] is None


def test_read_region_without_crs_or_las_is_an_error(tmp_path):
    bad = tmp_path / "x.las"
    bad.write_bytes(b"not a las file" * 40)
    with pytest.raises(Exception, match="LAS"):
        read_region(bad, "las", None, 1000, CTX)
    with pytest.raises(Exception, match="format"):
        read_region(bad, "e57", None, 1000, CTX)


def test_large_cloud_bounded(tmp_path):
    n = 5_000_000
    rng = np.random.default_rng(0)
    pts = np.column_stack([rng.uniform(-50, 50, n), rng.uniform(0, 30, n), rng.uniform(-50, 50, n)])
    las = write_las(pts, tmp_path / "big.las", offset=(500000.0, 4000000.0, 0.0))
    want = int(((pts[:, 0] >= -50) & (pts[:, 0] <= -40)).sum())  # 10 percent
    del pts
    region = {"min": [-50.0, -1.0, -50.0], "max": [-40.0, 40.0, 50.0]}
    tracemalloc.start()
    xyz, info = read_region(las, "las", region, 200_000, CTX, origin=(500000.0, 4000000.0, 0.0))
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    assert abs(info["read"] - want) < 0.001 * n
    assert 0.09 * n < info["read"] < 0.11 * n
    assert info["kept"] == len(xyz) <= 200_000
    assert peak < 600 * 1024 * 1024
    assert xyz[:, 0].max() <= -40 + 0.002


@pytest.mark.skipif(find_pdal() is None, reason="PDAL not found (set AIO_PDAL)")
def test_read_region_copc_through_pdal(tmp_path):  # pragma: no cover - needs PDAL
    import subprocess

    cloud, _ = monopole_cloud(seed=1)
    las = write_las(cloud, tmp_path / "m.las", offset=(400000.0, 5600000.0, 0.0))
    copc = tmp_path / "m.copc.laz"
    subprocess.run([find_pdal(), "translate", str(las), str(copc), "--writers.copc.forward=all"], check=True)
    job = SimpleNamespace(dir=tmp_path)
    ctx = SimpleNamespace(
        check=lambda: None, job=job, cancel_event=threading.Event(), progress=lambda *_a: None
    )
    region = {"centre": [0.0, 0.0], "radiusM": 3.0}
    xyz, info = read_region(copc, "copc", region, 1_000_000, ctx, origin=(400000.0, 5600000.0, 0.0))
    assert info["read"] == len(xyz) > 0
    assert np.hypot(xyz[:, 0], xyz[:, 2]).max() <= 3.002
    assert MONOPOLE["height"] > 0

def test_read_region_carries_the_offset(tmp_path):
    cloud, _ = monopole_cloud(seed=1)
    origin = (400000.0, 5600000.0, 10.0)
    las = write_las(cloud, tmp_path / "o.las", crs_epsg=32633, offset=origin)
    plain, _ = read_region(las, "las", None, 1_000_000, CTX, origin=origin)
    lifted, info = read_region(las, "las", None, 1_000_000, CTX, origin=origin, offset_m=5.0)
    assert np.allclose(lifted[:, 1], plain[:, 1] + 5.0, atol=1e-9)
    assert info["bounds"]["min"][1] == pytest.approx(plain[:, 1].min() + 5.0)
    # a box in drawn heights picks the points that were 5 m lower in the file
    box = {"min": [-1.0, 5.0, -1.0], "max": [1.0, 10.0, 1.0]}
    inbox, _ = read_region(las, "las", box, 1_000_000, CTX, origin=origin, offset_m=5.0)
    file_box = {"min": [-1.0, 0.0, -1.0], "max": [1.0, 5.0, 1.0]}
    same, _ = read_region(las, "las", file_box, 1_000_000, CTX, origin=origin)
    assert len(inbox) == len(same) > 0
    # the PDAL bounds query is in file heights
    args = pdal_translate_args("pdal", "a.copc.laz", "o.las", "copc", box, origin, 5.0)
    assert "[10.0,15.0])" in args[-1].replace(" ", "")
    plain_args = pdal_translate_args("pdal", "a.copc.laz", "o.las", "copc", box, origin)
    assert "[15.0,20.0])" in plain_args[-1].replace(" ", "")
