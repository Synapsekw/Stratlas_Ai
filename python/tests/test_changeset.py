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
    # the app stores a reason code with its gap or the job's own words
    data["volumesMissing"] = {"reason": "misaligned", "shiftM": 2.01, "at": "2026-10-19T09:00:00Z"}
    assert validate_change_set(data)["volumesMissing"]["shiftM"] == 2.01


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


def test_long_ids_differing_only_past_the_cut_stay_distinct():
    scope = "a" * 70
    a = change_set_id("c" * 100 + "1", "d", "change.raster", scope)
    b = change_set_id("c" * 100 + "2", "d", "change.raster", scope)
    assert a != b
    assert len(a) <= 120 and len(b) <= 120
    assert SET_ID.match(a) and SET_ID.match(b)


def test_change_set_id_refuses_a_bad_scope_id():
    with pytest.raises(ValueError):
        change_set_id("c1", "c2", "change.raster", "pad a")


# ------------------------------------------------------------- one layer per area, manifest lock


def _project(tmp_path, layers=()):
    (tmp_path / "manifest.json").write_text(
        json.dumps({"schema": "aio.project/1", "layers": list(layers)}), "utf-8"
    )
    return tmp_path


def _ids(project):
    return [x["id"] for x in json.loads((project / "manifest.json").read_text("utf-8"))["layers"]]


def _change_layer(lid, set_id="c1-c2-raster-area-pad-a", source=("ortho-a", "ortho-b"), **extra):
    return {
        "kind": "raster",
        "id": lid,
        "name": lid,
        "visible": True,
        "derived": {"kind": "change", "from": "c1", "to": "c2", "changeId": set_id, "source": list(source)},
        "src": {"path": f"change/{set_id}/heat/tiles.json"},
        **extra,
    }


def test_an_area_s_layer_id_is_shared_by_its_producers():
    from aio_pipelines.change.derived import area_layer_id

    assert area_layer_id("c1", "c2", "pad-a") == "c1-c2-change-area-pad-a"
    assert area_layer_id("c1", "c2", "pad-a") != change_set_id("c1", "c2", "change.raster", "pad-a")


def test_the_area_layer_is_added_once_and_a_later_producer_keeps_or_replaces_it():
    from aio_pipelines.change.derived import place_area_layer

    own = {"kind": "raster", "id": "ortho-a", "name": "Ortho", "visible": True}
    m = {"layers": [own]}
    imagery = _change_layer("L")
    place_area_layer(m, imagery, replace=True)
    m["layers"][1]["visible"] = False
    volumes = _change_layer("L", "c1-c2-surface-area-pad-a", source=("dsm-a", "dsm-b"))
    place_area_layer(m, volumes, replace=False)
    [kept] = [x for x in m["layers"] if x["id"] == "L"]
    # the imagery heat map stays, hidden as the person left it, and takes the volume sources too
    assert kept["src"] == imagery["src"]
    assert kept["visible"] is False
    assert kept["derived"]["source"] == ["ortho-a", "ortho-b", "dsm-a", "dsm-b"]
    place_area_layer(m, imagery, replace=True)
    [again] = [x for x in m["layers"] if x["id"] == "L"]
    assert again["visible"] is False
    assert again["derived"]["source"] == ["ortho-a", "ortho-b", "dsm-a", "dsm-b"]
    assert [x["id"] for x in m["layers"]] == ["ortho-a", "L"]
    assert m["layers"][0] is own


def test_the_area_layer_drops_the_set_s_old_heat_and_regions_rows_and_nothing_else():
    from aio_pipelines.change.derived import place_area_layer

    sid = "c1-c2-raster-area-pad-a"
    m = {
        "layers": [
            {"kind": "raster", "id": "ortho-a", "name": "Ortho", "visible": True},
            _change_layer(f"{sid}-heat", sid),
            _change_layer(f"{sid}-regions", sid, kind="vector"),
            _change_layer("c1-c2-raster-heat", "c1-c2-raster"),
        ]
    }
    place_area_layer(m, _change_layer("L", sid), replace=True, drop=[f"{sid}-heat", f"{sid}-regions"])
    assert [x["id"] for x in m["layers"]] == ["ortho-a", "c1-c2-raster-heat", "L"]


def test_the_area_layer_never_replaces_a_layer_of_the_person_s_own():
    from aio_pipelines.change.derived import place_area_layer

    m = {"layers": [{"kind": "raster", "id": "L", "name": "Mine", "visible": True}]}
    with pytest.raises(JobError, match="of its own"):
        place_area_layer(m, _change_layer("L"), replace=True)


def test_two_jobs_writing_the_manifest_at_once_both_keep_their_layer(tmp_path):
    import threading

    from aio_pipelines.change.derived import upsert_layer

    project = _project(tmp_path, [{"kind": "raster", "id": "ortho-a", "name": "O", "visible": True}])
    start = threading.Barrier(2)
    errors: list[BaseException] = []

    def write(prefix):
        try:
            start.wait()
            for i in range(25):
                upsert_layer(project, _change_layer(f"{prefix}-{i}"))
        except BaseException as e:
            errors.append(e)

    threads = [threading.Thread(target=write, args=(p,)) for p in ("raster", "surface")]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errors == []
    ids = _ids(project)
    assert len(ids) == 51
    assert {f"{p}-{i}" for p in ("raster", "surface") for i in range(25)} <= set(ids)


def test_the_manifest_lock_holds_across_processes_and_times_out(tmp_path):
    import subprocess
    import sys
    import time

    from aio_pipelines.runtime import manifest_lock

    project = _project(tmp_path)
    src = Path(__file__).resolve().parents[1] / "src"
    holder = subprocess.Popen(
        [
            sys.executable,
            "-c",
            "import sys, time; from pathlib import Path; sys.path.insert(0, sys.argv[1]);"
            "from aio_pipelines.runtime import manifest_lock\n"
            "with manifest_lock(Path(sys.argv[2])):\n"
            "    print('held', flush=True); time.sleep(30)",
            str(src),
            str(project),
        ],
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        assert holder.stdout.readline().strip() == "held"
        t0 = time.monotonic()
        with pytest.raises(JobError, match="manifest"), manifest_lock(project, timeout_s=0.5):
            pass
        assert time.monotonic() - t0 >= 0.4
    finally:
        holder.kill()
        holder.wait()
    # the holder is gone: its lock went with it
    with manifest_lock(project, timeout_s=5):
        pass
