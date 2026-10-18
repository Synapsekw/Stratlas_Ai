"""captures.py: which layer takes which date shift, held to the workspace's answers by the
shared fixture (packages/schema/src/__fixtures__/date-shift/membership.json)."""

import json
from pathlib import Path

import pytest

from aio_pipelines.captures import (
    capture_shift,
    capture_similarity,
    date_shift,
    date_similarity,
    layer_captures,
    local_delta,
    shift_transform,
)
from aio_pipelines.similarity import Similarity

FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "packages"
    / "schema"
    / "src"
    / "__fixtures__"
    / "date-shift"
    / "membership.json"
)
CASES = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]


@pytest.mark.parametrize("case", CASES, ids=lambda c: c["name"])
def test_shifts_match_the_shared_fixture(case):
    m = case["manifest"]
    got = {}
    for layer in m["layers"]:
        east, north = date_shift(m, layer["id"])
        if (east, north) != (0.0, 0.0):
            got[layer["id"]] = {"eastM": east, "northM": north}
    assert got == case["expected"]


def _manifest(layer_name: str) -> dict:
    return {
        "captures": [
            {"id": "c1", "label": "First", "date": "2020-12-31", "lineUp": {"eastM": 1.5, "northM": 0.5}},
            {"id": "c2", "label": "Second", "date": "2021-02-01"},
        ],
        "layers": [
            {"kind": "pointcloud", "id": "x", "name": layer_name},
        ],
    }


@pytest.mark.parametrize("name", ["Scan 31 Dec 2020", "Scan 20201231", "Scan December 31, 2020"])
def test_date_spellings_match_the_workspace(name):
    m = _manifest(name)
    assert layer_captures(m) == {"x": "c1"}
    assert date_shift(m, "x") == (1.5, 0.5)


def test_shift_transform_moves_elements_12_and_14():
    t = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1]
    out = shift_transform(t, (2.0, -1.0))
    assert out is not None
    assert out[12] == 12.0 and out[14] == 31.0 and out[13] == 20 and t[12] == 10
    ident = shift_transform(None, (2.0, 3.0))
    assert ident is not None and ident[12] == 2.0 and ident[14] == -3.0 and ident[0] == 1
    assert shift_transform(None, (0.0, 0.0)) is None
    assert shift_transform(t, (0.0004, 0.0)) == t
    assert local_delta((2.0, 3.0)) == (2.0, -3.0)


def test_no_shift_for_a_change_result():
    m = _manifest("Scan 20201231")
    m["layers"].append(
        {
            "kind": "mesh",
            "id": "ch",
            "name": "Change 20201231",
            "capture": "c1",
            "derived": {"kind": "change"},
        }
    )
    assert date_shift(m, "ch") == (0.0, 0.0)
    assert date_shift(m, "x") == (1.5, 0.5)
    assert capture_shift(m, "c1") == (1.5, 0.5)
    assert capture_shift(m, "c2") == (0.0, 0.0)
    assert capture_shift(m, "nope") == (0.0, 0.0)


def test_similarity_reads_lineup_turn():
    m = _manifest("Scan 20201231")
    turn = {"rotationDeg": 0.5, "scale": 1.001, "pivotE": 500100.0, "pivotN": 3200200.0}
    m["captures"][0]["lineUp"] = {"eastM": 2.0, "northM": 0.0}
    m["captures"][0]["lineUpTurn"] = turn
    m["layers"].append(
        {
            "kind": "mesh",
            "id": "ch",
            "name": "Change 20201231",
            "capture": "c1",
            "derived": {"kind": "change"},
        }
    )
    want = Similarity(2.0, 0.0, 0.5, 1.001, 500100.0, 3200200.0)
    assert capture_similarity(m, "c1") == want
    assert date_similarity(m, "x") == want
    assert date_similarity(m, "x").to_turn() == turn
    # the shift alone is unchanged for the readers that only take a shift
    assert capture_shift(m, "c1") == (2.0, 0.0)
    assert date_shift(m, "x") == (2.0, 0.0)
    # the same rules as date_shift: nothing for a change result, an unknown or a plain date
    for s in (date_similarity(m, "ch"), capture_similarity(m, "c2"), capture_similarity(m, "nope")):
        assert s.is_identity()
    # a date with a shift only is a pure shift; a turn with no shift still turns
    del m["captures"][0]["lineUpTurn"]
    assert capture_similarity(m, "c1") == Similarity(2.0, 0.0)
    m["captures"][0]["lineUp"] = {"eastM": 0.0, "northM": 0.0}
    m["captures"][0]["lineUpTurn"] = turn
    assert capture_similarity(m, "c1").has_turn()
    assert capture_similarity(m, "c1").apply_en(500100.0, 3200200.0) == pytest.approx((500100.0, 3200200.0))
