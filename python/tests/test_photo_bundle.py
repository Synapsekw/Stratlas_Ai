"""photo/bundle.py: similarity fits and triangulation."""

import numpy as np
import pytest

from aio_pipelines.photo import bundle as B
from aio_pipelines.photo.model import rodrigues, rotation_angle_deg
from aio_pipelines.runtime import JobError
from photo_g2_synth import make_scene, synthetic_model


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


def _aligned(**kw):
    """The scene's model seen through an arbitrary similarity (SfM has no datum), placed back on
    the photos' GNSS positions."""
    scene = make_scene(**kw)
    m = synthetic_model(scene)
    m.transform(0.37, rodrigues([0.4, -0.3, 1.2])[0], np.array([3.0, -2.0, 5.0]))
    by = m.image_by_name()
    idx = [scene.names.index(n) for n in by]
    src = np.array([im.centre for im in by.values()])
    sim, _ = B.similarity_ransac(src, scene.gnss[idx], threshold=1.0)
    m.transform(*sim)
    return scene, m


def test_triangulation_of_a_target_from_its_marks():
    scene, m = _aligned(rows=3, cols=4, points=600)
    rng = np.random.default_rng(4)
    marks = scene.marks(rng, noise_px=0.0)
    by = m.image_by_name()
    g = scene.gcps[4]
    obs = [(by[n].id, xy) for n, xy in marks[g.id]]
    X, err = B.triangulate(m, obs)
    # the cameras are only GNSS-placed here: centimetres of GNSS noise, not metres
    assert np.linalg.norm((X - g.enu)[:2]) < 0.2 and abs((X - g.enu)[2]) < 1.0 and err < 5.0
