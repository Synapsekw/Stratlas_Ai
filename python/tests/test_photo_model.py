"""photo/model.py: projection, distortion, rotations and the sparse model files (pure numpy)."""

import numpy as np
import pytest

from aio_pipelines.photo.model import (
    Camera,
    Image,
    SparseModel,
    canonical_params,
    project_points,
    qvec_to_rotmat,
    rodrigues,
    rotmat_to_qvec,
    undistort_pixels,
)
from photo_g2_synth import FakeJob, SyntheticEngine, make_scene


def test_quaternions_round_trip():
    rng = np.random.default_rng(1)
    for w in rng.normal(size=(20, 3)) * 2:
        r = rodrigues(w)[0]
        assert np.allclose(qvec_to_rotmat(rotmat_to_qvec(r)), r, atol=1e-12)


def test_canonical_parameters_of_every_model():
    assert canonical_params("SIMPLE_RADIAL", [100, 50, 40, 0.1])[0].tolist()[:5] == [100, 100, 50, 40, 0.1]
    assert canonical_params("RADIAL", [100, 50, 40, 0.1, 0.2])[0][5] == 0.2
    assert canonical_params("PINHOLE", [100, 101, 50, 40])[0][1] == 101


def test_undistort_inverts_distort():
    cam = Camera(1, "OPENCV", 800, 600, [760, 760.4, 403, 297, -0.06, 0.012, 0.0004, -0.0003])
    rng = np.random.default_rng(2)
    uv = rng.uniform([0, 0], [800, 600], (200, 2))
    n = undistort_pixels(cam, uv)
    back, z = project_points(cam, np.eye(3), np.zeros(3), np.column_stack([n, np.ones(len(n))]))
    assert np.abs(back - uv).max() < 1e-6 and (z > 0).all()


def test_a_point_on_the_axis_projects_to_the_principal_point():
    cam = Camera(1, "SIMPLE_PINHOLE", 400, 300, [350, 200, 150])
    uv, z = project_points(cam, np.eye(3), np.zeros(3), [[0, 0, 10.0]])
    assert uv[0].tolist() == [200, 150] and z[0] == 10


def _scene_model(tmp_path):
    scene = make_scene(rows=3, cols=4, points=800)

    out = SyntheticEngine(scene).map(FakeJob(tmp_path, scene.names), "global", lambda *a: None)
    return scene, SparseModel.load(tmp_path / "sfm" / "0"), out


def test_text_and_npz_files_round_trip(tmp_path):
    scene, m, _ = _scene_model(tmp_path)
    assert len(m.images) == 12 and len(m.point_ids) > 300
    m.save_npz(tmp_path / "model.npz")
    m2 = SparseModel.load(tmp_path / "model.npz")
    m.write_text(tmp_path / "again")
    m3 = SparseModel.read_text(tmp_path / "again")
    for other in (m2, m3):
        assert set(other.images) == set(m.images)
        assert np.allclose(other.xyz, m.xyz, atol=1e-5)
        for k, im in m.images.items():
            assert np.allclose(other.images[k].R, im.R, atol=1e-9)
            assert other.images[k].name == im.name
    # compaction keeps every observation of a 3D point
    assert len(m3.observations()[0]) == len(m.observations()[0])
    assert m3.mean_reprojection_error() == pytest.approx(m.mean_reprojection_error(), abs=2e-3)


def test_a_loaded_model_holds_one_copy_of_its_observations(tmp_path):
    # a slice of the file's whole array per photo kept every photo's copy alive: 75 GB on a
    # 1,000-photo flight
    _, m, _ = _scene_model(tmp_path)
    m.save_npz(tmp_path / "model.npz")
    loaded = SparseModel.load(tmp_path / "model.npz")
    total = sum(len(im.xys) for im in loaded.images.values())
    for im in loaded.images.values():
        for arr in (im.xys, im.point3D_ids):
            assert arr.base is None or arr.base.size == arr.size < total


def test_similarity_transform_keeps_the_reprojection_error(tmp_path):
    _, m, _ = _scene_model(tmp_path)
    before = m.mean_reprojection_error()
    m.transform(3.2, rodrigues([0.3, -0.2, 1.0])[0], np.array([10.0, -4.0, 2.0]))
    assert m.mean_reprojection_error() == pytest.approx(before, abs=1e-6)


def test_a_name_with_a_space_is_refused_for_text(tmp_path):
    m = SparseModel()
    m.cameras[1] = Camera(1, "SIMPLE_PINHOLE", 10, 10, [10, 5, 5])
    m.images[1] = Image(1, "a b.jpg", 1, np.eye(3), np.zeros(3))
    with pytest.raises(Exception, match="space"):
        m.write_text(tmp_path / "x")
