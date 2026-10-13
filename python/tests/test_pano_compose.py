"""Compose and fill of ``pano.stitch`` on synthetic spheres (plan task 5)."""

from __future__ import annotations

import tracemalloc

import cv2
import numpy as np
import pytest

import pano_synth as ps
from aio_pipelines.pano import compose
from aio_pipelines.pano.frames import read_frame_info, read_image
from aio_pipelines.pano.geometry import rot_from_gimbal

W, H = 2048, 1024
WIDE_SHOTS = [(y, p) for y in (-100, -67.8, -35.7, -3.5, 28.7, 60.8, 93) for p in (20, -17, -55)] + [
    (0.0, -90.0)
]


@pytest.fixture(scope="module")
def scene():
    return ps.make_scene()


def _stitch(frames):
    pieces = []
    for f in frames:
        info = read_frame_info(f.path)
        s = compose.frame_scale(info.focal, W)
        pieces += compose.warp(read_image(f.path, s), f.truth, info.focal * s, W, H)
    return compose.blend(pieces, W, H)


def test_frames_shrink_to_the_canvas_resolution():
    assert compose.frame_scale(4256.0, 8192) == pytest.approx(
        1.4 * 8192 / 360 / (4256.0 * np.pi / 180), rel=1e-6
    )
    assert compose.frame_scale(400.0, 16384) == 1.0


def test_footprints_split_at_the_wrap_and_span_the_pole():
    f, w, h = 500.0, 640, 427
    south = compose.footprint(rot_from_gimbal(180, 0, 0), f, w, h, W, H)
    assert len(south) == 2 and south[0][0] == 0 and south[1][2] == W
    nadir = compose.footprint(rot_from_gimbal(0, -90, 0), f, w, h, W, H)
    assert nadir == [(0, nadir[0][1], W, H)]
    (north,) = compose.footprint(rot_from_gimbal(0, 0, 0), f, w, h, W, H)
    assert north[0] < W / 2 < north[2] and north[1] < H / 2 < north[3]


@pytest.mark.parametrize(("pattern", "top"), [("rows", 22.4), ("bursts", 47.2)])
def test_a_sphere_composes_onto_the_scene(tmp_path, scene, pattern, top):
    frames = ps.make_sphere(tmp_path, pattern, scene=scene, frame_w=640, seed=3)
    pano, mask = _stitch(frames)
    cov = mask > 0
    ref = cv2.resize(scene, (W, H), interpolation=cv2.INTER_AREA)
    diff = np.abs(pano.astype(int) - ref.astype(int)).mean(axis=2)
    assert diff[cov].mean() < 8
    assert compose.coverage_deg(mask) == pytest.approx((top, 89.9), abs=1.5)
    assert compose.wide_crop(mask) is None
    # the 180 degree meridian: the two edges meet as smoothly as neighbouring columns do
    both = cov[:, 0] & cov[:, -1]
    wrap = np.abs(pano[:, 0].astype(int) - pano[:, -1].astype(int))[both].mean()
    inner = np.abs(pano[:, W // 2].astype(int) - pano[:, W // 2 + 1].astype(int))[cov[:, W // 2]].mean()
    assert wrap < 1.5 * inner


def test_the_sky_fill_is_smooth_and_leaves_no_hole(tmp_path, scene):
    frames = ps.make_sphere(tmp_path, "rows", scene=scene, frame_w=640, seed=3)
    pano, mask = _stitch(frames)
    compose.fill_sky(pano, mask)
    assert (pano.sum(axis=2) > 0).all()
    sky = pano[: H // 4].astype(int)
    assert np.abs(np.diff(sky, axis=1)).max() <= 3  # no streaks across the sky
    assert np.abs(np.diff(sky, axis=0)).max() <= 3


def _top_edge(mask):
    cov = mask > 0
    return cov, cov.argmax(axis=0)


def test_seams_leave_no_gap_at_the_16k_seam_scale(tmp_path, scene, monkeypatch):
    monkeypatch.setattr(compose, "seam_scale", lambda width: 0.125)
    frames = ps.make_sphere(tmp_path, "rows", scene=scene, frame_w=640, seed=3)
    _, mask = _stitch(frames)
    cov, top = _top_edge(mask)
    below = np.arange(H)[:, None] >= top[None]
    assert int((below & ~cov).sum()) == 0


def test_the_sky_fill_meets_the_image_without_a_step(tmp_path, scene):
    frames = ps.make_sphere(tmp_path, "rows", scene=scene, frame_w=640, seed=3)
    pano, mask = _stitch(frames)
    _, top = _top_edge(mask)
    pano[: int(top.min())] = 255  # a bright sky row would show any hard edge
    compose.fill_sky(pano, mask)
    cols = np.arange(W)
    above = pano[np.maximum(top - 1, 0), cols].astype(int)
    below = pano[top, cols].astype(int)
    assert np.percentile(np.abs(above - below).max(axis=1), 95) < 10


def test_the_sky_fill_works_strip_by_strip():
    big = np.full((2048, 4096, 3), 100, np.uint8)
    big[:, :, 1] = np.linspace(0, 255, 4096, dtype=np.uint8)[None]
    mask = np.zeros((2048, 4096), np.uint8)
    mask[700:] = 255
    tracemalloc.start()
    base = tracemalloc.get_traced_memory()[0]
    compose.fill_sky(big, mask)
    peak = tracemalloc.get_traced_memory()[1] - base
    tracemalloc.stop()
    # a float copy of the canvas alone would be 4 (float32) or 8 (float64) times the image
    assert peak < 2 * big.nbytes


def test_a_wide_panorama_is_cropped_to_what_it_covers(tmp_path, scene):
    frames = ps.make_sphere(tmp_path, "bursts", scene=scene, frame_w=640, seed=3, shots=WIDE_SHOTS)
    pano, mask = _stitch(frames)
    crop = compose.wide_crop(mask)
    assert crop is not None
    left, right = compose.yaw_range_deg(crop, W)
    assert -150 < left < -100 and 93 < right < 140
    top, bottom = compose.lat_range_deg(crop, H)
    assert 40 < top < 55 and bottom == pytest.approx(90, abs=1)
    out = compose.apply_wide_crop(pano, crop)
    assert out.shape[1] == crop[3] and out.shape[0] == crop[2] - crop[1]
    out_mask = compose.apply_wide_crop(mask, crop)
    compose.fill_wide(out, out_mask)
    assert (out.sum(axis=2) > 0).all()


def test_thumbnail_size():
    assert compose.thumbnail(np.zeros((1024, 2048, 3), np.uint8)).shape == (256, 512, 3)
