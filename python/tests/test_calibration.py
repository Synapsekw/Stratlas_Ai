"""M11 G1: geo.calibration. JobXML and 12d imports, point-pair solving, residuals and the job."""

from __future__ import annotations

import json
import math

import numpy as np
import pytest

from aio_pipelines.geodesy.calibration import (
    apply_horizontal,
    compute_calibration,
    import_12d,
    import_jobxml,
    jobxml_calibration,
    plane_dz,
    solve_pairs,
)
from aio_pipelines.pipelines import all_pipelines
from aio_pipelines.runtime import JobError
from conftest import run_job
from geodesy_synth import GEOID_ID, synthetic_geoid, synthetic_jobxml


@pytest.fixture(scope="module")
def geoid_dir(tmp_path_factory):
    d = tmp_path_factory.mktemp("geoid")
    synthetic_geoid(d)
    return d


@pytest.mark.parametrize(
    ("cw", "on_grid"), [(False, False), (True, False), (False, True), (True, True)], ids=str
)
def test_a_synthetic_jobxml_reproduces_its_own_residuals(cw, on_grid):
    data, truth = synthetic_jobxml(rotation_cw=cw, plane_on_grid=on_grid)
    cal = import_jobxml(data, {"epsg": 32639})
    assert cal["conventions"] == {"rotation": "cw" if cw else "ccw", "plane": "grid" if on_grid else "local"}
    assert len(cal["pairs"]) == 6
    for p, rh in zip(cal["pairs"], truth["residualH"], strict=True):
        assert p["controllerResidualH"] == pytest.approx(rh, abs=1e-4)
        assert abs(p["residualH"] - p["controllerResidualH"]) < 0.001
        assert abs(p["residualV"] - p["controllerResidualV"]) < 0.001
    h = cal["horizontal"]
    assert h["rotationRad"] == pytest.approx(truth["horizontal"]["rotationRad"], abs=1e-12)
    assert h["scale"] == truth["horizontal"]["scale"]
    assert cal["rmsH"] > 0 and cal["rmsV"] > 0
    assert "wkt" in cal["projection"]  # the file's own transverse Mercator


def test_a_jobxml_on_a_geoid_needs_the_pack_and_uses_it(geoid_dir):
    data, truth = synthetic_jobxml(geoid=GEOID_ID, geoid_dir=geoid_dir)
    with pytest.raises(JobError, match=f"needs the {GEOID_ID} geoid pack"):
        import_jobxml(data, {"epsg": 32639})
    cal = import_jobxml(data, {"epsg": 32639}, geoid_dirs=[geoid_dir])
    assert cal["geoid"] == GEOID_ID
    for p, rv in zip(cal["pairs"], truth["residualV"], strict=True):
        assert abs(p["residualV"] - rv) < 0.001


def test_jobxml_hostile_and_foreign_files_are_refused():
    bomb = b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;">]><JOBFile>&b;</JOBFile>'
    with pytest.raises(JobError, match="declares entities"):
        jobxml_calibration(bomb)
    with pytest.raises(JobError, match="not a Trimble JobXML"):
        jobxml_calibration(b"<LandXML/>")
    with pytest.raises(JobError, match="could not be read"):
        jobxml_calibration(b"<JOBFile><broken></JOBFile>")
    with pytest.raises(JobError, match="no site calibration"):
        jobxml_calibration(b"<JOBFile><Environment/></JOBFile>")


def _seeded():
    rng = np.random.default_rng(11)
    ge = 252000 + rng.uniform(0, 600, 8)
    gn = 2798000 + rng.uniform(0, 600, 8)
    h = {
        "originE": 252300.0,
        "originN": 2798300.0,
        "shiftE": -241234.567,
        "shiftN": -2791876.543,
        "rotationRad": math.radians(-1.234567),
        "scale": 0.99987654,
    }
    v = {"originE": 11000.0, "originN": 6400.0, "shiftM": 3.21, "slopeN": 4.5e-6, "slopeE": -2.5e-6}
    z = 10 + rng.uniform(0, 20, 8)
    le, ln = apply_horizontal(h, ge, gn)
    lz = z + plane_dz(v, le, ln)
    pairs = [
        {
            "name": f"P{i}",
            "local": [ln[i], le[i], lz[i]],
            "grid": [gn[i], ge[i], z[i]],
            "useH": True,
            "useV": True,
        }
        for i in range(8)
    ]
    return pairs, h, v, (ge, gn, z)


def test_point_pairs_recover_seeded_parameters():
    pairs, h, v, (ge, gn, z) = _seeded()
    cal = solve_pairs(pairs, {"epsg": 32639})
    s = cal["horizontal"]
    assert abs(s["scale"] - h["scale"]) < 0.1e-6  # 0.1 ppm
    assert abs(s["rotationRad"] - h["rotationRad"]) < 0.1e-6
    # the origin is a choice (the centroid): the transformation itself must agree within 0.1 mm
    rng = np.random.default_rng(3)
    te = 252000 + rng.uniform(-200, 800, 200)
    tn = 2798000 + rng.uniform(-200, 800, 200)
    a = np.column_stack(apply_horizontal(s, te, tn))
    b = np.column_stack(apply_horizontal(h, te, tn))
    assert np.max(np.hypot(*(a - b).T)) < 1e-4
    dz_a = plane_dz(cal["vertical"], *apply_horizontal(s, te, tn))
    dz_b = plane_dz(v, *apply_horizontal(h, te, tn))
    assert np.max(np.abs(dz_a - dz_b)) < 1e-4
    assert abs(cal["vertical"]["slopeN"] - v["slopeN"]) < 0.1e-6
    assert cal["rmsH"] < 1e-6 and cal["rmsV"] < 1e-6


def test_point_pairs_from_wgs84_go_through_proj_and_honour_use_flags():
    pairs, *_ = _seeded()
    from pyproj import Transformer

    t = Transformer.from_crs(32639, 4979, always_xy=True)
    for p in pairs:
        lon, lat, h = t.transform(p["grid"][1], p["grid"][0], p["grid"][2])
        p["wgs84"] = [lat, lon, h]
        del p["grid"]
    pairs[0]["local"][0] += 0.05  # a bad point, left out horizontally
    pairs[0]["useH"] = False
    cal = solve_pairs(pairs, {"epsg": 32639})
    assert cal["rmsH"] < 1e-4
    assert cal["pairs"][0]["residualH"] == pytest.approx(0.05, abs=1e-3)


def test_one_pair_is_a_shift_and_two_vertical_pairs_a_constant():
    pairs, *_ = _seeded()
    one = solve_pairs(pairs[:1], {"epsg": 32639})
    assert one["horizontal"]["scale"] == 1.0 and one["horizontal"]["rotationRad"] == 0.0
    assert one["pairs"][0]["residualH"] == pytest.approx(0.0, abs=1e-9)
    two = solve_pairs(pairs[:2], {"epsg": 32639})
    assert two["vertical"]["slopeN"] == 0.0


def test_12d_parameters_file():
    text = """# 12d transformation (typed from the 12d report)
origin_e = 252300
origin_n = 2798300
shift_e = -241234.567
shift_n = -2791876.543
rotation_deg = -1.234567
scale = 0.99987654
v_shift = 3.21
"""
    cal = import_12d(text)
    assert cal["horizontal"]["rotationRad"] == pytest.approx(math.radians(-1.234567))
    assert cal["vertical"]["shiftM"] == 3.21
    with pytest.raises(JobError, match="not a 12d transformation parameter"):
        import_12d("lambda = 1")
    with pytest.raises(JobError, match="needs: "):
        import_12d("origin_e = 1")


def test_dc_and_cal_are_refused_with_the_reason(tmp_path):
    f = tmp_path / "job.dc"
    f.write_text("00NMSC V10-70\n", encoding="utf-8")
    with pytest.raises(JobError, match="no public specification"):
        compute_calibration({"src": str(f), "crs": {"epsg": 32639}})


def test_the_job_writes_a_draft_and_never_replaces_an_applied_calibration(tmp_path):
    data, _ = synthetic_jobxml()
    src = tmp_path / "in" / "site job.jxl"
    src.parent.mkdir()
    src.write_bytes(data)
    project = tmp_path / "project"
    project.mkdir()
    pipe = all_pipelines()["geo.calibration"]
    params = {"src": str(src), "crs": {"epsg": 32639}}
    result, _ = run_job(pipe, project, pipe.validate(params))
    current = json.loads((project / "survey" / "calibration.json").read_text(encoding="utf-8"))
    assert current["schema"] == "aio.site-calibration/1"
    assert "appliedAt" not in current
    assert current["source"]["format"] == "jobxml"
    kept = project / current["source"]["file"]
    assert kept.read_bytes() == data
    assert len(current["source"]["sha256"]) == 64
    # an applied calibration stays; the new draft is kept beside its source only
    current["appliedAt"] = "2026-10-09T08:00:00.000Z"
    (project / "survey" / "calibration.json").write_text(json.dumps(current), encoding="utf-8")
    run_job(pipe, project, pipe.validate({**params, "format": "jobxml"}), job_id="j2")
    still = json.loads((project / "survey" / "calibration.json").read_text(encoding="utf-8"))
    assert still["id"] == current["id"]
    drafts = sorted((project / "survey" / "calibration").glob("*/calibration.json"))
    assert len(drafts) == 2


def test_pairs_job_validates_against_the_contract_shape(tmp_path):
    pairs, *_ = _seeded()
    pipe = all_pipelines()["geo.calibration"]
    run_job(pipe, tmp_path, pipe.validate({"pairs": pairs, "crs": {"epsg": 32639}}))
    cal = json.loads((tmp_path / "survey" / "calibration.json").read_text(encoding="utf-8"))
    assert cal["source"] == {"format": "pairs"}
    assert all(p["residualH"] >= 0 for p in cal["pairs"])
    assert cal["projection"] == {"epsg": 32639}
