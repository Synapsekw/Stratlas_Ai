"""Measuring a person's selection of cloud points (`telecom/flag.py`) on a synthetic crown."""

from __future__ import annotations

from functools import cache

import numpy as np

from aio_pipelines.telecom.flag import (
    FLAG_MIN_POINTS,
    PLACEHOLDER_M,
    measure_selection,
    not_measured,
    select_points,
)
from aio_pipelines.telecom.measure import to_project
from antenna_synth import tower_cloud, unit_axes

ORIGIN = (500.0, 1000.0, 10.0)
AXIS_POINT = np.zeros(3)
AXIS_DIR = np.array([0.0, 1.0, 0.0])


@cache
def _tower():
    return tower_cloud("monopole", seed=3, points_per_m2=4000)


def _truth(name):
    return next(u for u in _tower()[1]["units"] if u["name"] == name)


def _frame(u):
    """(centre, rows across/up/normal, extents) of a truth unit's box."""
    axes = np.vstack(unit_axes(u["azimuthDeg"], u["downtiltDeg"], u["plumbDeg"]))
    return np.asarray(u["centre"], dtype=float), axes, np.array([u["widthM"], u["heightM"], u["depthM"]])


def _box_local(xyz, u):
    c, axes, _ = _frame(u)
    return (xyz - c) @ axes.T


def _in_box(xyz, u, grow):
    _, _, ext = _frame(u)
    return np.all(np.abs(_box_local(xyz, u)) <= ext / 2 + grow, axis=1)


def _distance_to_box(xyz, u):
    _, _, ext = _frame(u)
    return np.linalg.norm(np.maximum(np.abs(_box_local(xyz, u)) - ext / 2, 0.0), axis=1)


def _view_proj(eye, target, fov_deg=40.0, aspect=1.5, near=0.1, far=100.0):
    """A column-major view-projection (as the renderer sends it) looking from `eye` at `target`."""
    f = target - eye
    f /= np.linalg.norm(f)
    s = np.cross(f, [0.0, 1.0, 0.0])
    s /= np.linalg.norm(s)
    up = np.cross(s, f)
    view = np.eye(4)
    view[0, :3], view[1, :3], view[2, :3] = s, up, -f
    view[:3, 3] = -view[:3, :3] @ eye
    t = 1.0 / np.tan(np.radians(fov_deg) / 2)
    proj = np.zeros((4, 4))
    proj[0, 0], proj[1, 1] = t / aspect, t
    proj[2, 2], proj[2, 3] = (far + near) / (near - far), 2 * far * near / (near - far)
    proj[3, 2] = -1.0
    return (proj @ view).ravel(order="F").tolist()


def _ndc(points, view_proj):
    m = np.asarray(view_proj).reshape(4, 4).T
    clip = np.hstack([points, np.ones((len(points), 1))]) @ m.T
    return clip[:, :2] / clip[:, 3:4]


def test_select_keeps_only_points_inside_bounds_and_polygon():
    xyz, _ = _tower()
    u = _truth("panel-0")
    c, axes, ext = _frame(u)
    eye = c + axes[2] * 4.0
    vp = _view_proj(eye, c)
    # the polygon around the projected corners of the box grown by the bounds margin
    signs = np.array([[a, b, d] for a in (-1, 1) for b in (-1, 1) for d in (-1, 1)], dtype=float)
    corners = c + (signs * (ext / 2 + 0.1)) @ axes
    nd = _ndc(corners, vp)
    (x0, y0), (x1, y1) = nd.min(axis=0) - 0.01, nd.max(axis=0) + 0.01
    polygon = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]

    cut = xyz[_in_box(xyz, u, 0.1)]
    mask = select_points(cut, polygon, vp)
    sel = cut[mask]
    assert len(sel) == len(cut) > 0  # the polygon covers the whole bounds box
    assert np.all(_distance_to_box(sel, u) <= 0.15)
    # nothing on the far side of the axis from the panel (panel-0 faces north, -z)
    assert np.all(sel[:, 2] < 0)

    # points outside the polygon or behind the camera are not selected
    far_left = c - axes[0] * 3.0
    behind = eye + axes[2] * 1.0
    assert not select_points(np.vstack([far_left, behind]), polygon, vp).any()


def test_measures_a_selected_panel_like_detection():
    xyz, _ = _tower()
    u = _truth("panel-0")
    sel = xyz[_in_box(xyz, u, 0.05)]
    m = measure_selection(sel, AXIS_POINT, AXIS_DIR, ORIGIN, 0.5)
    assert m is not None
    assert m["kind"] == "panel"
    da = (m["azimuthGridDeg"]["value"] - u["azimuthDeg"] + 180.0) % 360.0 - 180.0
    assert abs(da) <= 2.0
    assert abs(m["widthM"]["value"] - u["widthM"]) <= 0.05
    assert abs(m["heightM"]["value"] - u["heightM"]) <= 0.05
    assert m["widthM"]["basis"] == "measured"
    assert m["support"] == len(sel)
    assert m["convergenceDeg"] == 0.5


def test_lone_face_still_measures():
    xyz, _ = _tower()
    u = _truth("radio-180")
    local = _box_local(xyz, u)
    _, _, ext = _frame(u)
    front = (
        (np.abs(local[:, 2] - ext[2] / 2) < 0.01)
        & (np.abs(local[:, 0]) <= ext[0] / 2)
        & (np.abs(local[:, 1]) <= ext[1] / 2)
    )
    sel = xyz[front]
    assert len(sel) >= FLAG_MIN_POINTS
    m = measure_selection(sel, AXIS_POINT, AXIS_DIR, ORIGIN, None)
    assert m is not None
    assert m["depthM"]["basis"] == "inferred"
    assert m["support"] == len(sel)


def test_too_few_points_is_none():
    xyz, _ = _tower()
    sel = xyz[_in_box(xyz, _truth("panel-0"), 0.05)][:40]
    assert measure_selection(sel, AXIS_POINT, AXIS_DIR, ORIGIN, None) is None


def test_not_measured_has_no_values():
    anchor = np.array([1.0, 27.5, -2.0])
    m = not_measured(anchor, ORIGIN, 12, 0.3)
    assert set(m) == {"kind", "box", "support", "convergenceDeg"}
    assert m["kind"] == "other"
    assert m["box"]["extents"] == [PLACEHOLDER_M] * 3 == [0.2, 0.2, 0.2]
    assert m["box"]["axes"] == [[1, 0, 0], [0, 0, 1], [0, 1, 0]]
    assert np.allclose(m["box"]["centre"], to_project(anchor, ORIGIN))
    assert m["support"] == 12
    assert m["convergenceDeg"] == 0.3


def test_a_face_detection_leaves_out_still_measures():
    # the lower 0.2 m of the radio's front: too short for a box of `pair_faces` (MIN_H), so the
    # unit is built from the face alone
    xyz, _ = _tower()
    u = _truth("radio-180")
    local = _box_local(xyz, u)
    _, _, ext = _frame(u)
    strip = (
        (np.abs(local[:, 2] - ext[2] / 2) < 0.01)
        & (np.abs(local[:, 0]) <= ext[0] / 2)
        & (local[:, 1] >= -ext[1] / 2)
        & (local[:, 1] <= -ext[1] / 2 + 0.2)
    )
    sel = xyz[strip]
    m = measure_selection(sel, AXIS_POINT, AXIS_DIR, ORIGIN, None)
    assert m is not None
    assert m["kind"] == "other"
    assert abs(m["widthM"]["value"] - ext[0]) <= 0.05
    assert abs(m["heightM"]["value"] - 0.2) <= 0.05
    assert m["depthM"]["basis"] == "inferred"
