"""photo/card.py: the array code around the matcher on an array backend. Every test runs it on
numpy against ``dense.py`` and ``fuse.py``; with ``AIO_TEST_ADDON`` naming a built GPU add-on on a
computer with an NVIDIA card, the same checks run on the card as well."""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np
import pytest

import products_synth as ps
from aio_pipelines.photo import card as K
from aio_pipelines.photo import dense as D
from aio_pipelines.photo.fuse import FuseSettings, consistent, normals_of

REAL = os.environ.get("AIO_TEST_ADDON")


def _backends():
    out = [pytest.param("cpu", id="numpy")]
    reason = "set AIO_TEST_ADDON to a built GPU add-on on a computer with an NVIDIA card"
    out.append(pytest.param("gpu", id="card", marks=pytest.mark.skipif(not REAL, reason=reason)))
    return out


@pytest.fixture(params=_backends())
def backend(request):
    if request.param == "cpu":
        return K.numpy_backend()
    from aio_pipelines import accel

    accel.activate(Path(REAL))
    return K.cupy_backend()


@pytest.fixture(autouse=True)
def _small_bands(monkeypatch):
    # the test photos are small: bands of a few rows and points exercise the seams
    monkeypatch.setattr(K, "ROWS", 37)
    monkeypatch.setattr(K, "POINTS", 5000)


def _grey(s):
    images = {v.id: img for v, img in zip(s.views, s.images, strict=True)}
    return lambda v: images[v.id].astype(np.float32).mean(axis=2)


def test_a_backend_says_which_it_is(backend):
    assert backend.name in ("cpu", "gpu")
    a = backend.xp.arange(6).reshape(2, 3)
    assert backend.to_host(a).tolist() == [[0, 1, 2], [3, 4, 5]]
    backend.release()


def test_products_of_rows_and_a_matrix_are_written_out(backend):
    m = np.array([[1.0, 2.0, 3.0], [4.0, 5.0, 6.0], [7.0, 8.0, 10.0]])
    rows = np.array([[1.0, 0.0, 2.0], [0.5, -1.0, 3.0]])
    xp = backend.xp
    got = K.mul3(xp.asarray(rows[:, 0]), xp.asarray(rows[:, 1]), xp.asarray(rows[:, 2]), m)
    np.testing.assert_allclose(np.stack([backend.to_host(g) for g in got], 1), rows @ m, rtol=1e-12)


def test_rectifying_a_photo_matches_the_reference(backend):
    s = ps.scene()
    model = ps.sparse_points(s, n=800)
    ref, other = model.view(6), model.view(D.select_pairs(model, 2)[6][0])
    img = _grey(s)(ref)
    pair = D.RectifiedPair.make(ref, other, 1.0)
    want, want_ok = pair.warp(img, ref, pair.cam_l)
    got, got_ok = K.warp(backend, pair, backend.xp.asarray(img), ref, pair.cam_l)
    got, got_ok = backend.to_host(got), backend.to_host(got_ok)
    assert got.dtype == np.float32 and got.shape == want.shape
    assert (got_ok == want_ok).mean() > 0.9999
    assert np.abs(got - want).max() < 0.05  # grey levels of 255: rounding only


def test_a_depth_map_matches_the_reference_within_rounding(backend):
    s = ps.scene()
    model = ps.sparse_points(s, n=1500)
    pairs = D.select_pairs(model, 2)
    st = D.DenseSettings(scale=1.0)
    ref = model.view(6)
    partners = [model.view(i) for i in pairs[6]]
    matcher = D.make_matcher(st, 10**9, "auto")
    want, want_info = D.depth_map(ref, partners, _grey(s), model, matcher, st, lambda: None)
    got, info = K.depth_map(backend, ref, partners, _grey(s), model, matcher, st, lambda: None)
    assert got.dtype == np.float32 and got.shape == want.shape
    assert [p["with"] for p in info["pairs"]] == [p["with"] for p in want_info["pairs"]]
    both = np.isfinite(got) & np.isfinite(want)
    assert abs(np.isfinite(got).mean() - np.isfinite(want).mean()) < 0.01
    assert both.mean() > 0.8 * np.isfinite(want).mean()
    assert np.mean(np.abs(got[both] - want[both]) <= 0.001 * want[both]) > 0.99
    # and it is as good against the true surface as the reference
    truth = D.zbuffer(ref.camera, ref, s.points)
    ok = np.isfinite(got) & np.isfinite(truth)
    assert np.mean(np.abs(got[ok] - truth[ok]) < 3 * ps.GSD) > 0.95


def test_a_photo_nothing_overlaps_is_empty_and_a_cancel_gets_through(backend):
    s = ps.scene()
    model = ps.sparse_points(s, n=800)
    st = D.DenseSettings(scale=1.0)
    ref = model.view(6)
    d, info = K.depth_map(
        backend, ref, [], _grey(s), model, D.make_matcher(st, 10**9, "auto"), st, lambda: None
    )
    assert d.shape == (ref.camera.height, ref.camera.width) and not np.isfinite(d).any()
    assert info == {"pairs": []}

    def stop():
        raise KeyboardInterrupt

    with pytest.raises(KeyboardInterrupt):
        K.depth_map(
            backend, ref, [model.view(5)], _grey(s), model, D.make_matcher(st, 10**9, "auto"), st, stop
        )


def test_fusing_a_photo_keeps_the_points_of_the_reference(backend):
    s = ps.scene()
    a, others = s.views[5], [s.views[4], s.views[6]]
    cam = a.camera
    da = D.zbuffer(cam, a, s.points)
    near = [(v, cam, D.zbuffer(cam, v, s.points)) for v in others]
    settings = FuseSettings()
    pts, agree = consistent(a, cam, da, near, settings)
    nrm = normals_of(pts, a.centre)
    good = np.isfinite(da) & (agree >= settings.min_agree)
    ok = np.isfinite(nrm[good]).all(1)
    want_keep = np.zeros(da.shape, bool)
    want_keep[good] = ok
    xyz, normals, keep = K.fuse_arrays(backend, a, cam, da, near, settings, K.Rays(backend))
    assert keep.shape == da.shape and (keep == want_keep).mean() > 0.9999
    assert xyz.shape == (int(keep.sum()), 3) and normals.shape == xyz.shape and normals.dtype == np.float32
    same = keep & want_keep
    np.testing.assert_allclose(xyz[same[keep]], pts[same], atol=1e-6)
    np.testing.assert_allclose(normals[same[keep]], nrm[same].astype(np.float32), atol=1e-4)


def test_the_pixel_directions_are_kept_per_camera(backend, monkeypatch):
    s = ps.scene()
    cam = s.views[5].camera
    rays = K.Rays(backend)
    calls = []
    real = type(cam).undistort
    monkeypatch.setattr(
        type(cam), "undistort", lambda self, u, v, **k: calls.append(1) or real(self, u, v, **k)
    )
    u1, _ = rays(cam)
    u2, _ = rays(cam)
    assert len(calls) == 1 and u1 is u2 and u1.dtype == backend.xp.float32
    assert len(rays.kept) == 1
