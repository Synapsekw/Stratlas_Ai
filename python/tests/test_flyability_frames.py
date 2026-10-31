"""Frames, camera model and ray cast for Flyability imports."""

from __future__ import annotations

import math
import time

import numpy as np
from scipy.spatial.transform import Rotation

from aio_pipelines.flyability import frames

IDENT = np.array([0.0, 0.0, 0.0, 1.0])


def test_apply_matches_row_major() -> None:
    m = np.eye(4)
    m[:3, :3] = Rotation.from_euler("z", 90, degrees=True).as_matrix()
    m[:3, 3] = (1, 2, 3)
    out = frames.apply(m, np.array([[1.0, 0.0, 0.0]]))
    assert np.allclose(out, [[1, 3, 3]], atol=1e-9)


def test_apply_none_returns_input() -> None:
    pts = np.ones((2, 3))
    assert frames.apply(None, pts) is pts


def test_apply_pose_turns_position_and_orientation() -> None:
    m = np.eye(4)
    m[:3, :3] = Rotation.from_euler("z", 90, degrees=True).as_matrix()
    m[:3, 3] = (1, 2, 3)
    pos, q = frames.apply_pose(m, np.array([1.0, 0.0, 0.0]), IDENT)
    assert np.allclose(pos, [1, 3, 3], atol=1e-9)
    assert np.allclose(frames.view_axis(q), [0, 1, 0], atol=1e-9)


def test_view_axis_is_plus_x() -> None:
    assert np.allclose(frames.view_axis(IDENT), [1, 0, 0])


def test_camera_from_body_matches_snapshot() -> None:
    pos, q = frames.camera_from_body(np.zeros(3), IDENT, -24.0)
    assert np.allclose(pos, frames.LEVER_ARM)
    assert abs(frames.view_axis(q)[2] - (-math.sin(math.radians(24)))) < 1e-6


def test_three_camera_q_looks_east() -> None:
    r = Rotation.from_quat(frames.three_camera_q(IDENT))
    assert np.allclose(r.apply([0, 0, -1]), [1, 0, 0], atol=1e-9)
    assert np.allclose(r.apply([0, 1, 0]), [0, 1, 0], atol=1e-9)


def test_to_scene() -> None:
    assert np.allclose(frames.to_scene(np.array([1.0, 2.0, 3.0])), [1, 3, -2])


def test_cast_hits_wall() -> None:
    ys, zs = np.meshgrid(np.linspace(-2, 2, 200), np.linspace(-2, 2, 200))
    wall = np.column_stack([np.full(ys.size, 5.0), ys.ravel(), zs.ravel()])
    o = np.zeros((2, 3))
    d = np.array([[1.0, 0, 0], [-1.0, 0, 0]])
    hits = frames.cast(wall, o, d)
    assert abs(hits[0] - 5.0) <= 0.03
    assert math.isnan(hits[1])


def test_location_check() -> None:
    assert frames.location_check(5.0, 5.2) == "agrees"
    assert frames.location_check(5.0, 2.0) == "disagrees"
    assert frames.location_check(math.nan, 3.0) == "no-hit"
    assert frames.location_check(5.0, None) == "unchecked"


def test_cast_budget_200k_points_100_rays() -> None:
    rng = np.random.default_rng(1)
    pts = rng.uniform(-20, 20, (200_000, 3))
    d = rng.normal(size=(100, 3))
    d /= np.linalg.norm(d, axis=1, keepdims=True)
    t0 = time.perf_counter()
    hits = frames.cast(pts, np.zeros((100, 3)), d)
    elapsed = time.perf_counter() - t0
    assert hits.shape == (100,)
    assert elapsed < 20


def test_grid_subsample_collapses_cells() -> None:
    pts = np.array([[0.001, 0.001, 0.001], [0.004, 0.006, 0.002], [0.5, 0.5, 0.5], [-0.3, 0, 1]])
    out = frames._grid_subsample(pts)
    assert len(out) == 3
    assert np.allclose(out[0], pts[0])


def test_cast_with_subsampling_matches(monkeypatch) -> None:
    ys, zs = np.meshgrid(np.linspace(-2, 2, 200), np.linspace(-2, 2, 200))
    wall = np.column_stack([np.full(ys.size, 5.0), ys.ravel(), zs.ravel()])
    wall = np.vstack([wall, wall + 0.002])
    o = np.zeros((1, 3))
    d = np.array([[1.0, 0, 0]])
    before = frames.cast(wall, o, d)
    monkeypatch.setattr(frames, "_GRID_ABOVE", 10)
    after = frames.cast(wall, o, d)
    assert abs(after[0] - before[0]) <= 0.01
    assert abs(after[0] - 5.0) <= 0.03


def test_grid_subsample_2m_points_is_fast() -> None:
    pts = np.random.default_rng(2).uniform(0, 50, (2_000_000, 3))
    t0 = time.perf_counter()
    frames._grid_subsample(pts)
    assert time.perf_counter() - t0 < 5
