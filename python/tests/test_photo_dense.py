"""photo.products (G3): cameras and sparse models, rectification, semi-global matching, fusion.

Synthetic data only (``products_synth.py``): known cameras, a known surface.
"""

from __future__ import annotations

import math
import struct

import numpy as np
import pytest

import products_synth as ps
from aio_pipelines.photo import dense as D
from aio_pipelines.photo.fuse import (
    FuseSettings,
    PointTiles,
    consistent,
    normals_of,
    voxel_mean,
    world_points,
)
from aio_pipelines.photo.scene import (
    Camera,
    SparseModel,
    View,
    quat_to_r,
    r_to_quat,
    read_model,
    write_text_model,
)
from aio_pipelines.runtime import JobError

CAM = Camera("OPENCV", 480, 360, (380.0, 380.7, 241.3, 179.2, -0.04, 0.008, 0.0004, -0.0003))


def test_lens_distortion_round_trips():
    rng = np.random.default_rng(1)
    u, v = rng.uniform(-0.6, 0.6, 500), rng.uniform(-0.45, 0.45, 500)
    du, dv = CAM.distort(u, v)
    uu, vv = CAM.undistort(du, dv)
    assert np.allclose(uu, u, atol=1e-9) and np.allclose(vv, v, atol=1e-9)


def test_a_scaled_camera_projects_to_scaled_pixels():
    view = View(1, "a.jpg", CAM, ps.nadir_r(10, (2, -1)), np.array([0.5, -0.2, 30.0]))
    pts = np.array([[1.0, 2.0, 0.5], [-4.0, 3.0, -1.0]])
    x, y, _ = view.project(pts)
    half = CAM.scaled(0.5)
    x2, y2, _ = view.project(pts, half)
    assert np.allclose(x2, x * 0.5, atol=1e-9) and np.allclose(y2, y * 0.5, atol=1e-9)
    # a pixel's ray goes back through the point
    ray = CAM.rays(x[:1], y[:1])[0]
    pc = view.to_cam(pts[:1])[0]
    assert np.allclose(ray * pc[2], pc, atol=1e-7)


def test_quaternions_round_trip():
    r = ps.nadir_r(33, (4, -7))
    assert np.allclose(quat_to_r(r_to_quat(r)), r, atol=1e-12)


def _model() -> SparseModel:
    views = [
        View(1, "IMG_1.jpg", CAM, ps.nadir_r(0), -ps.nadir_r(0) @ np.array([0.0, 0.0, 30.0])),
        View(2, "sub/IMG_2.jpg", CAM, ps.nadir_r(5), -ps.nadir_r(5) @ np.array([8.0, 0.0, 30.0])),
    ]
    pts = np.array([[1.0, 2.0, 0.0], [3.0, -1.0, 0.5]])
    return SparseModel(views, pts, np.array([[10, 20, 30], [40, 50, 60]], np.uint8), [[1, 2], [2]])


def test_a_text_model_round_trips(tmp_path):
    m = _model()
    write_text_model(tmp_path / "sparse", m)
    back = read_model(tmp_path / "sparse")
    assert [v.name for v in back.views] == ["IMG_1.jpg", "sub/IMG_2.jpg"]
    assert back.views[1].camera == CAM
    assert np.allclose(back.views[1].r, m.views[1].r) and np.allclose(back.views[1].t, m.views[1].t)
    assert np.allclose(back.points, m.points) and back.tracks == [[1, 2], [2]]


def test_a_binary_model_is_read(tmp_path):
    m = _model()
    folder = tmp_path / "sparse" / "0"
    folder.mkdir(parents=True)
    cams = (
        struct.pack("<Q", 1)
        + struct.pack("<iiQQ", 1, 4, CAM.width, CAM.height)
        + struct.pack("<8d", *CAM.params)
    )
    (folder / "cameras.bin").write_bytes(cams)
    imgs = struct.pack("<Q", 2)
    for v in m.views:
        imgs += struct.pack("<idddddddi", v.id, *r_to_quat(v.r), *v.t, 1) + v.name.encode() + b"\0"
        imgs += struct.pack("<Q", 1) + struct.pack("<ddq", 10.0, 20.0, -1)
    (folder / "images.bin").write_bytes(imgs)
    pts = (
        struct.pack("<Q", 1)
        + struct.pack("<QdddBBBdQ", 7, 1.0, 2.0, 3.0, 9, 8, 7, 0.3, 2)
        + struct.pack("<4i", 1, 0, 2, 0)
    )
    (folder / "points3D.bin").write_bytes(pts)
    back = read_model(tmp_path / "sparse")
    assert [v.name for v in back.views] == ["IMG_1.jpg", "sub/IMG_2.jpg"]
    assert back.views[0].camera == CAM
    assert np.allclose(back.views[1].centre, [8.0, 0.0, 30.0])
    assert back.points.tolist() == [[1.0, 2.0, 3.0]] and back.tracks == [[1, 2]]


def test_a_missing_model_or_camera_is_refused(tmp_path):
    with pytest.raises(JobError, match="no sparse model"):
        read_model(tmp_path)
    with pytest.raises(JobError, match="not supported"):
        Camera("FISHEYE", 10, 10, (1.0,))


def test_rectified_pairs_put_a_point_on_one_row():
    a = View(1, "a", CAM, ps.nadir_r(3, (1, 2)), np.zeros(3))
    a.t = -a.r @ np.array([0.0, 0.0, 34.0])
    b = View(2, "b", CAM, ps.nadir_r(-4, (-1, 1)), np.zeros(3))
    b.t = -b.r @ np.array([6.0, 5.0, 34.5])
    pair = D.RectifiedPair.make(a, b, 1.0)
    rng = np.random.default_rng(2)
    pts = np.column_stack([rng.uniform(-8, 12, 50), rng.uniform(-8, 12, 50), rng.uniform(-1, 6, 50)])
    za = (pts - a.centre) @ pair.r.T
    zb = (pts - b.centre) @ pair.r.T
    ya = pair.f * za[:, 1] / za[:, 2] + pair.cy
    yb = pair.f * zb[:, 1] / zb[:, 2] + pair.cy
    assert np.allclose(ya, yb, atol=1e-6)
    xa = pair.f * za[:, 0] / za[:, 2] + pair.cx - 0.5
    xb = pair.f * zb[:, 0] / zb[:, 2] + pair.cx - 0.5
    d = xa - xb
    back = pair.to_world(xa, ya - 0.5, d)
    assert np.allclose(back, pts, atol=1e-6)
    lo, hi = pair.disparity_range(pts)
    assert lo <= d.min() and d.max() <= hi


def _textured(h: int, w: int, seed: int) -> np.ndarray:
    from scipy import ndimage

    rng = np.random.default_rng(seed)
    return ndimage.gaussian_filter(rng.random((h, w)) * 255, 1.2).astype(np.float32)


def test_sgm_recovers_a_slanted_plane():
    h, w = 120, 200
    right = _textured(h, w, 3)
    # left(x) = right(x - d), d growing from 20 to 30 across the image (a slanted plane)
    xs = np.arange(w, dtype=float)
    disp = 20 + 10 * xs / w
    from scipy import ndimage

    yy, xx = np.mgrid[0:h, 0:w].astype(float)
    left = ndimage.map_coordinates(right, [yy, xx - disp[None, :]], order=1, mode="nearest").astype(
        np.float32
    )
    ok = np.ones((h, w), bool)
    m = D.NumpySgm(D.DenseSettings(speckle=20), 512 * 1024**2)
    d = m.match(left, right, ok, ok, 15, 24, lambda: None)
    sel = np.isfinite(d[:, 40:-10])
    err = np.abs(d[:, 40:-10] - disp[None, 40:-10])[sel]
    assert sel.mean() > 0.9
    assert np.median(err) < 0.25 and np.percentile(err, 95) < 1.0


def test_sgm_in_small_bands_matches_one_band():
    h, w = 160, 140
    right = _textured(h, w, 4)
    from scipy import ndimage

    yy, xx = np.mgrid[0:h, 0:w].astype(float)
    left = ndimage.map_coordinates(right, [yy, xx - 25.0], order=1, mode="nearest").astype(np.float32)
    ok = np.ones((h, w), bool)
    big = D.NumpySgm(D.DenseSettings(), 1024**3).match(left, right, ok, ok, 18, 16, lambda: None)
    # a budget of about 40 rows per band: the image is matched in four overlapping bands
    small = D.NumpySgm(D.DenseSettings(), 40 * w * 16 * 26).match(left, right, ok, ok, 18, 16, lambda: None)
    # left of x = 34 the right image has nothing to match
    big, small = big[:, 40:], small[:, 40:]
    both = np.isfinite(big) & np.isfinite(small)
    assert both.mean() > 0.9
    assert np.mean(np.abs(big[both] - small[both]) < 0.5) > 0.98


def test_speckles_are_removed():
    d = np.full((40, 40), 10.0, np.float32)
    d[5:8, 5:8] = 30.0  # a 9 pixel island
    d[20:, 20:] = np.nan
    out = D.remove_speckles(d, 20)
    assert np.isnan(out[5:8, 5:8]).all()
    assert np.isfinite(out[0, 0]) and np.isfinite(out[30, 10])


def test_the_opencv_matcher_is_used_only_when_available(monkeypatch):
    monkeypatch.setattr(D.OpenCvSgbm, "available", staticmethod(lambda: False))
    assert D.make_matcher(D.DenseSettings(), 10**9).name == "sgm-numpy"


@pytest.mark.skipif(not D.OpenCvSgbm.available(), reason="OpenCV is not installed (G1 builds the pack's own)")
def test_the_opencv_matcher_recovers_a_shift():
    h, w = 120, 200
    right = _textured(h, w, 5)
    from scipy import ndimage

    yy, xx = np.mgrid[0:h, 0:w].astype(float)
    left = ndimage.map_coordinates(right, [yy, xx - 22.0], order=1, mode="nearest").astype(np.float32)
    ok = np.ones((h, w), bool)
    d = D.OpenCvSgbm(D.DenseSettings()).match(left, right, ok, ok, 10, 32, lambda: None)
    sel = np.isfinite(d[:, 60:-10])
    assert sel.mean() > 0.8 and np.median(np.abs(d[:, 60:-10][sel] - 22)) < 0.3


def test_pairs_have_a_useful_baseline_and_overlap():
    s = ps.scene()
    model = ps.sparse_points(s, n=800)
    pairs = D.select_pairs(model, 2)
    assert all(len(p) == 2 for p in pairs.values())
    for vid, partners in pairs.items():
        a = model.view(vid)
        for wid in partners:
            b = model.view(wid)
            assert 0.05 <= np.linalg.norm(b.centre - a.centre) / 34 <= 0.6


def test_a_depth_map_matches_the_true_surface():
    s = ps.scene()
    model = ps.sparse_points(s, n=1500)
    pairs = D.select_pairs(model, 2)
    images = {v.id: img for v, img in zip(s.views, s.images, strict=True)}

    def grey(v):
        return images[v.id].astype(np.float32).mean(axis=2)

    st = D.DenseSettings(scale=1.0)
    ref = model.view(6)
    d, info = D.depth_map(
        ref, [model.view(i) for i in pairs[6]], grey, model, D.NumpySgm(st, 10**9), st, lambda: None
    )
    truth = D.zbuffer(ref.camera, ref, s.points)
    ok = np.isfinite(d) & np.isfinite(truth)
    err = np.abs(d[ok] - truth[ok])
    assert len(info["pairs"]) == 2
    assert ok.sum() / np.isfinite(truth).sum() > 0.8
    assert np.mean(err < 3 * ps.GSD) > 0.95


def test_fusion_keeps_points_other_photos_confirm():
    s = ps.scene()
    a, b = s.views[5], s.views[6]
    cam = a.camera
    da, db = D.zbuffer(cam, a, s.points), D.zbuffer(cam, b, s.points)
    pts, agree = consistent(a, cam, da, [(b, cam, db)], FuseSettings())
    both = np.isfinite(da)
    assert agree[both].mean() > 0.4  # half the photo overlaps its neighbour
    # a depth map pushed 30% further away is confirmed nowhere
    pts, agree = consistent(a, cam, da * 1.3, [(b, cam, db)], FuseSettings())
    assert agree.max() == 0
    # normals of flat ground face up, towards the camera
    n = normals_of(world_points(a, cam, da), a.centre)
    mid = n[150:200, 50:100].reshape(-1, 3)
    assert np.nanmedian(mid[:, 2]) > 0.95


def test_voxel_means_and_tiles(tmp_path):
    xyz = np.array([[0.01, 0.01, 0.0], [0.02, 0.03, 0.01], [5.0, 5.0, 1.0]])
    rgb = np.array([[0, 0, 0], [200, 100, 50], [9, 9, 9]], np.uint8)
    nrm = np.array([[0, 0, 1], [0, 0, 1], [1, 0, 0]], np.float32)
    p, c, n, cnt = voxel_mean(xyz, rgb, nrm, 0.1)
    assert len(p) == 2 and sorted(cnt.tolist()) == [1, 2]
    i = int(np.argmax(cnt))
    assert np.allclose(p[i], [0.015, 0.02, 0.005]) and c[i].tolist() == [100, 50, 25]
    store = PointTiles(tmp_path / "cloud", 4.0)
    store.add("a", xyz, rgb, nrm)
    info = store.merge(0.1)
    assert info["points"] == 2 and info["tiles"] == 2
    box = store.fused_in(-1, -1, 1, 1)
    assert len(box["xyz"]) == 1 and math.isclose(float(box["xyz"][0, 0]), 0.015)


def test_the_cloud_is_written_as_las_tile_by_tile(tmp_path):
    from aio_pipelines.change.las import read_las
    from aio_pipelines.photo.fuse import write_las_tiles

    rng = np.random.default_rng(3)
    xyz = rng.uniform([0, 0, 0], [30, 20, 5], (5000, 3))
    rgb = rng.integers(0, 256, (5000, 3)).astype(np.uint8)
    store = PointTiles(tmp_path / "cloud", 8.0)
    store.add("a", xyz, rgb, np.tile([0, 0, 1], (5000, 1)).astype(np.float32))
    info = store.merge(0.001)
    shift = np.array([412000.0, 3245000.0, 20.0])
    n = write_las_tiles(tmp_path / "c.las", store, shift)
    las = read_las(tmp_path / "c.las")
    assert n == las.count == info["points"] == 5000 and las.pdrf == 7
    # written in the tiles' order, at millimetre resolution
    want = np.concatenate([p["xyz"] for _, p in store.fused()]) + shift
    assert np.abs(las.xyz - want).max() <= 0.0005 + 1e-9
    assert set(np.unique(las.field("Classification"))) == {1}
    assert las.field("Red").max() > 255  # 16-bit colour
