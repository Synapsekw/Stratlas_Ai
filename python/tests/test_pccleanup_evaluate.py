"""The numpy cleanup evaluator against the shared vectors (packages/schema/test-data), the same
cases the TS evaluator checks (packages/pointcloud/src/cleanup/evaluate.test.ts)."""

import json
from pathlib import Path

import numpy as np
import pytest

from aio_pipelines.pointcloud_cleanup.evaluate import (
    CLASS_HIDDEN,
    HIDDEN,
    STATE_NAMES,
    evaluate,
    in_polygon,
    kept_for_save,
)
from aio_pipelines.pointcloud_cleanup.recipe import validate_recipe
from aio_pipelines.runtime import JobError

VECTORS = Path(__file__).resolve().parents[2] / "packages" / "schema" / "test-data" / "pccleanup-vectors.json"
V = json.loads(VECTORS.read_text("utf-8"))
XYZ = np.array([p["xyz"] for p in V["points"]], dtype=np.float64)
CLS = np.array([p["cls"] for p in V["points"]], dtype=np.uint8)


@pytest.mark.parametrize("case", V["cases"], ids=[c["name"] for c in V["cases"]])
def test_vectors(case):
    state, cls = evaluate(validate_recipe(case["recipe"]), XYZ, CLS)
    assert [STATE_NAMES[s] for s in state] == case["expect"]["state"]
    assert cls.tolist() == case["expect"]["cls"]


def test_save_keeps_kept_and_hidden_only():
    state = np.array([0, 1, 2, 3, 4], dtype=np.uint8)
    assert kept_for_save(state).tolist() == [True, True, False, False, False]


def test_even_odd_rule():
    ring = np.array([[0, 0], [4, 4], [4, 0], [0, 4]], dtype=np.float64)
    inside = in_polygon(ring, np.array([1.0, 2.0]), np.array([2.0, 1.0]))
    assert inside.tolist() == [True, False]


def empty(**over):
    return {"schema": "aio.pccleanup/1", "layerId": "a", "hiddenClasses": [], "regions": [], **over}


def region(**over):
    return {
        "id": "r",
        "shape": "box",
        "viewProj": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        "polygon": [[-1, -1], [1, -1], [1, 1], [-1, 1]],
        "action": {"kind": "delete"},
        **over,
    }


def test_noise_copy_class_is_the_starting_class():
    # The caller passes the noise copy's classes: a point the noise run marked 7 starts as 7, and
    # hiding class 7 removes it on save, even under a hide selection.
    original = np.array([2, 2], dtype=np.uint8)
    noise_copy = np.array([7, 2], dtype=np.uint8)
    xyz = np.array([[0.1, 0.1, 0.0], [0.2, 0.2, 0.0]])
    recipe = validate_recipe(empty(hiddenClasses=[7], regions=[region(action={"kind": "hide"})]))
    state, cls = evaluate(recipe, xyz, noise_copy)
    assert state.tolist() == [CLASS_HIDDEN, HIDDEN]
    assert cls.tolist() == [7, 2]
    assert kept_for_save(state).tolist() == [False, True]
    state, _ = evaluate(recipe, xyz, original)
    assert kept_for_save(state).tolist() == [True, True]


@pytest.mark.parametrize(
    "raw, message",
    [
        ({**empty(), "schema": "aio.pccleanup/2"}, "aio.pccleanup/1"),
        (empty(regions=[region()] * 201), "200"),
        (empty(regions=[region(polygon=[[0, 0], [1, 0], [1, 1]])]), "4 corners"),
        (empty(regions=[region(shape="lasso", polygon=[[0, 0]] * 257)]), "256"),
        (empty(regions=[region(viewProj=[1] * 15)]), "16 numbers"),
        (empty(regions=[region(action={"kind": "paint"})]), "hide, delete or class"),
        (empty(hiddenClasses=[300]), "0 to 255"),
        (empty(height={"min": 5, "max": 1}), "lowest"),
        (empty(clipBox={"center": [0, 0, 0], "size": [0, 1, 1], "yaw": 0, "keep": "inside"}), "size"),
        (
            empty(noise={"path": "clouds/x.copc.laz", "params": {}, "marked": 0, "total": 0, "runId": "j"}),
            "edits/pointcloud",
        ),
    ],
)
def test_validate_refuses(raw, message):
    with pytest.raises(JobError, match=message):
        validate_recipe(raw)


def test_validate_checks_the_layer():
    with pytest.raises(JobError, match="another layer"):
        validate_recipe(empty(), layer_id="b")
    assert validate_recipe(empty(), layer_id="a")["layerId"] == "a"
