"""Per-date copies of the antenna inventory (Wave 3 M2)."""

from __future__ import annotations

from aio_pipelines.telecom.history import HISTORY_DIR, capture_of, history_copies, snapshot


def _doc(capture: str | None, status: str = "draft") -> dict:
    run = {"id": "run-a", **({"captureId": capture} if capture else {})}
    return {
        "schema": "aio.antennas/1",
        "run": run,
        "units": [{"id": "ant-a-1", "status": status, "crop": "x.jpg"}],
    }


def test_capture_of_takes_only_plain_file_names():
    assert capture_of(_doc("capture-2026-02-01")) == "capture-2026-02-01"
    assert capture_of(_doc(None)) is None
    assert capture_of(_doc("../up")) is None
    assert capture_of(_doc("a/b")) is None
    assert capture_of(None) is None


def test_snapshot_drops_crops_only():
    s = snapshot(_doc("c1"))
    assert s["units"] == [{"id": "ant-a-1", "status": "draft"}] and s["run"]["captureId"] == "c1"


def test_copies_keep_the_replaced_date_first():
    old, new = _doc("c1", "accepted"), _doc("c2")
    out = history_copies(old, new)
    assert [p for p, _ in out] == [f"{HISTORY_DIR}/c1.json", f"{HISTORY_DIR}/c2.json"]
    assert out[0][1]["units"][0]["status"] == "accepted"


def test_same_date_rerun_writes_one_copy():
    assert [p for p, _ in history_copies(_doc("c1"), _doc("c1"))] == [f"{HISTORY_DIR}/c1.json"]
    assert history_copies(None, _doc(None)) == []
