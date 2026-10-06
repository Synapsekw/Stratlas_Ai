"""The aio.change/1 writer shared by the change pipelines, against the zod schema's fixtures."""

import json
from pathlib import Path

import pytest

from aio_pipelines.change.changeset import (
    change_set,
    change_set_id,
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
