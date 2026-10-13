"""Seed, match and adjust of ``pano.stitch`` on synthetic spheres (plan task 4).

The frames are rendered with known rotations; the gimbal angles written into them are turned by
1 to 3 degrees. The stitch must recover the true rotations within 0.2 degrees (spec section 5).
"""

from __future__ import annotations

import numpy as np
import pytest

import pano_synth as ps
from aio_pipelines.pano import align
from aio_pipelines.pano.frames import read_frame_info, read_image
from aio_pipelines.pano.geometry import angle_deg, rot_from_gimbal


@pytest.fixture(scope="module")
def scene():
    return ps.make_scene()


def _align(frames):
    infos = [read_frame_info(f.path) for f in frames]
    s = align.work_scale(infos[0].width)
    grays = [read_image(f.path, s, gray=True) for f in frames]
    seeds = [rot_from_gimbal(i.yaw, i.pitch, i.roll) for i in infos]
    focal = infos[0].focal * s
    matches = align.match_frames(grays, seeds, focal)
    return align.align(seeds, matches, focal, (grays[0].shape[1], grays[0].shape[0])), seeds


@pytest.mark.parametrize("pattern", ["rows", "bursts"])
def test_recovers_the_true_rotations_within_a_fifth_of_a_degree(tmp_path, scene, pattern):
    frames = ps.make_sphere(tmp_path, pattern, scene=scene, frame_w=640, seed=3)
    a, seeds = _align(frames)
    assert a.aligned == "features" and a.unmatched == []
    assert max(angle_deg(s, f.truth) for s, f in zip(seeds, frames, strict=True)) > 1.0
    assert max(angle_deg(r, f.truth) for r, f in zip(a.rotations, frames, strict=True)) < 0.2
    assert a.residual_px is not None and a.residual_px < 1.0
    assert a.focal_scale == pytest.approx(1.0, abs=0.003)


def test_refines_one_shared_focal_length(tmp_path, scene):
    frames = ps.make_sphere(tmp_path, "rows", scene=scene, frame_w=640, seed=5, focal_error=0.015)
    a, _ = _align(frames)
    assert a.aligned == "features"
    assert a.focal_scale == pytest.approx(1.015, abs=0.003)


def test_frames_without_matches_keep_their_seed(tmp_path, scene):
    frames = ps.make_sphere(tmp_path, "rows", scene=scene, frame_w=640, seed=5, blank=(3, 24))
    a, seeds = _align(frames)
    assert a.aligned == "features" and a.unmatched == [3, 24]
    assert all(np.allclose(a.rotations[k], seeds[k]) for k in (3, 24))
    matched = [k for k in range(len(frames)) if k not in (3, 24)]
    assert max(angle_deg(a.rotations[k], frames[k].truth) for k in matched) < 0.2


def test_a_textureless_sphere_falls_back_to_the_gimbal_angles(tmp_path):
    frames = ps.make_sphere(tmp_path, "bursts", scene=ps.make_scene(textureless=True), frame_w=640, seed=3)
    a, seeds = _align(frames)
    assert a.aligned == "metadata" and a.residual_px is None and a.focal_scale == 1.0
    assert all(np.allclose(r, s) for r, s in zip(a.rotations, seeds, strict=True))
    assert a.reason == "No features matched between frames."


def _fake_matches():
    pts = np.zeros((30, 2), np.float32)
    return [align.PairMatch(0, 1, pts, pts)]


def test_a_large_residual_or_turn_falls_back_to_the_seeds(monkeypatch):
    seeds = [rot_from_gimbal(0, 0, 0), rot_from_gimbal(45, 0, 0)]
    turned = [rot_from_gimbal(6, 0, 0), rot_from_gimbal(45, 0, 0)]
    monkeypatch.setattr(align, "adjust", lambda *a: (turned, 1.01, 0.4, True))
    a = align.align(seeds, _fake_matches(), 500.0, (640, 427))
    assert a.aligned == "metadata" and "turned 6.0 degrees" in (a.reason or "")
    monkeypatch.setattr(align, "adjust", lambda *a: (seeds, 1.0, 2.5, True))
    a = align.align(seeds, _fake_matches(), 500.0, (640, 427))
    assert a.aligned == "metadata" and a.residual_px == 2.5 and "2.5 px" in (a.reason or "")
    monkeypatch.setattr(align, "adjust", lambda *a: (seeds, 1.0, 0.3, False))
    assert align.align(seeds, _fake_matches(), 500.0, (640, 427)).reason == "The adjustment did not converge."


def test_only_overlapping_seeds_are_paired():
    seeds = [rot_from_gimbal(y, p, 0) for y, p in ps.ROWS]
    pairs = align.overlap_pairs(seeds, 65.0)
    assert (0, 1) in pairs and (0, 7) in pairs  # yaw neighbours of -180, across the wrap too
    assert (0, 4) not in pairs  # -180 and 0 look opposite ways
    assert any(24 in p for p in pairs)  # the nadir meets the -70 row
