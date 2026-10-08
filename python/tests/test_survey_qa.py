"""survey.qa (M11 G8): checkpoints, compare to previous survey, QA levels and the hold.

On G13's earthworks site (``survey_synth.earthworks_site``): a planar ground surveyed on three
dates, checkpoints with one planted 15 cm off (CHK6), and the whole third survey planted 3 cm high.
Every expected number is an analytic truth of the generator.
"""

from __future__ import annotations

import json
import math

import numpy as np
import pytest

from aio_pipelines.pipelines import all_pipelines
from aio_pipelines.runtime import JobError
from aio_pipelines.survey.qa import LEVELS, read_checkpoint_csv, verdict
from conftest import run_job
from survey_g8 import manifest, put_surface, site_project
from survey_synth import SITE_E0, SITE_N0, earthworks_site


@pytest.fixture(scope="module")
def site():
    return earthworks_site(quick=True)


def pipeline():
    return all_pipelines()["survey.qa"]


def qa(project, capture):
    return json.loads((project / "survey" / "qa" / f"{capture}.json").read_text("utf-8"))


@pytest.fixture
def project(tmp_path, site):
    site_project(tmp_path / "p", site)
    csv = tmp_path / "checkpoints.csv"
    csv.write_text(site.extra_files["checkpoints.csv"], "utf-8", newline="\n")
    return tmp_path / "p", csv


def expected(site, capture):
    dz = np.array([p["dz"][capture] for p in site.truth["checkpoints"]["points"]])
    return float(np.sqrt(np.mean(dz**2))), float(dz.mean()), float(np.abs(dz).max())


def test_the_planted_checkpoint_shows_and_moderate_passes(project, site):
    root, csv = project
    params = {"capture": "d2", "surface": "s-d2", "level": "moderate", "checkpoints": {"csv": str(csv)}}
    result, _ = run_job(pipeline(), root, params)
    doc = qa(root, "d2")
    cp = doc["checkpoints"]
    rmse, mean, max_abs = expected(site, "d2")
    assert rmse == pytest.approx(site.truth["checkpoints"]["rmseM"], abs=1e-9)
    assert cp["count"] == 8
    assert cp["rmseM"] == pytest.approx(rmse, abs=2e-4)
    assert cp["meanM"] == pytest.approx(mean, abs=2e-4)
    assert cp["maxAbsM"] == pytest.approx(max_abs, abs=2e-4)
    by = {p["name"]: p["dz"] for p in cp["points"]}
    assert by["CHK6"] == pytest.approx(-0.15, abs=2e-4)
    assert all(abs(v) < 2e-4 for k, v in by.items() if k != "CHK6")
    # d2 against d1: only the borrow pit, stockpile B and the excavator changed beyond 0.20 m
    assert doc["previous"]["capture"] == "d1" and doc["previous"]["thresholdM"] == 0.20
    assert 0.0 < doc["previous"]["changedShare"] < 0.05
    assert doc["status"] == "pass" and "hold" not in doc
    assert doc["schema"] == "aio.survey-qa/1" and doc["level"] == "moderate"
    assert result["outputs"]["commit"]["out"] == "survey/qa/d2.json"


def test_strict_holds_the_planted_shift_survey(project, site):
    root, csv = project
    params = {"capture": "d3", "surface": "s-d3", "level": "strict", "checkpoints": {"csv": str(csv)}}
    run_job(pipeline(), root, params)
    doc = qa(root, "d3")
    rmse, mean, _ = expected(site, "d3")
    assert rmse > LEVELS["strict"]["rmseM"] > 0
    assert doc["checkpoints"]["rmseM"] == pytest.approx(rmse, abs=2e-4)
    assert doc["checkpoints"]["meanM"] == pytest.approx(mean, abs=2e-4)
    assert doc["status"] == "hold"
    assert "RMSE 5.1 cm is above the Strict limit of 5.0 cm" in doc["hold"]["reason"]
    assert doc["hold"]["at"] == doc["checkedAt"]
    # compare to previous at Strict (0.10 m): stockpile A gone where the cone was more than 13 cm
    # high (the 3 cm shift offsets it), and the 3 m excavator gone; the 3 cm shift itself is below
    rb = 12 * (1 - 0.13 / 5)
    want = (math.pi * rb * rb + 18.0) / (2 * site.half) ** 2
    prev = doc["previous"]
    assert prev["capture"] == "d2" and prev["thresholdM"] == 0.10
    assert prev["changedShare"] == pytest.approx(want, rel=0.03)
    # the same survey at Moderate passes
    run_job(pipeline(), root, {**params, "level": "moderate"}, job_id="j2")
    assert qa(root, "d3")["status"] == "pass"


def test_the_site_rmse_override_applies_to_the_site_level(project):
    root, csv = project
    s = json.loads((root / "survey" / "settings.json").read_text("utf-8"))
    s["qa"] = {"level": "strict", "rmseM": 0.06}
    (root / "survey" / "settings.json").write_text(json.dumps(s), "utf-8")
    params = {"capture": "d3", "surface": "s-d3", "level": "strict", "checkpoints": {"csv": str(csv)}}
    run_job(pipeline(), root, params)
    assert qa(root, "d3")["status"] == "pass"
    # at another level than the site's, that level's own limit applies
    run_job(pipeline(), root, {**params, "level": "lenient"}, job_id="j2")
    assert qa(root, "d3")["status"] == "pass"


def test_level_off_measures_without_a_verdict(project):
    root, csv = project
    params = {"capture": "d3", "surface": "s-d3", "level": "off", "checkpoints": {"csv": str(csv)}}
    run_job(pipeline(), root, params)
    doc = qa(root, "d3")
    assert doc["status"] == "unchecked" and "hold" not in doc
    assert doc["checkpoints"]["count"] == 8
    assert doc["previous"]["thresholdM"] == LEVELS["moderate"]["thresholdM"]


def flat(project, dz=0.0, captures=("a", "b")):
    caps = [{"id": c, "label": f"Survey {c}", "date": f"2026-0{k + 1}-01"} for k, c in enumerate(captures)]
    manifest(project, caps, [SITE_E0, SITE_N0, 100.0])
    y = np.arange(200)[:, None] * 0.5
    for k, c in enumerate(captures):
        put_surface(
            project,
            f"s-{c}",
            np.broadcast_to(100.0 + 0.01 * y + k * dz, (200, 200)).copy(),
            SITE_E0,
            SITE_N0,
            0.5,
            c,
        )


@pytest.mark.parametrize(
    ("dz", "level", "status", "share"),
    [
        (0.15, "strict", "hold", 1.0),
        (0.15, "moderate", "pass", 0.0),
        (0.45, "lenient", "hold", 1.0),
        (0.05, "strict", "pass", 0.0),
    ],
)
def test_compare_to_previous_holds_a_survey_that_moved(tmp_path, dz, level, status, share):
    flat(tmp_path, dz)
    run_job(pipeline(), tmp_path, {"capture": "b", "surface": "s-b", "level": level})
    doc = qa(tmp_path, "b")
    assert doc["previous"] == {
        "capture": "a",
        "thresholdM": LEVELS[level]["thresholdM"],
        "changedShare": share,
    }
    assert doc["status"] == status
    assert "checkpoints" not in doc
    if status == "hold":
        assert "100% of the area changed by more than" in doc["hold"]["reason"]


def test_the_first_survey_without_checkpoints_is_unchecked(tmp_path):
    flat(tmp_path, 0.3)
    run_job(pipeline(), tmp_path, {"capture": "a", "surface": "s-a", "level": "strict"})
    doc = qa(tmp_path, "a")
    assert doc["status"] == "unchecked" and "previous" not in doc


def test_an_explicit_previous_survey_is_used(tmp_path):
    flat(tmp_path, 0.3, captures=("a", "b", "c"))
    prev = {"capture": "a", "surface": "s-a"}
    run_job(pipeline(), tmp_path, {"capture": "c", "surface": "s-c", "level": "lenient", "previous": prev})
    doc = qa(tmp_path, "c")
    assert doc["previous"]["capture"] == "a" and doc["previous"]["changedShare"] == 1.0
    assert doc["status"] == "hold"


def test_checkpoints_from_csv_variants(tmp_path):
    p = tmp_path / "a.csv"
    p.write_bytes("﻿Point;Northing;Easting;Elevation\nA;2;1;3\nB;5;4;6\n".encode())
    assert read_checkpoint_csv(p) == [
        {"name": "A", "e": 1, "n": 2, "z": 3},
        {"name": "B", "e": 4, "n": 5, "z": 6},
    ]
    p.write_text("1 2 3\n4 5 6\n", "utf-8")
    assert [q["name"] for q in read_checkpoint_csv(p)] == ["P1", "P2"]
    p.write_text("CP1,10.5,20.5,3.25\n", "utf-8")
    assert read_checkpoint_csv(p) == [{"name": "CP1", "e": 10.5, "n": 20.5, "z": 3.25}]
    p.write_text("name,lat,lon\nA,1,2\n", "utf-8")
    with pytest.raises(JobError, match="no column for E, N, Z"):
        read_checkpoint_csv(p)
    p.write_text("name,e,n,z\nA,1,x,3\n", "utf-8")
    with pytest.raises(JobError, match=r"Line 2 of a.csv has no number for N"):
        read_checkpoint_csv(p)
    p.write_text("", "utf-8")
    with pytest.raises(JobError, match="is empty"):
        read_checkpoint_csv(p)


def test_checkpoints_off_the_surface_are_refused(project):
    root, _ = project
    bad = root.parent / "latlon.csv"
    bad.write_text("name,easting,northing,elevation\nA,51.5,21.1,120\nB,51.6,21.2,121\n", "utf-8")
    params = {"capture": "d2", "surface": "s-d2", "level": "strict", "checkpoints": {"csv": str(bad)}}
    with pytest.raises(JobError, match="None of the 2 checkpoints is on the surface"):
        run_job(pipeline(), root, params)
    assert not (root / "survey" / "qa").exists()


def gcp_file(root, site, crs, check=True):
    pts = site.truth["checkpoints"]["points"]
    xyz = [[p["e"], p["n"], p["z"]] for p in pts]
    if crs != {"epsg": 32639}:
        from pyproj import Transformer

        t = Transformer.from_crs(32639, crs["epsg"], always_xy=True)
        xyz = [[*t.transform(x, y), z] for x, y, z in xyz]
    doc = {
        "schema": "aio.gcp/1",
        "crs": crs,
        "points": [
            {
                "id": p["name"],
                "role": "check" if check else "control",
                "xyz": v,
                "accuracy": {"horizontalM": 0.02, "verticalM": 0.03},
                "marks": [],
            }
            for p, v in zip(pts, xyz, strict=True)
        ]
        + [
            {
                "id": "OFF",
                "role": "check",
                "xyz": [0, 0, 0],
                "accuracy": {"horizontalM": 0.02, "verticalM": 0.03},
                "disabled": True,
                "marks": [],
            }
        ],
    }
    f = root / "photogrammetry" / "run-1" / "gcp.json"
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(doc), "utf-8")
    return "photogrammetry/run-1/gcp.json"


@pytest.mark.parametrize("crs", [{"epsg": 32639}, {"epsg": 4326}])
def test_checkpoints_from_the_m10_gcp_file(project, site, crs):
    root, _ = project
    rel = gcp_file(root, site, crs)
    run_job(
        pipeline(), root, {"capture": "d2", "surface": "s-d2", "level": "strict", "checkpoints": {"gcp": rel}}
    )
    cp = qa(root, "d2")["checkpoints"]
    assert cp["count"] == 8 and len(cp["points"]) == 8
    assert cp["rmseM"] == pytest.approx(site.truth["checkpoints"]["rmseM"], abs=2e-4)


def test_verdict_reasons():
    cps = {"rmseM": 0.12}
    prev = {"capture": "x", "thresholdM": 0.2, "changedShare": 0.7}
    status, reasons = verdict("moderate", 0.10, cps, prev)
    assert status == "hold" and len(reasons) == 2
    assert (
        reasons[1]
        == "70% of the area changed by more than 0.20 m since the previous survey; Moderate allows 60%."
    )
    assert verdict("off", None, cps, prev) == ("unchecked", [])
    assert verdict("lenient", 0.2, None, None) == ("unchecked", [])


@pytest.mark.parametrize(
    ("params", "message"),
    [
        (
            {"capture": "c1", "surface": "s", "level": "moderate", "checkpoints": {"csv": "rel.csv"}},
            "absolute",
        ),
        (
            {"capture": "c1", "surface": "s", "level": "moderate", "checkpoints": {"csv": "/a", "gcp": "b"}},
            "csv",
        ),
        (
            {"capture": "c1", "surface": "s", "level": "moderate", "previous": {"capture": "c0"}},
            "previous must be",
        ),
        ({"capture": "../x", "surface": "s", "level": "moderate"}, "capture must be"),
    ],
)
def test_bad_parameters_are_refused(params, message):
    with pytest.raises(JobError, match=message):
        pipeline().validate(params)


def test_a_surface_that_is_not_prepared_is_refused(tmp_path):
    flat(tmp_path)
    with pytest.raises(JobError, match="is not prepared"):
        run_job(pipeline(), tmp_path, {"capture": "b", "surface": "nope", "level": "strict"})
