"""Association needs observed connection points, not merely the nearest fitted pipe."""

from copy import deepcopy

import numpy as np
import pytest

from aio_pipelines.engineer.supports import _parents


def device():
    return {
        "id": "device",
        "kind": "equipment-box",
        "centre": [0, 17, -2],
        "size": [0.5, 1.8, 0.18],
        "azimuthDeg": 0,
        "tiltDeg": 0,
    }


def pipe(ident="pipe", x=0):
    return {
        "id": ident,
        "kind": "mounting-pipe",
        "size": [0.13, 4, 0.13],
        "path": [[x, 15, -1.76], [x, 19, -1.76]],
    }


def bridge(p, partial=False):
    # Sample two short connection surfaces, with the device skin and pipe wall excluded.
    back = np.array([0, -1.91])
    delta = np.array(p["path"][0])[[0, 2]] - back
    gap = np.linalg.norm(delta)
    stop = gap - p["size"][0] / 2 - 0.025
    along = np.linspace(0.031, 0.039 if partial else stop - 0.001, 16)
    xz = back + along[:, None] * delta / gap
    return np.concatenate([np.column_stack([xz[:, 0], np.full(len(xz), y), xz[:, 1]]) for y in (16.5, 17.5)])


def test_close_pipe_can_use_observed_bridge_across_the_available_free_interval():
    d, p = device(), pipe()
    before = deepcopy([d, p])
    assert _parents([d], [p], bridge(p), lambda: None) == {d["id"]: p["id"]}
    assert [d, p] == before


@pytest.mark.parametrize("angle", [0, 37, 132])
def test_close_connection_is_independent_of_source_frame_and_point_order(angle):
    d, p = device(), pipe()
    xyz = bridge(p)
    theta = np.radians(angle)
    r = np.array([[np.cos(theta), 0, -np.sin(theta)], [0, 1, 0], [np.sin(theta), 0, np.cos(theta)]])
    shift = np.array([51, 8, -24])
    d["centre"] = (np.array(d["centre"]) @ r.T + shift).tolist()
    d["azimuthDeg"] = angle
    p["path"] = (np.array(p["path"]) @ r.T + shift).tolist()
    xyz = np.concatenate([xyz, xyz])[::-1] @ r.T + shift
    assert _parents([d], [p], xyz, lambda: None) == {d["id"]: p["id"]}


def test_nearby_pipe_without_a_spanning_connection_stays_unassociated():
    d, p = device(), pipe()
    assert _parents([d], [p], np.empty((0, 3)), lambda: None) == {}
    # Many returns in one small patch do not establish the connection across the gap.
    assert _parents([d], [p], np.tile(bridge(p, partial=True), (8, 1)), lambda: None) == {}


def test_two_supported_connections_with_no_unique_parent_remain_ambiguous():
    pipes = [pipe("left", -0.05), pipe("right", 0.05)]
    points = np.concatenate([bridge(p) for p in pipes])
    for order in (pipes, pipes[::-1]):
        assert _parents([device()], order, points, lambda: None) == {}
