"""spaces: the frame (crs and origin) a layer's files are written in, mirroring ``layerFrame`` in
packages/schema/src/spaces.ts."""

from __future__ import annotations

import pytest

from aio_pipelines.runtime import JobError
from aio_pipelines.spaces import (
    in_project_frame,
    layer_frame,
    layer_frame_origin,
    one_frame,
    require_project_frame,
)

GRID = {"epsg": 32650}
LOCAL = {"local": "flyability"}


def manifest(layers, spaces=None):
    m = {"crs": GRID, "origin": [500000.0, 2700000.0, 50.0], "layers": layers}
    if spaces is not None:
        m["spaces"] = spaces
    return m


TANK = {"id": "tank", "name": "Tank", "crs": LOCAL, "origin": [1.0, 2.0, 3.0]}


def test_a_layer_without_a_space_is_read_against_the_project_origin():
    layer = {"id": "a"}
    m = manifest([layer], [TANK])
    assert layer_frame_origin(m, layer) == [500000.0, 2700000.0, 50.0]
    assert layer_frame(m, layer)["crs"] == GRID


def test_a_layer_in_a_listed_space_is_read_against_the_space_origin():
    layer = {"id": "a", "space": "tank"}
    m = manifest([{"id": "b"}, layer], [TANK])
    assert layer_frame_origin(m, layer) == [1.0, 2.0, 3.0]
    assert layer_frame(m, layer)["crs"] == LOCAL


def test_a_layer_of_a_space_the_project_does_not_list_falls_back_to_the_project():
    layer = {"id": "a", "space": "gone"}
    m = manifest([layer], [TANK])
    assert layer_frame_origin(m, layer) == [500000.0, 2700000.0, 50.0]


def test_a_project_without_an_origin_reads_against_zero():
    layer = {"id": "a"}
    assert layer_frame_origin({"layers": [layer]}, layer) == [0.0, 0.0, 0.0]


def test_the_implicit_main_space_is_the_project_unless_every_layer_names_a_listed_space():
    listed_main = {"id": "main", "name": "Main", "crs": LOCAL, "origin": [9.0, 9.0, 9.0]}
    a = {"id": "a", "space": "main"}
    # one layer has no space: the implicit main (the project's frame) wins
    assert layer_frame_origin(manifest([a, {"id": "b"}], [listed_main]), a) == [500000.0, 2700000.0, 50.0]
    # every layer names a space: the listed main is used
    assert layer_frame_origin(manifest([a], [listed_main]), a) == [9.0, 9.0, 9.0]


def test_layers_of_one_frame_pass_and_of_two_frames_are_refused():
    a, b, c = (
        {"id": "a", "name": "Site"},
        {"id": "b", "name": "Later"},
        {"id": "c", "name": "Inside", "space": "tank"},
    )
    m = manifest([a, b, c], [TANK])
    one_frame(m, [a, b], "compare them")
    with pytest.raises(JobError, match="different spaces"):
        one_frame(m, [a, c], "compare them")


def test_a_project_frame_job_takes_a_space_of_the_project_crs_only_when_asked():
    a = {"id": "a", "name": "Site"}
    same_crs = {"id": "b", "name": "Shifted", "space": "near"}
    local = {"id": "c", "name": "Inside", "space": "tank"}
    near = {"id": "near", "name": "Near", "crs": GRID, "origin": [500100.0, 2700000.0, 50.0]}
    m = manifest([a, same_crs, local], [TANK, near])
    assert in_project_frame(m, a)
    assert not in_project_frame(m, same_crs) and in_project_frame(m, same_crs, origin=False)
    assert not in_project_frame(m, local, origin=False)
    require_project_frame(m, [a, same_crs], "so no", origin=False)
    with pytest.raises(JobError, match='"Inside" is in a space with its own local coordinates'):
        require_project_frame(m, [a, local], "so it cannot be exported", origin=False)
