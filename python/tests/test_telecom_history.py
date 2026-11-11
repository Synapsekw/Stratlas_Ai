"""What each survey date measured of its antennas (Wave 3 M2)."""

from __future__ import annotations

import json

from aio_pipelines.telecom.history import (
    HISTORY_DIR,
    HISTORY_SCHEMA,
    capture_of,
    history_copies,
    measured_record,
    review_of,
)
from aio_pipelines.telecom.merge import merge_with_sources
from test_telecom_merge import old, unit


def _doc(capture, units, run="run-b"):
    return {
        "schema": "aio.antennas/1",
        "run": {"id": run, "captureId": capture, "at": "2026-06-01T00:00:00Z"},
        "units": units,
    }


def _record(capture, entries):
    return {"schema": HISTORY_SCHEMA, "captureId": capture, "runId": "run-a", "at": "x", "units": entries}


def test_capture_of_takes_only_plain_file_names():
    assert capture_of(_doc("capture-2026-02-01", [])) == "capture-2026-02-01"
    assert capture_of({"run": {}}) is None
    assert capture_of(_doc("../up", [])) is None
    assert capture_of(_doc("a/b", [])) is None
    assert capture_of(None) is None


def test_the_record_holds_this_runs_fit_not_the_kept_geometry():
    # an accepted unit at 4 degrees; date B fits it at 12 degrees with less support, so the merge
    # keeps the old geometry in the inventory, while the record must hold what B measured
    previous = _doc(
        "a", [old("ant-a-1", "A1", (0, 0, 30), "accepted", azimuth=4.0, support=2000)], run="run-a"
    )
    fits = [unit((0.05, 0, 30), azimuth=12.0, support=1000)]
    merged = merge_with_sources(previous, fits, "run-b")
    kept = next(u for u, _ in merged if u["id"] == "ant-a-1")
    assert kept["azimuthGridDeg"]["value"] == 4.0  # the inventory kept the old fit
    rec = measured_record(merged, fits, "b", "run-b", "2026-06-01T00:00:00Z")
    [e] = rec["units"]
    assert e["id"] == "ant-a-1" and e["azimuthGridDeg"] == 12.0 and e["downtiltDeg"] == 2.0
    assert e["centre"] == [0.05, 0.0, 30.0]
    assert e["status"] == "accepted" and e["reviewed"] is False  # carried over, not reviewed on b
    assert "centreHeightM" not in e


def test_units_this_run_did_not_measure_have_no_entry():
    previous = _doc(
        "a",
        [
            old("ant-a-1", "A1", (0, 0, 30), "accepted"),
            old("ant-a-2", "A2", (5, 0, 30), "accepted"),  # not found again
            old("ant-a-3", "A3", (9, 0, 30), "rejected"),  # matched while rejected
        ],
        run="run-a",
    )
    fits = [unit((0, 0, 30)), unit((9, 0, 30))]
    merged = merge_with_sources(previous, fits, "run-b")
    assert any(u.get("notFoundInLatest") for u, _ in merged)
    rec = measured_record(merged, fits, "b", "run-b", "t")
    assert [e["id"] for e in rec["units"]] == ["ant-a-1"]


def test_review_of_takes_the_statuses_a_person_changed():
    rec = _record(
        "a",
        [
            {"id": "u1", "status": "accepted", "reviewed": False},
            {"id": "u2", "status": "draft", "reviewed": False},
        ],
    )
    live = _doc("a", [{"id": "u1", "status": "accepted"}, {"id": "u2", "status": "rejected"}])
    out = review_of(rec, live)["units"]
    assert out[0] == {"id": "u1", "status": "accepted", "reviewed": False}
    assert out[1] == {"id": "u2", "status": "rejected", "reviewed": True}


def test_copies_review_the_replaced_date_and_keep_reviews_on_a_rerun(tmp_path):
    hist = tmp_path / HISTORY_DIR
    hist.mkdir(parents=True)
    (hist / "a.json").write_text(
        json.dumps(_record("a", [{"id": "ant-a-1", "status": "draft", "reviewed": False}])), "utf-8"
    )
    previous = _doc("a", [old("ant-a-1", "A1", (0, 0, 30), "accepted")], run="run-a")
    fits = [unit((0, 0, 30), azimuth=7.0)]
    merged = merge_with_sources(previous, fits, "run-b")
    out = history_copies(tmp_path, previous, merged, fits, _doc("b", [u for u, _ in merged]))
    assert [p for p, _ in out] == [f"{HISTORY_DIR}/a.json", f"{HISTORY_DIR}/b.json"]
    assert out[0][1]["units"][0] == {"id": "ant-a-1", "status": "accepted", "reviewed": True}
    assert out[1][1]["units"][0]["reviewed"] is False

    for rel, doc in out:
        (tmp_path / rel).write_text(json.dumps(doc), "utf-8")
    # date a again later (the unit a draft by then): its reviewed entry keeps its status, the
    # values are the new fit
    later = _doc("b", [{**u, "status": "draft"} for u, _ in merged])
    fits_a = [unit((0, 0, 30), azimuth=5.0)]
    merged_a = merge_with_sources(later, fits_a, "run-c")
    again = history_copies(
        tmp_path, later, merged_a, fits_a, _doc("a", [u for u, _ in merged_a], run="run-c")
    )
    rec_a = dict(again)[f"{HISTORY_DIR}/a.json"]
    assert rec_a["units"][0]["status"] == "accepted" and rec_a["units"][0]["reviewed"] is True
    assert rec_a["units"][0]["azimuthGridDeg"] == 5.0


def test_no_record_without_a_date(tmp_path):
    assert history_copies(tmp_path, None, [], [], {"run": {"id": "r"}, "units": []}) == []
