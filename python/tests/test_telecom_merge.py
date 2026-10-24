"""Re-run merge of antenna units (spec section 5)."""

from __future__ import annotations

import copy
import json
import re
from pathlib import Path

from aio_pipelines.telecom.merge import (
    MATCH_RADIUS_M,
    date_frame_delta,
    in_capture_frame,
    merge_runs,
    merge_with_sources,
    next_name,
    person_owned,
)
from aio_pipelines.telecom.pipeline import DELETIONS_SCHEMA

CONTRACT = Path(__file__).resolve().parents[2] / "packages/schema/src/__fixtures__/antennas-contract.json"
DELETIONS_CONTRACT = (
    Path(__file__).resolve().parents[2] / "packages/schema/src/__fixtures__/antenna-deletions-contract.json"
)
Q = {"basis": "measured", "residualM": 0.004, "support": 900, "coverage": 0.8}


def val(v):
    return {"value": v, "basis": "measured", "quality": dict(Q)}


def unit(centre, kind="panel", support=1000, azimuth=0.0, **extra):
    """A unit as the boxes step makes it (no id, name or status), or an old one with `extra`."""
    u = {
        "kind": kind,
        "kindBasis": "geometry",
        "box": {
            "centre": list(centre),
            "axes": [[1, 0, 0], [0, 0, 1], [0, 1, 0]],
            "extents": [0.3, 1.4, 0.15],
        },
        "support": support,
        "widthM": val(0.3),
        "heightM": val(1.4),
        "depthM": val(0.15),
        "convergenceDeg": 0.5,
        "photos": [],
        "user": {},
        "runId": "run-new",
        "createdAt": "2026-10-17T10:00:00Z",
    }
    if kind in ("panel", "short"):
        u["azimuthGridDeg"] = val(azimuth)
        u["downtiltDeg"] = val(2.0)
    u.update(extra)
    return u


def old(uid, name, centre, status, **extra):
    base = {
        "id": uid,
        "name": name,
        "status": status,
        "runId": "run-old",
        "createdAt": "2026-10-16T10:00:00Z",
    }
    return unit(centre, **{**base, **extra})


def prev(*units):
    return {"schema": "aio.antennas/1", "run": {"id": "run-old"}, "units": list(units)}


def by_id(units, uid):
    return next(u for u in units if u["id"] == uid)


def test_contract_match_radius():
    assert json.loads(CONTRACT.read_text("utf-8"))["matchRadiusM"] == MATCH_RADIUS_M


def test_merge_accepted_keeps_review_and_better_geometry():
    accepted = old(
        "ant-old-1",
        "A1",
        (100.0, 200.0, 30.0),
        "accepted",
        support=1000,
        user={"model": "X", "weightKg": 12.0},
    )
    # weaker new fit, 0.1 m away: review kept, geometry kept
    weaker = unit((100.1, 200.0, 30.0), support=900, azimuth=7.0)
    out = merge_runs(prev(accepted), [weaker], "run-new")
    assert len(out) == 1
    u = out[0]
    assert u["id"] == "ant-old-1" and u["name"] == "A1" and u["status"] == "accepted"
    assert u["user"] == {"model": "X", "weightKg": 12.0}
    assert u["box"]["centre"] == [100.0, 200.0, 30.0] and u["support"] == 1000
    assert u["azimuthGridDeg"]["value"] == 0.0 and u["runId"] == "run-old"
    # stronger new fit: geometry replaced, review still kept
    stronger = unit((100.1, 200.0, 30.0), support=1500, azimuth=7.0)
    u = merge_runs(prev(accepted), [stronger], "run-new")[0]
    assert u["id"] == "ant-old-1" and u["status"] == "accepted" and u["user"]["model"] == "X"
    assert u["box"]["centre"] == [100.1, 200.0, 30.0] and u["support"] == 1500
    assert u["azimuthGridDeg"]["value"] == 7.0 and u["runId"] == "run-new"
    assert u["createdAt"] == "2026-10-16T10:00:00Z"
    assert "notFoundInLatest" not in u


def test_merge_matched_unit_clears_not_found_flag():
    flagged = old("ant-old-1", "A1", (0.0, 0.0, 30.0), "accepted", notFoundInLatest=True)
    u = merge_runs(prev(flagged), [unit((0.05, 0.0, 30.0), support=10)], "run-new")[0]
    assert u["id"] == "ant-old-1" and "notFoundInLatest" not in u


def test_merge_rejected_stays_rejected():
    rejected = old("ant-old-2", "A2", (5.0, 5.0, 30.0), "rejected", support=100)
    before = copy.deepcopy(rejected)
    out = merge_runs(prev(rejected), [unit((5.0, 5.2, 30.0), support=5000, azimuth=40.0)], "run-new")
    assert out == [before]


def test_merge_drops_unmatched_drafts_and_flags_accepted():
    draft = old("ant-old-1", "A1", (0.0, 0.0, 30.0), "draft")
    rejected = old("ant-old-2", "A2", (3.0, 0.0, 30.0), "rejected")
    accepted = old("ant-old-3", "A3", (6.0, 0.0, 30.0), "accepted", user={"model": "Y"})
    far = unit((20.0, 0.0, 30.0))  # nothing old is near it
    out = merge_runs(prev(draft, rejected, accepted), [far], "run-new")
    ids = [u["id"] for u in out]
    assert "ant-old-1" not in ids and "ant-old-2" not in ids
    kept = by_id(out, "ant-old-3")
    assert (
        kept["notFoundInLatest"] is True and kept["status"] == "accepted" and kept["user"] == {"model": "Y"}
    )
    assert kept["box"] == accepted["box"]
    assert len(out) == 2


def test_merge_match_radius_and_kind():
    a = old("ant-old-1", "A1", (0.0, 0.0, 30.0), "draft", kind="panel")
    # same place, other kind, geometry basis: no match
    out = merge_runs(prev(a), [unit((0.0, 0.0, 30.0), kind="short")], "run-new")
    assert [u["id"] for u in out] == ["ant-new-1"]
    # same kind, just beyond the radius: no match
    out = merge_runs(prev(a), [unit((MATCH_RADIUS_M + 0.01, 0.0, 30.0))], "run-new")
    assert [u["id"] for u in out] == ["ant-new-1"]
    # within the radius: match, a draft takes the new geometry
    out = merge_runs(prev(a), [unit((0.2, 0.0, 30.0), support=10)], "run-new")
    assert [u["id"] for u in out] == ["ant-old-1"] and out[0]["box"]["centre"] == [0.2, 0.0, 30.0]
    assert out[0]["status"] == "draft" and out[0]["name"] == "A1"


def test_merge_ai_relabelled_matches_any_kind():
    ai = {
        "provider": "anthropic",
        "model": "m",
        "promptVersion": "1",
        "runId": "ai-1",
        "at": "2026-10-17T09:00:00Z",
    }
    relabelled = old(
        "ant-old-1",
        "A1",
        (0.0, 0.0, 30.0),
        "draft",
        kind="other",
        kindBasis="ai",
        ai=ai,
        user={"active": True},
    )
    new = unit((0.1, 0.0, 30.0), kind="panel", support=2000, azimuth=12.0)
    out = merge_runs(prev(relabelled), [new], "run-new")
    assert len(out) == 1
    u = out[0]
    assert u["id"] == "ant-old-1" and u["kind"] == "other" and u["kindBasis"] == "ai" and u["ai"] == ai
    assert u["box"]["centre"] == [0.1, 0.0, 30.0] and u["azimuthGridDeg"]["value"] == 12.0
    assert u["user"] == {"active": True}


def test_merge_new_units_are_drafts_named_after_existing():
    keep = old("ant-old-1", "A4", (0.0, 3.0, 30.0), "accepted")
    # three new units around a middle at (0, 0): north-east, south, west (clockwise: NE, S, W)
    south = unit((0.0, -2.0, 30.0))
    west = unit((-2.0, 0.0, 30.0))
    north_east = unit((1.5, 1.5, 30.0))
    out = merge_runs(prev(keep), [south, west, north_east], "run-b2")
    fresh = [u for u in out if u["id"] != "ant-old-1"]
    assert all(u["status"] == "draft" for u in fresh)
    assert [(u["name"], u["box"]["centre"][:2]) for u in fresh] == [
        ("A5", [1.5, 1.5]),
        ("A6", [0.0, -2.0]),
        ("A7", [-2.0, 0.0]),
    ]
    assert [u["id"] for u in fresh] == ["ant-b2-1", "ant-b2-2", "ant-b2-3"]
    assert all(re.match(r"^ant-[a-z0-9-]{1,60}$", u["id"]) for u in out)
    # a first run starts at A1
    first = merge_runs(None, [unit((0.0, 1.0, 30.0))], "run-a")
    assert first[0]["name"] == "A1" and first[0]["id"] == "ant-a-1" and first[0]["status"] == "draft"


def test_merge_new_ids_stay_unique_and_short():
    long_run = "run-" + "x" * 60
    out = merge_runs(None, [unit((float(i), 0.0, 30.0)) for i in range(12)], long_run)
    ids = [u["id"] for u in out]
    assert len(set(ids)) == 12
    assert all(re.match(r"^ant-[a-z0-9-]{1,60}$", i) for i in ids)
    # the same run id again (a second job with it): an existing id is never handed out twice
    clash = old("ant-a-1", "A1", (50.0, 0.0, 30.0), "accepted")
    again = merge_runs(prev(clash), [unit((0.0, 0.0, 30.0))], "run-a")
    assert sorted(u["id"] for u in again) == ["ant-a-1", "ant-a-2"]


def test_merge_takes_new_photos_only_when_found():
    photo = [{"layer": "ph", "id": "p1", "score": 0.9}]
    a = old("ant-old-1", "A1", (0.0, 0.0, 30.0), "accepted", photos=photo, crop="telecom/crops/ant-old-1.jpg")
    u = merge_runs(prev(a), [unit((0.0, 0.0, 30.0))], "run-new")[0]
    assert u["photos"] == photo and u["crop"] == "telecom/crops/ant-old-1.jpg"
    newer = [{"layer": "ph", "id": "p2", "score": 0.7}]
    u = merge_runs(prev(a), [unit((0.0, 0.0, 30.0), photos=newer)], "run-new")[0]
    assert u["photos"] == newer and "crop" not in u


def test_previous_units_move_into_the_new_date_frame():
    # stored = drawn - own shift, so A's stored point + (shift A - shift B) is B's stored point
    assert date_frame_delta((3.0, -2.0), (-1.0, 1.5)) == (4.0, -3.5)
    assert date_frame_delta((2.0, 1.0), (2.0, 1.0)) == (0.0, 0.0)
    prev = {"run": {"captureId": "a"}, "units": [{**unit((10.0, 20.0, 30.0)), "id": "ant-a-1"}]}
    moved = in_capture_frame(prev, (4.0, -3.5))
    assert moved["units"][0]["box"]["centre"] == [14.0, 16.5, 30.0]
    assert prev["units"][0]["box"]["centre"] == [10.0, 20.0, 30.0]  # the caller's copy is untouched
    assert moved["units"][0]["box"]["axes"] == prev["units"][0]["box"]["axes"]
    assert in_capture_frame(prev, (0.0, 0.0)) is prev


def test_flagged_absorbs_a_new_unit_of_another_kind():
    flagged = old(
        "ant-old-1",
        "A1",
        (0.0, 0.0, 30.0),
        "accepted",
        kind="other",
        kindBasis="user",
        origin="flagged",
        support=10,
        centreHeightM={"value": 30.0, "basis": "user"},
    )
    new = unit((0.1, 0.0, 30.0), kind="panel", support=5000)
    out = merge_with_sources(prev(flagged), [new], "run-new")
    assert len(out) == 1
    u, src = out[0]
    assert src == 0
    assert u["kind"] == "other"
    assert u["box"] == flagged["box"]
    assert u["centreHeightM"] == flagged["centreHeightM"]
    assert u["origin"] == "flagged"


def test_typed_value_survives_a_better_supported_match():
    typed = {"value": 6.0, "basis": "user", "quality": dict(Q)}
    o = old("ant-old-1", "A1", (100.0, 200.0, 30.0), "accepted", support=1000, downtiltDeg=typed)
    new = unit((100.1, 200.0, 30.0), support=5000)
    (u,) = merge_runs(prev(o), [new], "run-new")
    assert u["downtiltDeg"] == typed
    assert u["box"] == o["box"]
    assert u["support"] == 1000


def test_typed_draft_is_kept_unmatched():
    typed = {"value": 6.0, "basis": "user"}
    o = old("ant-old-1", "A1", (0.0, 0.0, 30.0), "draft", downtiltDeg=typed)
    out = merge_runs(prev(o), [], "run-new")
    assert [u["id"] for u in out] == ["ant-old-1"]
    assert "notFoundInLatest" not in out[0]


def test_rejected_flagged_is_kept_unmatched():
    o = old("ant-old-1", "A1", (0.0, 0.0, 30.0), "rejected", origin="flagged", notFoundInLatest=True)
    out = merge_runs(prev(o), [], "run-new")
    assert len(out) == 1
    assert out[0]["status"] == "rejected"
    assert "notFoundInLatest" not in out[0]


def test_flagged_unmatched_is_not_flagged_missing():
    o = old("ant-old-1", "A1", (0.0, 0.0, 30.0), "accepted", origin="flagged")
    (u,) = merge_runs(prev(o), [], "run-new")
    assert "notFoundInLatest" not in u


def test_typed_accepted_unmatched_is_flagged_missing_and_untyped_draft_dropped():
    typed = {"value": 6.0, "basis": "user"}
    a = old("ant-old-1", "A1", (0.0, 0.0, 30.0), "accepted", downtiltDeg=typed)
    d = old("ant-old-2", "A2", (50.0, 0.0, 30.0), "draft")
    out = merge_runs(prev(a, d), [], "run-new")
    assert [u["id"] for u in out] == ["ant-old-1"]
    assert out[0]["notFoundInLatest"] is True


def test_person_owned_and_measured_passthrough():
    assert person_owned({"origin": "flagged"})
    assert person_owned({"centreHeightM": {"value": 3.0, "basis": "user"}})
    assert not person_owned({"downtiltDeg": val(2.0)})
    measured = {"downtiltDeg": val(2.0)}
    o = old(
        "ant-old-1",
        "A1",
        (0.0, 0.0, 30.0),
        "accepted",
        downtiltDeg={"value": 6.0, "basis": "user"},
        measured=measured,
        notFoundInLatest=True,
    )
    (u,) = merge_runs(prev(o), [unit((0.0, 0.0, 30.0))], "run-new")
    assert u["measured"] == measured
    assert "notFoundInLatest" not in u


def test_next_name_after_highest():
    assert next_name([{"name": "A2"}, {"name": "A9"}, {"name": "X"}]) == "A10"
    assert next_name([]) == "A1"


def deletion(centre, kind="panel"):
    return {
        "unitId": "ant-gone",
        "name": "A9",
        "kind": kind,
        "box": unit(centre)["box"],
        "deletedAt": "2026-10-24T09:00:00.000Z",
    }


def test_contract_deletions_schema():
    c = json.loads(DELETIONS_CONTRACT.read_text("utf-8"))
    assert c["schema"] == DELETIONS_SCHEMA
    assert c["matchRadiusM"] == MATCH_RADIUS_M


def test_merge_drops_a_new_find_at_a_deleted_spot():
    merged = merge_runs(None, [unit((0, 0, 10))], "run-new", [deletion((0.1, 0, 10))])
    assert merged == []


def test_merge_deleted_spot_matches_any_kind():
    merged = merge_runs(None, [unit((0, 0, 10), kind="panel")], "run-new", [deletion((0, 0, 10), "dish")])
    assert merged == []


def test_merge_find_beyond_the_radius_is_new():
    merged = merge_runs(None, [unit((0, 0, 10))], "run-new", [deletion((0.31, 0, 10))])
    assert [u["name"] for u in merged] == ["A1"] and merged[0]["status"] == "draft"


def test_merge_old_unit_wins_over_a_deletion():
    accepted = old("ant-old-1", "A1", (0, 0, 10), "accepted")
    merged = merge_runs(prev(accepted), [unit((0, 0, 10))], "run-new", [deletion((0, 0, 10))])
    assert [u["id"] for u in merged] == ["ant-old-1"]


def test_merge_without_deletions_is_unchanged():
    accepted = old("ant-old-1", "A1", (0, 0, 10), "accepted")
    draft = old("ant-old-2", "A2", (5, 0, 10), "draft")
    found = [unit((0, 0, 10)), unit((5, 0, 10)), unit((9, 9, 10))]
    assert merge_runs(prev(accepted, draft), found, "run-new") == merge_runs(
        prev(accepted, draft), found, "run-new", ()
    )
