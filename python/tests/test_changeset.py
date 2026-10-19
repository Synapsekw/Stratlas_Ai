"""The aio.change/1 writer shared by the change pipelines, against the zod schema's fixtures."""

import json
from pathlib import Path

import pytest

from aio_pipelines.change.changeset import (
    SET_ID,
    change_set,
    change_set_id,
    check_scope,
    read_change_set,
    validate_change_set,
    write_change_set,
)
from aio_pipelines.runtime import JobError

# The same JSON fixtures the zod schema test reads (packages/schema/src/change.test.ts).
FIXTURES = Path(__file__).resolve().parents[2] / "packages" / "schema" / "src" / "__fixtures__" / "change"


def fixtures():
    return sorted(FIXTURES.glob("*.json"))


def test_the_shared_fixtures_are_there():
    assert fixtures(), f"no change set fixtures in {FIXTURES}"


@pytest.mark.parametrize("path", fixtures(), ids=lambda p: p.name)
def test_the_writer_round_trips_every_fixture(tmp_path, path):
    data = json.loads(path.read_text("utf-8"))
    out = tmp_path / "change" / path.name
    written = write_change_set(out, data)
    assert written == data
    assert json.loads(out.read_text("utf-8")) == data
    assert read_change_set(out) == data


def region(iid, verdict="changed", **extra):
    return {"kind": "region", "id": iid, "verdict": verdict, **extra}


def test_a_recompute_keeps_reviews_by_item_id_and_backs_up_the_old_file(tmp_path):
    out = tmp_path / "change" / "c1-c2-raster.json"
    review = {"status": "dismissed", "by": "reviewer", "at": "2026-10-06T09:00:00Z", "note": "Shadow"}
    first = change_set(
        "c1-c2-raster", "c1", "c2", "change.raster", [region("r1", review=review), region("r2")]
    )
    write_change_set(out, first)
    again = change_set(
        "c1-c2-raster",
        "c1",
        "c2",
        "change.raster",
        [region("r1", score=0.4), region("r3")],
        stats={"items": 2},
    )
    merged = write_change_set(out, again)
    assert merged["items"][0]["review"] == review
    assert "review" not in merged["items"][1]
    assert (out.parent / "c1-c2-raster.json.bak").exists()
    assert json.loads((out.parent / "c1-c2-raster.json.bak").read_text("utf-8"))["items"][1]["id"] == "r2"


@pytest.mark.parametrize(
    "change",
    [
        {"schema": "aio.change/2"},
        {"id": "../evil"},
        {"to": "c1"},
        {"items": [region("a"), region("a")]},
        {"items": [{"kind": "issue", "id": "i", "verdict": "moved"}]},
        {"items": [{"kind": "blob", "id": "i", "verdict": "new"}]},
        {"items": [region("a", review={"status": "maybe"})]},
    ],
)
def test_invalid_change_sets_are_refused(change):
    base = change_set("c1-c2-raster", "c1", "c2", "change.raster", [region("r1")])
    with pytest.raises(JobError):
        validate_change_set({**base, **change})


def test_set_ids_are_readable_and_file_name_safe():
    assert change_set_id("c1", "c2", "change.raster") == "c1-c2-raster"
    assert change_set_id("2026 Jan", "2026/Jun", "issues") == "2026-Jan-2026-Jun-issues"


def test_change_set_records_the_shifts():
    plain = change_set("c1-c2-raster", "c1", "c2", "change.raster", [], line_up=((0.0, 0.0), (0.0, 0.0)))
    assert "lineUp" not in plain
    assert "lineUp" not in change_set("c1-c2-raster", "c1", "c2", "change.raster", [])
    cs = change_set(
        "c1-c2-raster", "c1", "c2", "change.raster", [], line_up=((0.0, -0.0), (-2.00049, 1.23456))
    )
    assert cs["lineUp"] == {"from": {"eastM": 0.0, "northM": 0.0}, "to": {"eastM": -2.0, "northM": 1.235}}
    assert json.dumps(cs["lineUp"]).count("-0.0") == 0


def test_change_set_follows_a_turned_line_up():
    from aio_pipelines.similarity import Similarity

    turn = {"rotationDeg": 0.5, "scale": 1.0, "pivotE": 500100.0, "pivotN": 3200200.0}
    plain = Similarity(0.0, 0.0)
    turned = Similarity.from_line_up({"eastM": 2.0, "northM": 0.0}, turn)
    cs = change_set("c1-c2-raster", "c1", "c2", "change.raster", [], line_up=(plain, turned))
    assert cs["lineUp"] == {"from": {"eastM": 0.0, "northM": 0.0}, "to": {"eastM": 2.0, "northM": 0.0}}
    # the turn rides beside lineUp (a strict object), for the side that has one
    assert cs["lineUpTurn"] == {"to": turn}
    # a shift alone writes no turn; a turn alone still stamps both
    shifted = change_set(
        "c1-c2-raster", "c1", "c2", "change.raster", [], line_up=(plain, Similarity(2.0, 0.0))
    )
    assert "lineUpTurn" not in shifted and shifted["lineUp"]["to"] == {"eastM": 2.0, "northM": 0.0}
    only = change_set(
        "c1-c2-raster", "c1", "c2", "change.raster", [],
        line_up=(Similarity.from_line_up(None, turn), plain),
    )  # fmt: skip
    assert only["lineUp"] == {"from": {"eastM": 0.0, "northM": 0.0}, "to": {"eastM": 0.0, "northM": 0.0}}
    assert only["lineUpTurn"] == {"from": turn}
    # nothing at all for two plain dates
    none = change_set("c1-c2-raster", "c1", "c2", "change.raster", [], line_up=(plain, plain))
    assert "lineUp" not in none and "lineUpTurn" not in none
    assert validate_change_set(cs) == cs


def test_a_scoped_id_never_equals_the_whole_map_id():
    assert change_set_id("c1", "c2", "change.raster", "pad-a") == "c1-c2-raster-area-pad-a"
    assert change_set_id("c1", "c2", "change.raster", "pad-a") != change_set_id("c1", "c2", "change.raster")


def test_long_scoped_ids_stay_short_and_distinct():
    a = change_set_id("c" * 60, "d" * 60, "change.raster", "a" * 70 + "1")
    b = change_set_id("c" * 60, "d" * 60, "change.raster", "a" * 70 + "2")
    assert a != b
    for sid in (a, b):
        assert len(sid) <= 120
        assert SET_ID.match(sid)
        assert "-area-" in sid


def test_a_change_set_carries_its_scope():
    scope = {"id": "pad-a", "name": "Pad A"}
    data = change_set("c1-c2-raster-area-pad-a", "c1", "c2", "change.raster", [], scope=scope)
    assert data["scope"] == scope
    assert validate_change_set(data)["scope"] == scope
    assert "scope" not in change_set("c1-c2-raster", "c1", "c2", "change.raster", [])


def test_a_set_with_volumes_missing_still_validates():
    data = change_set("c1-c2-raster", "c1", "c2", "change.raster", [])
    data["volumesMissing"] = {"reason": "Misaligned by 3 m", "at": "2026-10-19T09:00:00Z"}
    assert validate_change_set(data)["volumesMissing"]["reason"] == "Misaligned by 3 m"
    assert "volumesMissing" not in change_set("c1-c2-raster", "c1", "c2", "change.raster", [])


def test_check_scope_refuses_a_scope_without_a_mask():
    with pytest.raises(JobError, match="needs its mask"):
        check_scope({"scope": {"id": "pad-a", "name": "Pad A"}})
    assert check_scope({}) is None
    ring = [[0, 0], [1, 0], [1, 1], [0, 0]]
    assert check_scope({"scope": {"id": "pad-a", "name": "Pad A"}, "mask": ring}) == {
        "id": "pad-a",
        "name": "Pad A",
    }
    for bad in ({"id": "pad a", "name": "x"}, {"id": "p", "name": ""}, {"id": "p", "name": "x" * 121}, "p"):
        with pytest.raises(JobError, match="scope must be"):
            check_scope({"scope": bad, "mask": ring})
