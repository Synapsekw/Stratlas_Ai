"""Planar faces of a tower crown: normals, plane splitting and the face filter."""

from __future__ import annotations

import math

import numpy as np

from aio_pipelines.telecom.faces import MAX_CURVATURE, normals, planar_faces, ransac_planes, voxel_down

AXIS_POINT = np.zeros(3)
AXIS_DIR = np.array([0.0, 1.0, 0.0])


def _shaft_r(h):
    return np.full_like(np.asarray(h, dtype=float), 0.4)


def _plane(rng, centre, u, v, size_u, size_v, ppm2=4000.0, noise=0.002):
    n = round(size_u * size_v * ppm2)
    a = rng.uniform(-0.5, 0.5, n)[:, None] * size_u
    b = rng.uniform(-0.5, 0.5, n)[:, None] * size_v
    pts = np.asarray(centre) + a * np.asarray(u) + b * np.asarray(v)
    return pts + rng.normal(0.0, noise, pts.shape)


def test_voxel_down_keeps_one_point_per_cell():
    xyz = np.array([[0.001, 0.001, 0.001], [0.002, 0.003, 0.004], [0.5, 0.5, 0.5]])
    out = voxel_down(xyz, 0.015)
    assert len(out) == 2
    assert {tuple(p) for p in out.round(3).tolist()} <= {tuple(p) for p in xyz.round(3).tolist()}


def test_normals_on_a_noisy_plane():
    rng = np.random.default_rng(3)
    n_true = np.array([0.3, 0.2, -0.9])
    n_true /= np.linalg.norm(n_true)
    u = np.cross(n_true, [0.0, 1.0, 0.0])
    u /= np.linalg.norm(u)
    v = np.cross(n_true, u)
    pts = _plane(rng, [1.0, 2.0, 3.0], u, v, 1.0, 1.0)
    nrm, curv = normals(pts)
    dot = np.abs(nrm @ n_true)
    assert nrm.shape == pts.shape and curv.shape == (len(pts),)
    assert np.allclose(np.linalg.norm(nrm, axis=1), 1.0)
    assert np.mean(dot > 0.99) > 0.98
    assert np.median(curv) < MAX_CURVATURE


def test_ransac_planes_splits_two_touching_perpendicular_planes():
    rng = np.random.default_rng(4)
    # an L of two upright plates meeting along a vertical edge at x = 0, z = 0
    a = _plane(rng, [0.25, 0.0, 0.0], [1.0, 0, 0], [0, 1.0, 0], 0.5, 0.8)
    b = _plane(rng, [0.0, 0.0, 0.25], [0, 0, 1.0], [0, 1.0, 0], 0.5, 0.8)
    xyz = np.vstack([a, b])
    labels = np.r_[np.zeros(len(a)), np.ones(len(b))]
    parts = ransac_planes(xyz, np.random.default_rng(0))
    assert len(parts) == 2
    for idx in parts:
        share = np.bincount(labels[idx].astype(int), minlength=2) / len(idx)
        assert share.max() > 0.97
        assert len(idx) > 0.9 * min(len(a), len(b))


def test_planar_faces_finds_an_upright_plate_facing_out():
    rng = np.random.default_rng(5)
    # a 0.3 x 1.4 plate 2.2 m east of the axis, facing east (outward)
    plate = _plane(rng, [2.2, 10.0, 0.0], [0, 0, 1.0], [0, 1.0, 0], 0.3, 1.4, noise=0.003)
    faces = planar_faces(plate, AXIS_POINT, AXIS_DIR, _shaft_r)
    assert len(faces) == 1
    f = faces[0]
    assert f.normal @ np.array([1.0, 0, 0]) > 0.999
    assert abs(f.width - 0.3) < 0.02 and abs(f.height - 1.4) < 0.02
    assert abs(f.up @ AXIS_DIR) > 0.999
    assert np.allclose(f.centre, [2.2, 10.0, 0.0], atol=0.02)
    assert 0 < f.rms < 0.006 and f.support > 1000 and 0.9 < f.coverage <= 1.0


def test_planar_faces_ignores_a_mount_pipe():
    rng = np.random.default_rng(6)
    n = 40_000
    t = rng.uniform(0, 2 * math.pi, n)
    y = rng.uniform(9.0, 12.0, n)
    pipe = np.column_stack([2.0 + 0.05 * np.cos(t), y, 0.05 * np.sin(t)])
    pipe += rng.normal(0, 0.002, pipe.shape)
    assert planar_faces(pipe, AXIS_POINT, AXIS_DIR, _shaft_r) == []


def test_planar_faces_ignores_a_horizontal_ring():
    rng = np.random.default_rng(7)
    n = 120_000
    a = rng.uniform(0, 2 * math.pi, n)
    b = rng.uniform(0, 2 * math.pi, n)
    rr = 2.0 + 0.04 * np.cos(b)
    ring = np.column_stack([rr * np.sin(a), 10.0 + 0.04 * np.sin(b), -rr * np.cos(a)])
    ring += rng.normal(0, 0.002, ring.shape)
    assert planar_faces(ring, AXIS_POINT, AXIS_DIR, _shaft_r) == []
