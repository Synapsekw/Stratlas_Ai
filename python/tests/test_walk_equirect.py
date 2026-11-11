"""Equirect geometry for walk frames (``inspection/equirect.py``): synthetic only."""

from __future__ import annotations

import math

import numpy as np
import pytest

from aio_pipelines.inspection import equirect as E

W, H = 2000, 1000


@pytest.mark.parametrize("yaw,pitch", [(0, 0), (90, 10), (-135, -30), (179, 60), (-45, 5)])
def test_look_direction_round_trip(yaw, pitch):
    d = E.look_to_dir(yaw, pitch)
    assert np.linalg.norm(d) == pytest.approx(1.0)
    y2, p2 = E.dir_to_look(d)
    assert y2 == pytest.approx(yaw, abs=1e-9) and p2 == pytest.approx(pitch, abs=1e-9)


def test_axes_follow_the_renderer():
    assert E.look_to_dir(0, 0) == pytest.approx([0, 0, -1])
    assert E.look_to_dir(90, 0) == pytest.approx([1, 0, 0])
    assert E.look_to_dir(0, 90) == pytest.approx([0, 1, 0], abs=1e-12)


@pytest.mark.parametrize("x,y", [(0.0, 500.0), (1000.0, 250.0), (1999.0, 900.0), (37.5, 12.0)])
def test_pixel_look_round_trip(x, y):
    yaw, pitch = E.pixel_to_look(x, y, W, H)
    x2, y2 = E.look_to_pixel(yaw, pitch, W, H)
    assert x2 == pytest.approx(x) and y2 == pytest.approx(y)


def test_face_pixel_dir_centre_and_edges():
    for yaw in E.FACE_YAWS:
        d = E.face_pixel_dir(512, 512, yaw, E.FACE_FOV, 1024)
        assert d == pytest.approx(E.look_to_dir(yaw, 0), abs=1e-9)
    # the right edge of the yaw-0 face is half the fov to the right
    yaw, pitch = E.dir_to_look(E.face_pixel_dir(1024, 512, 0.0, E.FACE_FOV, 1024))
    assert yaw == pytest.approx(E.FACE_FOV / 2) and pitch == pytest.approx(0, abs=1e-9)
    # the top edge looks up
    _, pitch = E.dir_to_look(E.face_pixel_dir(512, 0, 0.0, E.FACE_FOV, 1024))
    assert pitch == pytest.approx(E.FACE_FOV / 2)


def _face_box_of(frame_box, yaw, size=1024, fov=E.FACE_FOV):
    """Project a frame box's sampled edges into a face: the face box (an oracle for the tests)."""
    f, r, u = E.face_basis(yaw)
    t = math.tan(math.radians(fov) / 2)
    x0, y0, x1, y1 = frame_box
    xs, ys = [], []
    for a in np.linspace(0, 1, 41):
        for px, py in ((x0 + (x1 - x0) * a, y0), (x0 + (x1 - x0) * a, y1), (x0, y0 + (y1 - y0) * a),
                       (x1, y0 + (y1 - y0) * a)):  # fmt: skip
            d = E.look_to_dir(*E.pixel_to_look(px, py, W, H))
            z = d @ f
            xs.append(((d @ r) / (z * t) + 1) / 2 * size)
            ys.append((1 - (d @ u) / (z * t)) / 2 * size)
    return [min(xs), min(ys), max(xs), max(ys)]


def _covers(back, frame_box, slack=20.0):
    """The face box's footprint holds the frame box and is only a little larger (a face's straight
    edges bow in the frame, so its bounding box grows a little)."""
    assert back[0] <= frame_box[0] + 1 and back[1] <= frame_box[1] + 1
    assert back[2] >= frame_box[2] - 1 and back[3] >= frame_box[3] - 1
    assert back == pytest.approx(frame_box, abs=slack)


def test_a_face_box_maps_back_to_its_frame_box():
    frame_box = [1100.0, 400.0, 1200.0, 520.0]  # yaw 18..36, a little above and below the horizon
    face = _face_box_of(frame_box, 0.0)
    back = E.face_box_to_frame(face, 0.0, E.FACE_FOV, 1024, W, H, samples=32)
    _covers(back, frame_box)


def test_a_face_box_across_the_seam_wraps():
    # yaw 170..190 seen from the yaw-180 face: x0 near the right end, x1 past the width
    frame_box = [1944.4, 450.0, 2055.6, 560.0]
    face = _face_box_of(frame_box, 180.0)
    back = E.face_box_to_frame(face, 180.0, E.FACE_FOV, 1024, W, H, samples=32)
    assert 0 <= back[0] < W < back[2]
    _covers(back, frame_box)


def test_face_box_inside():
    assert E.face_box_inside([100, 100, 900, 900], 1024)
    assert not E.face_box_inside([5, 100, 900, 900], 1024)
    assert not E.face_box_inside([100, 100, 1020, 900], 1024)


def test_render_face_samples_the_right_pixels():
    # a frame whose red channel holds the column's yaw band and green the row's pitch band
    frame = np.zeros((H, W, 3), np.uint8)
    xs = np.arange(W)
    frame[..., 0] = ((xs / W) * 255).astype(np.uint8)[None, :]
    frame[..., 1] = ((np.arange(H) / H) * 255).astype(np.uint8)[:, None]
    # a white dot at yaw 30, pitch 10
    px, py = E.look_to_pixel(30.0, 10.0, W, H)
    frame[int(py) - 3 : int(py) + 4, int(px) - 3 : int(px) + 4, 2] = 255
    face = E.render_face(frame, 0.0, size=256)
    assert face.shape == (256, 256, 3) and face.dtype == np.uint8
    # the face centre is the frame centre
    assert int(face[128, 128, 0]) == pytest.approx(int(frame[H // 2, W // 2, 0]), abs=2)
    assert int(face[128, 128, 1]) == pytest.approx(int(frame[H // 2, W // 2, 1]), abs=2)
    # the dot shows where its direction projects into the face
    ys, xs_ = np.nonzero(face[..., 2] > 128)
    f, r, u = E.face_basis(0.0)
    d = E.look_to_dir(30.0, 10.0)
    t = math.tan(math.radians(E.FACE_FOV) / 2)
    ex = ((d @ r) / ((d @ f) * t) + 1) / 2 * 256
    ey = (1 - (d @ u) / ((d @ f) * t)) / 2 * 256
    assert xs_.mean() + 0.5 == pytest.approx(ex, abs=1.5) and ys.mean() + 0.5 == pytest.approx(ey, abs=1.5)


def test_render_face_wraps_the_seam():
    frame = np.zeros((H, W, 3), np.uint8)
    frame[:, :50] = 200  # left end of the frame (yaw -180..-171)
    frame[:, -50:] = 100  # right end
    face = E.render_face(frame, 180.0, size=128)
    row = face[64, :, 0]
    # the left half of the yaw-180 face is the frame's right end, the right half its left end
    assert row[60] == 100 and row[67] == 200


def test_frame_iou_across_the_seam():
    a = [1990.0, 100.0, 2010.0, 120.0]
    b = [0.0, 100.0, 10.0, 120.0]
    assert E.frame_iou(a, b, W) == pytest.approx(0.5)
    assert E.frame_iou([0, 0, 10, 10], [500, 0, 510, 10], W) == 0.0


def test_merge_face_boxes_keeps_the_higher_score():
    dets = [
        {"class": "a", "bbox": [100, 100, 200, 200], "confidence": 0.6, "_inside": True},
        {"class": "a", "bbox": [105, 100, 205, 200], "confidence": 0.9, "_inside": False},
        {"class": "b", "bbox": [100, 100, 200, 200], "confidence": 0.5},
        {"class": "a", "bbox": [800, 100, 900, 200], "confidence": 0.4},
    ]
    out = E.merge_face_boxes(dets, W)
    assert [d["confidence"] for d in out] == [0.9, 0.5, 0.4]
    # equal scores: the box the face did not cut wins
    tie = E.merge_face_boxes(
        [
            {"class": "a", "bbox": [100, 100, 200, 200], "confidence": 0.7, "_inside": False, "k": 1},
            {"class": "a", "bbox": [100, 100, 200, 200], "confidence": 0.7, "_inside": True, "k": 2},
        ],
        W,
    )
    assert [d["k"] for d in tie] == [2]


def test_box_size_and_centre():
    assert E.box_centre([1990, 100, 2010, 120], W, H) == (0.0, 110.0)
    assert E.box_size_deg([1000, 450, 1100, 500], W, H) == pytest.approx(18.0, rel=0.01)
    d = E.box_dir([1000, 400, 1000, 500], W, H, "bottom")
    assert d == pytest.approx(E.look_to_dir(0, 0), abs=1e-9)
