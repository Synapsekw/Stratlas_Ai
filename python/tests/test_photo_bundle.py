"""photo/bundle.py: similarity fits, triangulation and the georeferencing bundle adjustment."""

import numpy as np
import pytest

from aio_pipelines.photo import bundle as B
from aio_pipelines.photo.model import SparseModel, rodrigues, rotation_angle_deg
from aio_pipelines.runtime import JobError
from photo_g2_synth import FakeJob, SyntheticEngine, make_scene


def test_umeyama_recovers_a_known_similarity():
    rng = np.random.default_rng(1)
    src = rng.normal(size=(20, 3)) * 30
    r = rodrigues([0.2, -0.5, 1.1])[0]
    dst = 2.5 * src @ r.T + [100, -50, 7]
    s, rr, t = B.similarity(src, dst)
    assert s == pytest.approx(2.5) and np.allclose(rr, r) and np.allclose(t, [100, -50, 7])


def test_ransac_similarity_ignores_outliers():
    rng = np.random.default_rng(2)
    src = rng.normal(size=(40, 3)) * 50
    r = rodrigues([0.0, 0.0, 0.7])[0]
    dst = 0.5 * src @ r.T + [1, 2, 3] + rng.normal(0, 0.02, (40, 3))
    dst[:6] += rng.normal(0, 30, (6, 3))  # six photos with a bad GPS fix
    (s, rr, _), inl = B.similarity_ransac(src, dst, threshold=0.2)
    assert s == pytest.approx(0.5, rel=1e-3) and rotation_angle_deg(rr, r) < 0.05
    assert not inl[:6].any() and inl[6:].all()


def test_similarity_needs_three_points():
    with pytest.raises(JobError):
        B.similarity(np.zeros((2, 3)), np.zeros((2, 3)))


def _aligned(tmp_path, **kw):
    scene = make_scene(**kw)

    SyntheticEngine(scene).map(FakeJob(tmp_path, scene.names), "global", lambda *a: None)
    m = SparseModel.load(tmp_path / "sfm" / "0")
    by = m.image_by_name()
    idx = [scene.names.index(n) for n in by]
    src = np.array([im.centre for im in by.values()])
    sim, _ = B.similarity_ransac(src, scene.gnss[idx], threshold=1.0)
    m.transform(*sim)
    return scene, m


def test_triangulation_of_a_target_from_its_marks(tmp_path):
    scene, m = _aligned(tmp_path, rows=3, cols=4, points=600)
    rng = np.random.default_rng(4)
    marks = scene.marks(rng, noise_px=0.0)
    by = m.image_by_name()
    g = scene.gcps[4]
    obs = [(by[n].id, xy) for n, xy in marks[g.id]]
    X, err = B.triangulate(m, obs)
    # the cameras are only GNSS-placed with a 1% focal error here: decimetres, not metres
    # (the focal error shows as a 1 % height error: 0.6 m at 60 m)
    assert np.linalg.norm((X - g.enu)[:2]) < 0.2 and abs((X - g.enu)[2]) < 1.0 and err < 5.0


def test_bundle_adjustment_with_rtk_priors_lands_cameras_on_truth(tmp_path):
    scene, m = _aligned(tmp_path, rows=4, cols=5, points=3000, gnss_sigma=(0.02, 0.03))
    by = m.image_by_name()
    idx = {im.id: scene.names.index(n) for n, im in by.items()}
    before = np.median([np.linalg.norm(m.images[i].centre - scene.centres[k]) for i, k in idx.items()])
    priors = {i: B.CameraPrior(scene.gnss[k], 0.02, 0.03) for i, k in idx.items()}
    pts = B.select_points(m, per_image=120)
    res = B.bundle_adjust(m, pts, priors=priors)
    assert res.final_cost < res.initial_cost
    after = np.array([np.linalg.norm(m.images[i].centre - scene.centres[k]) for i, k in idx.items()])
    rot = max(rotation_angle_deg(m.images[i].R, scene.rotations[k]) for i, k in idx.items())
    assert np.median(after) < 0.03 and after.max() < 0.08, (before, after)
    assert rot < 0.15  # nadir shift-tilt correlation: see test_photo_georef
    # A nadir block flown at one height cannot separate focal length from flying height (scaling
    # every depth about its camera fits as well), so the engine's 1 % focal error stays: that is
    # why ``photo.align`` warns about nadir-only blocks without control (see test_photo_align).
    B.refine_all_points(m)
    assert res.reprojection_px < 0.6 and m.mean_reprojection_error() < 0.6


def test_point_refinement_in_blocks_matches_one_pass(tmp_path):
    _, m = _aligned(tmp_path, rows=3, cols=4, points=1500)
    a, b = m.copy(), m.copy()
    B.refine_all_points(a, block=10**9)
    B.refine_all_points(b, block=97)  # many small blocks, split on point boundaries
    assert np.allclose(a.xyz, b.xyz, atol=1e-9) and np.allclose(a.error, b.error, atol=1e-9)


def test_the_adjustment_works_on_a_bounded_number_of_observations(tmp_path):
    _, m = _aligned(tmp_path, rows=4, cols=5, points=3000)
    img, pts, _ = m.observations()
    everything = B.select_points(m, per_image=10**6, max_observations=10**9)
    capped = B.select_points(m, per_image=10**6, max_observations=2000)
    obs = np.bincount(pts, minlength=len(m.point_ids))
    assert obs[everything].sum() > 2000
    assert 2000 <= obs[capped].sum() < 2000 + obs.max()
    assert B.MAX_BA_OBSERVATIONS <= 500_000  # about half a gigabyte of working arrays


def test_bundle_adjustment_needs_a_datum(tmp_path):
    _, m = _aligned(tmp_path, rows=3, cols=3, points=300)
    with pytest.raises(JobError, match="GNSS positions or at least three control points"):
        B.bundle_adjust(m, B.select_points(m))
