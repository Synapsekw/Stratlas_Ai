"""The `telecom.flag` job end to end: a person's outline on the synthetic monopole, measured into
the inventory a `telecom.antennas` run made."""

from __future__ import annotations

import json
import shutil
import socket
import threading
from pathlib import Path

import numpy as np
import pytest

from aio_pipelines.pipelines import all_pipelines
from aio_pipelines.runtime import Job, JobError
from antenna_synth import make_tower_project, tower_cloud
from conftest import Recorder, run_job
from test_telecom_crown import CAPTURE, line_up
from test_telecom_flag import _frame, _ndc, _view_proj

E0, N0 = 400000.0, 5600000.0
ORIGIN = (E0, N0, 0.0)
ANTENNAS = Path("telecom") / "antennas.json"


def flag():
    return all_pipelines()["telecom.flag"]


def read_file(root: Path) -> dict:
    return json.loads((root / ANTENNAS).read_text("utf-8"))


def write_file(root: Path, doc: dict) -> None:
    (root / ANTENNAS).write_text(json.dumps(doc), encoding="utf-8")


def truth_unit(truth: dict, name: str) -> dict:
    return next(u for u in truth["units"] if u["name"] == name)


def to_enz(local) -> list[float]:
    x, y, z = (float(v) for v in local)
    return [E0 + x, N0 - z, y]


def selection(u: dict, shift_local=(0.0, 0.0), grow=0.05, top_share=1.0) -> dict:
    """A person's outline around a truth unit, drawn from 4 m in front of it: bounds are the box
    grown by `grow`, the polygon the projected corners of the box (its upper `top_share` only).
    `shift_local` (x, z) moves everything to where a lined-up date is drawn."""
    c, axes, ext = _frame(u)
    c = c + np.array([shift_local[0], 0.0, shift_local[1]])
    signs = np.array([[a, b, d] for a in (-1, 1) for b in (-1, 1) for d in (-1, 1)], dtype=float)
    corners = c + (signs * (ext / 2 + grow)) @ axes
    lo = -ext[1] / 2 + (1.0 - top_share) * ext[1]
    part = []
    for s in signs:
        h = ext[1] / 2 + grow if s[1] > 0 else lo
        part.append(c + np.array([s[0] * (ext[0] / 2 + grow), h, s[2] * (ext[2] / 2 + grow)]) @ axes)
    vp = _view_proj(c + axes[2] * 4.0, c)
    nd = _ndc(np.array(part), vp)
    (x0, y0), (x1, y1) = nd.min(axis=0) - 0.01, nd.max(axis=0) + 0.01
    return {
        "polygon": [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
        "viewProj": vp,
        "bounds": {"min": corners.min(axis=0).tolist(), "max": corners.max(axis=0).tolist()},
        "anchor": c.tolist(),
    }


def params(unit: str, sel: dict, redraw: bool = False) -> dict:
    p = {"unit": unit, "cloud": {"layer": "tower-cloud"}, "selection": sel}
    if redraw:
        p["redraw"] = True
    return p


@pytest.fixture(scope="module")
def inventory(tmp_path_factory):
    """A project with an inventory from one `telecom.antennas` run (copied per test)."""
    xyz, truth = tower_cloud(seed=1)
    root = make_tower_project(tmp_path_factory.mktemp("inv") / "p", xyz, epsg=32633)
    result, _ = run_job(all_pipelines()["telecom.antennas"], root, {"run": "run-a"}, job_id="ja")
    assert result["status"] == "done"
    return root, truth


@pytest.fixture
def project(tmp_path, inventory):
    template, truth = inventory
    root = tmp_path / "p"
    shutil.copytree(template, root, ignore=shutil.ignore_patterns("jobs"))
    return root, truth


def test_registered_and_validates(inventory):
    _, truth = inventory
    p = flag()
    assert p.name == "telecom.flag" and p.keys == {"unit", "redraw", "cloud", "selection"}
    assert [s.name for s in p.plan({})] == ["select", "measure", "photos", "commit"]
    assert p.inputs({}, Path(".")) == ["manifest.json", "clouds", "telecom"]
    good = params("ant-flag-1", selection(truth_unit(truth, "radio-180")))
    assert p.validate(good)["unit"] == "ant-flag-1"
    assert p.validate({**good, "redraw": True})["redraw"] is True
    sel = good["selection"]
    for bad in (
        {**good, "unit": "A1"},
        {**good, "unit": "ant-"},
        {**good, "extra": 1},
        {**good, "redraw": False},
        {k: v for k, v in good.items() if k != "cloud"},
        {**good, "cloud": {"layer": ""}},
        {**good, "cloud": {"layer": "c", "x": 1}},
        {**good, "selection": {**sel, "polygon": [[0, 0], [1, 1]]}},
        {**good, "selection": {**sel, "polygon": [[0, 0]] * 257}},
        {**good, "selection": {**sel, "polygon": [[0, 0], [1, 0], [101, 1]]}},
        {**good, "selection": {**sel, "polygon": [[0, 0], [1, 0], [1]]}},
        {**good, "selection": {**sel, "viewProj": [1.0] * 15}},
        {**good, "selection": {**sel, "viewProj": [True] * 16}},
        {**good, "selection": {**sel, "bounds": {"min": [0, 0, 0]}}},
        {**good, "selection": {**sel, "bounds": {"min": [0, 0], "max": [1, 1, 1]}}},
        {**good, "selection": {**sel, "anchor": [0, 0]}},
        {**good, "selection": {**sel, "more": 1}},
    ):
        with pytest.raises(JobError):
            p.validate(bad)


def test_needs_a_detection_run(tmp_path):
    xyz, truth = tower_cloud(seed=1)
    root = make_tower_project(tmp_path / "p", xyz)
    with pytest.raises(JobError, match="Run antenna detection first"):
        Job(
            "jf",
            flag(),
            root,
            params("ant-f-1", selection(truth_unit(truth, "radio-180"))),
            Recorder(),
            threading.Event(),
        ).run()


def test_flag_adds_an_accepted_flagged_unit(project):
    root, truth = project
    before = read_file(root)
    radio = truth_unit(truth, "radio-180")
    result, rec = run_job(flag(), root, params("ant-flag-1", selection(radio)), job_id="jf")
    assert result["status"] == "done"
    after = read_file(root)
    assert len(after["units"]) == len(before["units"]) + 1
    u = next(x for x in after["units"] if x["id"] == "ant-flag-1")
    top = max(int(x["name"][1:]) for x in before["units"])
    assert u["origin"] == "flagged" and u["status"] == "accepted" and u["kind"] == "other"
    assert u["name"] == f"A{top + 1}" and u["user"] == {} and u["runId"] == "run-a"
    assert u["support"] > 0 and "widthM" in u
    assert u["box"]["centre"] == pytest.approx(to_enz(radio["centre"]), abs=0.15)
    assert after["run"] == before["run"]
    msgs = [p.get("message") for p in rec.of("progress")]
    for m in (
        "Reading the outlined points",
        "Measuring the flagged unit",
        "Picking the best photos",
        "Saving the inventory",
    ):
        assert m in msgs


def test_too_few_points_is_not_measured(project):
    root, truth = project
    radio = truth_unit(truth, "radio-180")
    # 0.1 m of empty sky 3 m outside the crown, beside the radio
    anchor = np.asarray(radio["centre"]) + np.array([-3.0, 0.0, 0.0])
    sel = selection(radio)
    sel["bounds"] = {"min": (anchor - 0.05).tolist(), "max": (anchor + 0.05).tolist()}
    sel["anchor"] = anchor.tolist()
    run_job(flag(), root, params("ant-flag-2", sel), job_id="jf")
    u = next(x for x in read_file(root)["units"] if x["id"] == "ant-flag-2")
    assert u["origin"] == "flagged" and u["status"] == "accepted"
    assert "widthM" not in u and "heightM" not in u and "depthM" not in u
    assert u["box"]["extents"] == [0.2, 0.2, 0.2]
    assert u["box"]["centre"] == pytest.approx(to_enz(anchor), abs=1e-3)


def test_redraw_keeps_review_and_user_values(project):
    root, truth = project
    panel = truth_unit(truth, "panel-0")
    doc = read_file(root)
    e, n = E0 + panel["centre"][0], N0 - panel["centre"][2]
    old = min(doc["units"], key=lambda u: (u["box"]["centre"][0] - e) ** 2 + (u["box"]["centre"][1] - n) ** 2)
    old.update(status="accepted", user={"model": "X"})
    old["measured"] = {"downtiltDeg": old["downtiltDeg"]}
    old["downtiltDeg"] = {"value": 12.5, "basis": "user", "quality": {"basis": "user"}}
    write_file(root, doc)
    run_job(flag(), root, params(old["id"], selection(panel, top_share=0.6), redraw=True), job_id="jf")
    after = read_file(root)
    assert len(after["units"]) == len(doc["units"])
    u = next(x for x in after["units"] if x["id"] == old["id"])
    assert u["name"] == old["name"] and u["status"] == "accepted" and u["user"] == {"model": "X"}
    assert u["kind"] == old["kind"] and u["origin"] == "flagged"
    assert u["downtiltDeg"] == old["downtiltDeg"]
    assert u["box"] != old["box"]
    assert u["heightM"]["value"] < old["heightM"]["value"] - 0.2
    assert set(u["measured"]) == {"downtiltDeg"}
    m = u["measured"]["downtiltDeg"]
    assert m["basis"] != "user" and m["value"] == pytest.approx(panel["downtiltDeg"], abs=2.0)
    assert "notFoundInLatest" not in u


def test_redraw_of_a_unit_gone_is_an_error(project):
    root, truth = project
    with pytest.raises(JobError, match="no longer in the inventory"):
        Job(
            "jf",
            flag(),
            root,
            params("ant-gone-1", selection(truth_unit(truth, "panel-0")), redraw=True),
            Recorder(),
            threading.Event(),
        ).run()


def test_flag_on_a_lined_up_date_is_stored_in_the_inventory_frame(project):
    root, truth = project
    line_up(root, 3.0, -2.0)  # drawn 3 m east, 2 m south: local x + 3, z + 2
    doc = read_file(root)
    doc["run"]["captureId"] = CAPTURE
    write_file(root, doc)
    radio = truth_unit(truth, "radio-180")
    sel = selection(radio, shift_local=(3.0, 2.0))
    run_job(flag(), root, params("ant-flag-3", sel), job_id="jf")
    u = next(x for x in read_file(root)["units"] if x["id"] == "ant-flag-3")
    drawn = to_enz(sel["anchor"])
    assert u["box"]["centre"][:2] == pytest.approx([drawn[0] - 3.0, drawn[1] + 2.0], abs=0.15)
    assert u["box"]["centre"] == pytest.approx(to_enz(radio["centre"]), abs=0.15)


@pytest.mark.parametrize("run_shift", [None, (-1.0, 1.5)])
def test_flag_on_another_date_than_the_inventory_takes_off_the_run_dates_shift(project, run_shift):
    # the flagged layer is on CAPTURE (drawn 3 m east, 2 m south); the inventory's run is on the
    # other date, without a line-up or lined up by its own shift: only the run date's shift goes
    root, truth = project
    line_up(root, 3.0, -2.0)
    other = "capture-2026-01-01"
    if run_shift is not None:
        p = root / "manifest.json"
        m = json.loads(p.read_text("utf-8"))
        for c in m["captures"]:
            if c["id"] == other:
                c["lineUp"] = {
                    "eastM": run_shift[0],
                    "northM": run_shift[1],
                    "with": CAPTURE,
                    "at": "2026-10-17T00:00:00Z",
                }
        p.write_text(json.dumps(m, indent=1), encoding="utf-8")
    doc = read_file(root)
    doc["run"]["captureId"] = other
    write_file(root, doc)
    radio = truth_unit(truth, "radio-180")
    sel = selection(radio, shift_local=(3.0, 2.0))
    run_job(flag(), root, params("ant-flag-7", sel), job_id="jf")
    u = next(x for x in read_file(root)["units"] if x["id"] == "ant-flag-7")
    drawn = to_enz(sel["anchor"])
    se, sn = run_shift or (0.0, 0.0)
    assert u["box"]["centre"][:2] == pytest.approx([drawn[0] - se, drawn[1] - sn], abs=0.15)


def test_commit_keeps_edits_made_during_the_job(project):
    root, truth = project
    doc = read_file(root)
    other = next(u for u in doc["units"] if u["status"] == "draft")
    rec = Recorder()

    def emit(method, p):
        rec(method, p)
        if method == "progress" and p.get("step") == "commit" and p.get("state") == "start":
            d = read_file(root)
            for u in d["units"]:
                if u["id"] == other["id"]:
                    u["status"] = "accepted"
            write_file(root, d)

    job = Job(
        "jf",
        flag(),
        root,
        params("ant-flag-4", selection(truth_unit(truth, "radio-180"))),
        emit,
        threading.Event(),
    )
    assert job.run()["status"] == "done"
    after = read_file(root)
    assert next(u for u in after["units"] if u["id"] == other["id"])["status"] == "accepted"
    assert any(u["id"] == "ant-flag-4" for u in after["units"])


def test_commit_refuses_when_a_new_detection_run_landed_during_the_job(project):
    # a detection on another date that commits between select and commit changes the frame: the
    # unit would land in the wrong frame under the wrong run id
    root, truth = project
    rec = Recorder()

    def emit(method, p):
        rec(method, p)
        if method == "progress" and p.get("step") == "commit" and p.get("state") == "start":
            d = read_file(root)
            d["run"]["id"] = "run-other"
            write_file(root, d)

    job = Job(
        "jf",
        flag(),
        root,
        params("ant-flag-8", selection(truth_unit(truth, "radio-180"))),
        emit,
        threading.Event(),
    )
    with pytest.raises(JobError, match="inventory changed while measuring"):
        job.run()
    assert not any(u["id"] == "ant-flag-8" for u in read_file(root)["units"])


def test_rerun_keeps_flagged_and_typed(project):
    root, truth = project
    run_job(flag(), root, params("ant-flag-5", selection(truth_unit(truth, "radio-180"))), job_id="jf")
    doc = read_file(root)
    u = next(x for x in doc["units"] if x["id"] == "ant-flag-5")
    u["azimuthGridDeg"] = {"value": 271.0, "basis": "user", "quality": {"basis": "user"}}
    write_file(root, doc)
    run_job(all_pipelines()["telecom.antennas"], root, {"run": "run-b"}, job_id="jb")
    again = [x for x in read_file(root)["units"] if x["id"] == "ant-flag-5"]
    assert len(again) == 1
    assert again[0]["origin"] == "flagged" and again[0]["azimuthGridDeg"]["value"] == 271.0
    assert again[0]["box"] == u["box"]


def test_never_uses_the_network(project, monkeypatch):
    root, truth = project

    def refuse(*a, **k):
        raise AssertionError("telecom.flag opened a socket")

    monkeypatch.setattr(socket, "socket", refuse)
    monkeypatch.setattr(socket, "create_connection", refuse)
    result, _ = run_job(
        flag(), root, params("ant-flag-6", selection(truth_unit(truth, "radio-180"))), job_id="jf"
    )
    assert result["status"] == "done"
