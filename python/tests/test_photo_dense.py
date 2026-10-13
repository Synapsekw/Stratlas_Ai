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
    CHUNK_FORMAT,
    DENSE_RULE,
    SPARSE_RULE,
    FuseSettings,
    MergeRule,
    PointTiles,
    agree_limit,
    collapse_columns,
    consistent,
    normals_of,
    outlier_mask,
    pack_chunk,
    unpack_chunk,
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


def test_fusion_v2_asks_two_photos_to_agree_within_three_gsd():
    v2 = FuseSettings.for_run(0.02, 0.5)  # the founder's run: GSD 2 cm, matching at half size
    assert v2.min_agree == 2 and v2.abs_tol == pytest.approx(0.12)
    # 1 % of the depth up to 12 cm: 10 cm at 10 m, 12 cm from 12 m on
    np.testing.assert_allclose(agree_limit(np.array([10.0, 34.0, 100.0]), v2), [0.1, 0.12, 0.12])
    assert FuseSettings.for_run(0.02, 0.0).abs_tol == math.inf  # Fast: no dense matching
    assert FuseSettings().min_agree == 2


def test_fusion_is_edge_aware():
    s = ps.scene()
    a, b, c = s.views[5], s.views[6], s.views[4]
    cam = a.camera
    da = D.zbuffer(cam, a, s.points)
    db, dc = D.zbuffer(cam, b, s.points), D.zbuffer(cam, c, s.points)
    ok = np.isfinite(da)
    # one neighbour with depth there, and it agrees: kept (the block's edge)
    _, one = consistent(a, cam, da, [(b, cam, db)], FuseSettings())
    assert (one[ok & (one >= 1)] >= 2).all() and (one >= 2).sum() > 1000
    # two neighbours with depth there, only one agrees: dropped
    far = np.where(np.isfinite(dc), dc * 1.3, dc)
    _, two = consistent(a, cam, da, [(b, cam, db), (c, cam, far)], FuseSettings())
    assert ((one >= 2) & (two < 2)).sum() > 1000  # where both can check, the disagreeing one vetoes
    assert (two >= 2).sum() < (one >= 2).sum() and (two >= 2).any()  # but the edge pixels stay
    # no neighbour sees it: dropped
    _, agree = consistent(a, cam, da, [], FuseSettings())
    assert agree.max() == 0


def test_a_chunk_round_trips_within_a_tenth_of_a_millimetre():
    rng = np.random.default_rng(4)
    n = 10_000
    # a 41 m tile far from the origin, at 1,800 m elevation: the worst case for float32
    xyz = np.column_stack(
        [rng.uniform(4100.0, 4141.0, n), rng.uniform(-8200.0, -8159.0, n), rng.uniform(1800.0, 1900.0, n)]
    )
    nrm = rng.normal(size=(n, 3))
    nrm /= np.linalg.norm(nrm, axis=1, keepdims=True)
    rgb = rng.integers(0, 256, (n, 3)).astype(np.uint8)
    packed = pack_chunk(xyz, rgb, nrm, (4100.0, -8200.0))
    assert int(packed["format"]) == CHUNK_FORMAT == 2
    assert sum(packed[k].nbytes for k in ("xy", "z", "normal", "rgb")) == 18 * n
    back, back_rgb, back_n = unpack_chunk(packed)
    assert np.abs(back - xyz).max() < 1e-4
    assert np.array_equal(back_rgb, rgb) and back_n.dtype == np.float32
    assert np.abs(back_n - nrm).max() <= 0.5 / 127 + 1e-6


def test_fusion_writes_chunk_format_2(tmp_path):
    store = PointTiles(tmp_path / "m", 4.0, chunks=tmp_path / "c" / "chunks")
    xyz = np.array([[0.5, 0.5, 1.0], [5.0, 0.5, 2.0], [5.5, 0.7, 2.5]])
    store.add("v1", xyz, np.zeros((3, 3), np.uint8), np.tile(np.float32([0, 0, 1]), (3, 1)))
    assert store.chunk_tiles() == ["0_0", "1_0"]
    with np.load(tmp_path / "c" / "chunks" / "1_0" / "v1.npz") as f:
        assert f["xy"].dtype == np.float32 and f["normal"].dtype == np.int8
        got, _, nrm = unpack_chunk(f)
    np.testing.assert_allclose(got, xyz[1:], atol=1e-6)
    np.testing.assert_allclose(nrm, [[0, 0, 1], [0, 0, 1]])
    assert not (tmp_path / "m" / "chunks").exists()


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
    info = store.merge(0.1, rule=SPARSE_RULE)
    assert info["points"] == 2 and info["tiles"] == 2
    box = store.fused_in(-1, -1, 1, 1)
    assert len(box["xyz"]) == 1 and math.isclose(float(box["xyz"][0, 0]), 0.015, abs_tol=1e-6)


def test_pixel_directions_are_worked_out_once_per_camera(monkeypatch):
    from aio_pipelines.photo import scene as S

    s = ps.scene()
    a, b = s.views[5], s.views[6]
    cam = a.camera
    da, db = D.zbuffer(cam, a, s.points), D.zbuffer(cam, b, s.points)
    want = world_points(a, cam, da, cam.pixel_rays())
    calls = []
    real = S.Camera.pixel_rays
    monkeypatch.setattr(S.Camera, "pixel_rays", lambda self: calls.append(1) or real(self))
    S.pixel_rays.cache_clear()
    got_a = world_points(a, cam, da)
    world_points(b, cam, db)
    assert len(calls) == 1
    np.testing.assert_array_equal(got_a, want)
    assert not S.pixel_rays(cam).flags.writeable


def test_a_chunk_of_an_older_format_is_refused():
    packed = pack_chunk(np.zeros((2, 3)), np.zeros((2, 3), np.uint8), np.zeros((2, 3)), (0.0, 0.0))
    old = {k: v for k, v in packed.items() if k != "format"}
    with pytest.raises(JobError, match="older format"):
        unpack_chunk(old)
    with pytest.raises(JobError, match="older format"):
        unpack_chunk({**packed, "format": np.array(1, np.int16)})


def _up(n: int) -> np.ndarray:
    return np.tile(np.float32([0, 0, 1]), (n, 1))


def test_the_merge_rules():
    assert MergeRule() == DENSE_RULE and DENSE_RULE.min_count == 2 and DENSE_RULE.outliers
    # version 3: seen twice is counted per collapsed column bin (a new merge key, nothing reused)
    assert (DENSE_RULE.k, DENSE_RULE.sigma, DENSE_RULE.version) == (16, 2.5, 3)
    assert SPARSE_RULE.min_count == 1 and not SPARSE_RULE.outliers and not SPARSE_RULE.collapse


def test_a_roof_over_the_ground_keeps_two_points():
    xyz = np.array([[0.05, 0.05, 0.00], [0.05, 0.05, 0.12], [0.05, 0.05, 5.00], [0.05, 0.05, 5.15]])
    p, _, _, k = collapse_columns(
        xyz, np.zeros((4, 3), np.uint8), _up(4), np.array([3, 2, 4, 1], np.int32), 0.1
    )
    assert len(p) == 2 and k.tolist() == [5, 5]
    assert p[0, 2] == pytest.approx(0.048) and p[1, 2] == pytest.approx(5.03)


def test_a_noisy_flat_surface_is_one_point_per_column():
    rng = np.random.default_rng(7)
    xyz = np.column_stack([rng.uniform(0, 1.0, (5000, 2)), rng.uniform(0, 0.15, 5000)])
    p, _, n, k = collapse_columns(xyz, np.zeros((5000, 3), np.uint8), _up(5000), np.ones(5000, np.int32), 0.1)
    assert len(p) == 100 and k.sum() == 5000 and np.allclose(n, [0, 0, 1])


def test_a_wall_keeps_its_height():
    z = np.arange(31) * 0.1 + 0.01
    xyz = np.column_stack([np.full(31, 0.05), np.full(31, 0.05), z])
    p, _, _, _ = collapse_columns(xyz, np.zeros((31, 3), np.uint8), _up(31), np.ones(31, np.int32), 0.1)
    assert len(p) == 16 and p[:, 2].min() < 0.1 and p[:, 2].max() > 2.9


def test_voxels_seen_once_are_dropped(tmp_path):
    store = PointTiles(tmp_path / "m", 4.0)
    xyz = np.array([[0.01, 0.01, 0.0], [0.02, 0.03, 0.01], [0.03, 0.02, 0.02], [2.0, 2.0, 1.0]])
    store.add("a", xyz, np.zeros((4, 3), np.uint8), _up(4))
    info = store.merge(0.1, rule=MergeRule(outliers=False))
    assert info["points"] == 1 and info["counts"] == {"0_0": 1} and info["rule"]["version"] == 3


def test_seen_twice_counts_per_column_bin(tmp_path):
    """Depth noise spreads one surface over two voxels of height: each voxel is hit once, but each
    column of the surface is seen twice, so every column stays. A column with one raw point goes."""
    g = np.arange(20) * 0.1 + 0.05
    gx, gy = np.meshgrid(g, g)
    cols = np.column_stack([gx.ravel(), gy.ravel()])
    low = np.column_stack([cols, np.full(len(cols), 0.02)])
    high = np.column_stack([cols, np.full(len(cols), 0.12)])
    xyz = np.concatenate([low, high, [[3.05, 3.05, 0.02]]])
    store = PointTiles(tmp_path / "m", 4.0)
    store.add("a", xyz, np.zeros((len(xyz), 3), np.uint8), _up(len(xyz)))
    info = store.merge(0.1, rule=MergeRule(outliers=False))
    assert info["points"] == 400
    pts = store.fused_in(0, 0, 4, 4)
    assert pts["xyz"][:, :2].max() < 2.0 and (pts["count"] == 2).all()


def test_the_sparse_rule_keeps_every_point(tmp_path):
    rng = np.random.default_rng(8)
    xyz = np.column_stack([rng.uniform(0, 30, 400), rng.uniform(0, 30, 400), rng.uniform(0, 3, 400)])
    store = PointTiles(tmp_path / "m", 8.0)
    store.add("sparse", xyz, np.zeros((400, 3), np.uint8), _up(400))
    assert store.merge(0.01, rule=SPARSE_RULE)["points"] == 400


def test_the_sparse_rule_keeps_stacked_points_at_the_fast_spacing(tmp_path):
    """Fast merges at the photo GSD: sparse points one above another in a column of voxels (a
    facade, a pole) less than two GSD apart stay separate points, and so does a lone one."""
    gsd = 0.03
    rng = np.random.default_rng(9)
    cols = (np.floor(rng.uniform(0, 20, (50, 2)) / gsd) + 0.5) * gsd  # voxel column centres
    stacks = np.column_stack([np.repeat(cols, 5, axis=0), np.tile(np.arange(5) * 1.4 * gsd + 0.001, 50)])
    xyz = np.concatenate([stacks, [[10.015, 10.015, 8.0]]])
    rgb, nrm = np.zeros((len(xyz), 3), np.uint8), _up(len(xyz))
    fast = PointTiles(tmp_path / "fast", 8.0)
    fast.add("sparse", xyz, rgb, nrm)
    assert fast.merge(gsd, rule=SPARSE_RULE)["points"] == len(xyz) == 251
    collapsed = PointTiles(tmp_path / "collapsed", 8.0)
    collapsed.add("sparse", xyz, rgb, nrm)
    assert collapsed.merge(gsd, rule=MergeRule(min_count=1, outliers=False))["points"] == 151


def _sheet(x1: float, y1: float, step: float = 0.1, seed: int = 1) -> np.ndarray:
    """A jittered flat sheet, one point per ``step`` cell."""
    rng = np.random.default_rng(seed)
    gx, gy = np.meshgrid(np.arange(step / 2, x1, step), np.arange(step / 2, y1, step))
    xyz = np.column_stack([gx.ravel(), gy.ravel(), np.zeros(gx.size)])
    xyz[:, :2] += rng.uniform(-0.02, 0.02, (len(xyz), 2))
    xyz[:, 2] += rng.uniform(-0.01, 0.01, len(xyz))
    return xyz


def test_the_outlier_filter_drops_a_floating_point_and_keeps_the_seams(tmp_path):
    sheet = _sheet(10.0, 10.0)
    pts = np.concatenate([sheet, [[5.0, 5.0, 4.0], [5.05, 5.0, 4.0]]])
    store = PointTiles(tmp_path / "m", 5.0)  # four tiles meeting at x = 5 and y = 5
    store.add("a", pts, np.zeros((len(pts), 3), np.uint8), _up(len(pts)))
    store.merge(0.1, rule=MergeRule(min_count=1))
    out = np.concatenate([p["xyz"] for _, p in store.fused()])
    assert not (out[:, 2] > 1).any()  # the floating pair is gone

    def inner(a):
        return (a[:, :2].min(1) > 0.3) & (a[:, :2].max(1) < 9.7)

    def seam(a):
        return inner(a) & ((np.abs(a[:, 0] - 5.0) < 0.1) | (np.abs(a[:, 1] - 5.0) < 0.1))

    assert seam(out).sum() >= 0.98 * seam(sheet).sum()
    assert inner(out).sum() >= 0.98 * inner(sheet).sum()


def test_outlier_mask_keeps_all_of_a_tiny_tile():
    assert outlier_mask(np.zeros((5, 3)), np.zeros((0, 3))).all()


def test_a_merge_at_another_spacing_starts_over_and_one_at_the_same_carries_on(tmp_path):
    store = PointTiles(tmp_path / "m", 4.0)
    xyz = _sheet(3.0, 3.0)
    store.add("a", xyz, np.zeros((len(xyz), 3), np.uint8), _up(len(xyz)))
    store.merge(0.1, rule=SPARSE_RULE)
    f = store.root / "fused" / "0_0.npz"
    t0 = f.stat().st_mtime_ns
    store.merge(0.1, rule=SPARSE_RULE)
    assert f.stat().st_mtime_ns == t0 and store.merging_voxel() == 0.1
    assert not (store.root / "collapsed").exists()
    info = store.merge(0.2, rule=SPARSE_RULE)
    assert info["voxel"] == 0.2 and f.stat().st_mtime_ns != t0 and store.merging_voxel() == 0.2


def test_the_chunks_go_after_a_finished_merge(tmp_path):
    store = PointTiles(tmp_path / "m", 4.0, chunks=tmp_path / "c" / "chunks")
    xyz = _sheet(6.0, 3.0)
    store.add("a", xyz, np.zeros((len(xyz), 3), np.uint8), _up(len(xyz)))
    store.merge(0.1, rule=SPARSE_RULE)
    assert "complete" not in store.info()
    assert store.finish_merge()["complete"] is True and store.counts() == [1200, 600]  # x < 4, x >= 4
    assert store.drop_chunks() > 0 and not (tmp_path / "c" / "chunks").exists()
    assert store.info()["points"] == len(xyz) == sum(store.counts())
