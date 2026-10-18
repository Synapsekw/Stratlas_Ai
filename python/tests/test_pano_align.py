"""Seed, match and adjust of ``pano.stitch`` on synthetic spheres (plan task 4).

The frames are rendered with known rotations; the gimbal angles written into them are turned by
1 to 3 degrees. The stitch must recover the true rotations within 0.2 degrees (spec section 5).
"""

from __future__ import annotations

import cv2
import numpy as np
import pytest

import pano_synth as ps
from aio_pipelines.pano import align
from aio_pipelines.pano.frames import read_frame_info, read_image
from aio_pipelines.pano.geometry import angle_deg, rot_from_gimbal, rotvecs_to_matrices


@pytest.fixture(scope="module")
def scene():
    return ps.make_scene()


def _match(frames):
    infos = [read_frame_info(f.path) for f in frames]
    s = align.work_scale(infos[0].width)
    grays = [read_image(f.path, s, gray=True) for f in frames]
    seeds = [rot_from_gimbal(i.yaw, i.pitch, i.roll) for i in infos]
    focal = infos[0].focal * s
    return seeds, align.match_frames(grays, seeds, focal), focal, (grays[0].shape[1], grays[0].shape[0])


def _align(frames):
    seeds, matches, focal, size = _match(frames)
    return align.align(seeds, matches, focal, size), seeds


@pytest.fixture(scope="module")
def matched(scene, tmp_path_factory):
    """A rows sphere's frames, seeds, matches, working focal length and size."""
    frames = ps.make_sphere(tmp_path_factory.mktemp("matched"), "rows", scene=scene, frame_w=640, seed=3)
    return (frames, *_match(frames))


def _rotvec(r):
    return cv2.Rodrigues(np.asarray(r, float))[0].ravel()


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


def test_frames_without_matches_take_their_neighbours_correction(tmp_path, scene):
    frames = ps.make_sphere(tmp_path, "rows", scene=scene, frame_w=640, seed=5, blank=(3, 24))
    a, seeds = _align(frames)
    assert a.aligned == "features" and a.unmatched == [3, 24]
    matched = [k for k in range(len(frames)) if k not in (3, 24)]
    assert max(angle_deg(a.rotations[k], frames[k].truth) for k in matched) < 0.2
    # the camera-frame correction of a blank frame is the weighted mean of its neighbours'
    w = np.array([_rotvec(s.T @ r) for s, r in zip(seeds, a.rotations, strict=True)])
    hfov = 2 * np.degrees(np.arctan(640 / 2 / (read_frame_info(frames[0].path).focal * a.focal_scale)))
    want = align.borrow(w, np.stack(seeds), matched, align.BORROW_SIGMA_SHARE * hfov)
    for k in (3, 24):
        assert angle_deg(a.rotations[k], seeds[k]) > 0.1
        assert np.degrees(np.linalg.norm(w[k] - want[k])) < 0.01


def test_a_shared_gimbal_bias_is_borrowed_by_frames_without_matches(matched):
    frames, _, matches, focal, size = matched
    # the gimbal's error is systematic: the same 1 degree roll in every frame; two frames match nothing
    roll = rotvecs_to_matrices(np.radians([0.0, 0.0, 1.0]))[0]
    seeds = [f.truth @ roll for f in frames]
    blank = (3, 24)
    a = align.align(seeds, [m for m in matches if m.i not in blank and m.j not in blank], focal, size)
    assert a.aligned == "features" and a.unmatched == [3, 24]
    for k in blank:
        assert angle_deg(seeds[k], frames[k].truth) == pytest.approx(1.0)
        assert angle_deg(a.rotations[k], frames[k].truth) < 0.75


def test_a_pair_the_sphere_disagrees_with_is_dropped(matched):
    frames, seeds, matches, focal, size = matched
    m = matches[0]
    bad = align.PairMatch(m.i, m.j, m.a, m.b + np.float32([20.0, 0.0]))  # parallax a turn cannot absorb
    rots, scale, median_px, ok, kept = align.adjust(seeds, [*matches, bad], focal, size)
    assert ok and len(kept) == len(matches) and all(k is not bad for k in kept)
    assert median_px < 1.0 and scale == pytest.approx(1.0, abs=0.003)
    assert max(angle_deg(r, f.truth) for r, f in zip(rots, frames, strict=True)) < 0.2


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
    monkeypatch.setattr(align, "adjust", lambda s, m, *a: (turned, 1.01, 0.4, True, m))
    a = align.align(seeds, _fake_matches(), 500.0, (640, 427))
    assert a.aligned == "metadata" and "turned 6.0 degrees" in (a.reason or "")
    monkeypatch.setattr(align, "adjust", lambda s, m, *a: (seeds, 1.0, 2.5, True, m))
    a = align.align(seeds, _fake_matches(), 500.0, (640, 427))
    assert a.aligned == "metadata" and a.residual_px == 2.5 and "2.5 px" in (a.reason or "")
    monkeypatch.setattr(align, "adjust", lambda s, m, *a: (seeds, 1.0, 0.3, False, m))
    assert align.align(seeds, _fake_matches(), 500.0, (640, 427)).reason == "The adjustment did not converge."


def test_only_overlapping_seeds_are_paired():
    seeds = [rot_from_gimbal(y, p, 0) for y, p in ps.ROWS]
    pairs = align.overlap_pairs(seeds, 65.0)
    assert (0, 1) in pairs and (0, 7) in pairs  # yaw neighbours of -180, across the wrap too
    assert (0, 4) not in pairs  # -180 and 0 look opposite ways
    assert any(24 in p for p in pairs)  # the nadir meets the -70 row
