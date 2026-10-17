"""The shared RF golden vectors (packages/rf/fixtures/golden/*.json) through the Python engine.

The same files run in vitest (packages/rf/src/golden.test.ts, propagation.golden.test.ts), so the
TypeScript live preview and the ``rf.coverage`` job cannot drift (spec D16). Every vector is run
one at a time and then all at once as numpy arrays, because the job evaluates whole grids.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from aio_pipelines.rf import budget, grid, pattern, propagation

GOLDEN = Path(__file__).resolve().parents[3] / "packages" / "rf" / "fixtures" / "golden"
# Built in two parts, as the generators do: a whole literal would read as a file schema id to the
# schema registry scan (packages/schema/src/versions.test.ts).
FORMAT = "aio.rf-" + "golden/1"


def load(name: str) -> dict:
    return json.loads((GOLDEN / name).read_text("utf-8"))


PB = load("pattern-budget.json")
PROP = load("propagation.json")


def make_pattern(name: str, etilt: float | None) -> pattern.Pattern:
    p = PB["patterns"][name]
    if p["kind"] == "parametric":
        return pattern.Parametric(
            h_beamwidth_deg=p["hBeamwidthDeg"],
            v_beamwidth_deg=p["vBeamwidthDeg"],
            etilt_deg=float(etilt or 0.0),
            am_db=p["amDb"],
            slav_db=p["slavDb"],
        )
    return pattern.two_cut(p["horizontalDb"], p["verticalDb"], p["capDb"])


def wrap180(d: float) -> float:
    d = d % 360.0
    return d - 360.0 if d > 180 else d


def test_files_are_self_describing():
    for doc in (PB, PROP):
        assert doc["format"] == FORMAT
        assert doc["tolerance"]["db"] == 0.01
    assert len(PB["vectors"]) >= 25
    assert len(PROP["vectors"]) >= 400


@pytest.mark.parametrize("v", PB["vectors"], ids=[v["id"] for v in PB["vectors"]])
def test_pattern_and_budget_vector(v):
    i, e = v["input"], v["expected"]
    tol_db, tol_deg = PB["tolerance"]["db"], PB["tolerance"]["deg"]
    d = i["directionGrid"]
    true_az = grid.true_azimuth_deg(i["azimuthGridDeg"], i["convergenceDeg"])
    az, down = grid.antenna_angles(
        np.array([d["east"]]),
        np.array([d["north"]]),
        np.array([d["up"]]),
        i["azimuthGridDeg"],
        i["convergenceDeg"],
        i["mechanicalDowntiltDeg"],
    )
    assert true_az == pytest.approx(e["trueAzimuthDeg"], abs=tol_deg)
    # (-180, 180]: compare on the circle so 180 and -180 agree
    assert abs(wrap180(float(az[0]) - e["antennaAzimuthDeg"])) <= tol_deg
    assert float(down[0]) == pytest.approx(e["antennaDownElevationDeg"], abs=tol_deg)

    p = make_pattern(i["pattern"], i["eTiltDeg"])
    att = pattern.pattern_loss_db(p, az, down)
    assert float(att[0]) == pytest.approx(e["attenuationDb"], abs=tol_db)

    c = i["carrier"]
    sub = budget.subcarriers(c["tech"], c["bandwidthMHz"], c["scsKHz"])
    assert budget.per_re_offset_db(sub) == pytest.approx(e["perReOffsetDb"], abs=tol_db)
    m = i["margins"]
    margin = budget.margins(m["marginPreset"], m["bodyLossDb"], m["edgeProbability"], m["shadowSigmaDb"])
    assert margin["totalDb"] == pytest.approx(e["marginDb"], abs=tol_db)
    rsrp = budget.rsrp_dbm(
        i["portPowerDbm"],
        sub,
        i["feederLossDb"],
        i["antennaGainDbi"],
        att,
        i["pathLossDb"],
        margin["totalDb"],
    )
    assert float(rsrp[0]) == pytest.approx(e["rsrpDbm"], abs=tol_db)
    classes = budget.rsrp_classes(rsrp, PB["thresholds"])
    assert budget.CLASS_NAMES[int(classes[0])] == e["rsrpClass"]


def test_pattern_vectors_all_at_once():
    """Vectorised: every vector of one pattern evaluated in a single array call."""
    by_pattern: dict[tuple[str, float | None, float, float, float], list[dict]] = {}
    for v in PB["vectors"]:
        i = v["input"]
        key = (
            i["pattern"],
            i["eTiltDeg"],
            i["azimuthGridDeg"],
            i["convergenceDeg"],
            i["mechanicalDowntiltDeg"],
        )
        by_pattern.setdefault(key, []).append(v)
    n = 0
    for (name, etilt, az_grid, conv, mech), vs in by_pattern.items():
        east = np.array([v["input"]["directionGrid"]["east"] for v in vs])
        north = np.array([v["input"]["directionGrid"]["north"] for v in vs])
        up = np.array([v["input"]["directionGrid"]["up"] for v in vs])
        az, down = grid.antenna_angles(east, north, up, az_grid, conv, mech)
        att = pattern.pattern_loss_db(make_pattern(name, etilt), az, down)
        want = np.array([v["expected"]["attenuationDb"] for v in vs])
        assert np.all(np.abs(att - want) <= PB["tolerance"]["db"])
        n += len(vs)
    assert n == len(PB["vectors"])


def _prop_ids():
    return [v["id"] for v in PROP["vectors"]]


@pytest.mark.parametrize("v", PROP["vectors"], ids=_prop_ids())
def test_propagation_vector(v):
    i, e = v["input"], v["expected"]
    tol = PROP["tolerance"]
    setup = propagation.Setup(
        model=i["model"],
        environment=i["environment"],
        frequency_mhz=i["frequencyMHz"],
        h_bs_m=i["hBsM"],
        h_ut_m=i["hUtM"],
        hata_area=i["hataArea"],
    )
    r = propagation.refusal(setup)
    if e["refused"]:
        assert r is not None
        assert r["code"] == e["code"]
        assert r["rangeMHz"] == e["rangeMHz"]
        with pytest.raises(propagation.PathLossRefused):
            propagation.path_loss_db(setup, np.array([i["d2DM"]]))
        return
    assert r is None
    pl = propagation.path_loss_db(setup, np.array([i["d2DM"]]))
    assert float(pl[0]) == pytest.approx(e["pathLossDb"], abs=tol["db"])
    if i["model"] == "tr38901":
        d = propagation.tr38901(setup, np.array([i["d2DM"]]))
        assert float(d["los"][0]) == pytest.approx(e["losDb"], abs=tol["db"])
        assert float(d["nlos"][0]) == pytest.approx(e["nlosDb"], abs=tol["db"])
        assert float(d["pLos"][0]) == pytest.approx(e["pLos"], abs=tol["probability"])
        assert d["breakpointM"] == pytest.approx(e["breakpointM"], abs=tol["m"])
        assert d["hUtUsedM"] == pytest.approx(e["hUtUsedM"], abs=tol["m"])


def test_propagation_vectors_all_at_once():
    """One array call per setup over every distance it has, as the grid builder makes it."""
    groups: dict[tuple, list[dict]] = {}
    for v in PROP["vectors"]:
        if v["expected"]["refused"]:
            continue
        i = v["input"]
        key = (i["model"], i["environment"], i["hataArea"], i["frequencyMHz"], i["hBsM"], i["hUtM"])
        groups.setdefault(key, []).append(v)
    n = 0
    for (model, env, area, f, hb, hm), vs in groups.items():
        s = propagation.Setup(model, env, f, hb, hm, area)
        pl = propagation.path_loss_db(s, np.array([v["input"]["d2DM"] for v in vs]))
        want = np.array([v["expected"]["pathLossDb"] for v in vs])
        assert np.all(np.abs(pl - want) <= PROP["tolerance"]["db"]), (model, env, f)
        n += len(vs)
    assert n == sum(1 for v in PROP["vectors"] if not v["expected"]["refused"])


def test_ue_below_the_scenario_range_is_clamped_with_a_warning():
    s = propagation.Setup("tr38901", "uma", 3500.0, 25.0, 0.5, None)
    low = propagation.path_loss_db(s, np.array([300.0]))
    at = propagation.path_loss_db(
        propagation.Setup("tr38901", "uma", 3500.0, 25.0, 1.5, None), np.array([300.0])
    )
    assert float(low[0]) == pytest.approx(float(at[0]))
    assert any("UE height below the model range, 1.5 m used" in w for w in propagation.warnings(s, 3000.0))
    rma = propagation.Setup("tr38901", "rma", 800.0, 30.0, 0.5, None)
    assert any("1 m used" in w for w in propagation.warnings(rma, 3000.0))


def test_hata_out_of_its_band_is_refused_with_the_range():
    s = propagation.Setup("okumura-hata", "uma", 3500.0, 30.0, 1.5, None)
    r = propagation.refusal(s)
    assert r is not None and r["rangeMHz"] == [150.0, 1500.0]
    assert "150 to 1500 MHz" in r["message"]
