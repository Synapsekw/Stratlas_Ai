"""haul.analyse (M11 G11, HRD-1): the quality targets on G13's synthetic haul road and the pipeline.

The road (``survey_synth.HaulRoad`` in the quarry demo): 25 m wide, 8 % grade, crowned at 2 %, a
left curve of 90 m radius superelevated at 5 % with clothoid transitions, 1.5 m berms; planted
violations: a 12 % stretch from chainage 170 to 195 m and a 0.8 m left berm from 100 to 120 m.

Targets (plan, G11): width within 0.25 m, grade and cross fall within 0.2 %, berm height within
0.1 m, every planted violation found and no false failures on the clean stretch. The truth steps
from one value to the other exactly at the planted boundaries (chainage 100 and 120 m for the
berm), so the section taken exactly there reads a mix of both within a cell; those two stations
are left out of the per-station accuracy and pass or fail checks, and nothing else is.
"""

from __future__ import annotations

import json
import math

import numpy as np
import pytest

from aio_pipelines.haul.centreline import AlignmentCentreline, PolylineCentreline
from aio_pipelines.haul.road import (
    analyse_road,
    chainages,
    measure_station,
    min_berm_height,
    read_side,
)
from aio_pipelines.pipelines import all_pipelines
from aio_pipelines.runtime import JobError
from aio_pipelines.survey.grid import TILE, ArraySurface, encode_tile
from conftest import run_job
from survey_synth import quarry_site, write_alignment_json

CRS = {"epsg": 32639}
#: Stations exactly on the planted berm boundaries (see the module docstring).
ON_A_STEP = {100.0, 120.0}


@pytest.fixture(scope="module")
def road():
    site = quarry_site(quick=True)
    return site, site.road


def road_grid(site, road, res: float) -> tuple[float, float, np.ndarray]:
    """The quarry surface around the road at ``res`` (row 0 south), with its lower-left corner."""
    _, e, n, _ = road.align.dense(1.0)
    x0 = math.floor((e.min() - 45) / res) * res
    y0 = math.floor((n.min() - 45) / res) * res
    nx = math.ceil((e.max() + 45 - x0) / res)
    ny = math.ceil((n.max() + 45 - y0) / res)
    E, N = np.meshgrid(x0 + (np.arange(nx) + 0.5) * res, y0 + (np.arange(ny) + 0.5) * res)
    return x0, y0, site.surface("m1")(E, N)


@pytest.fixture(scope="module", params=[0.25, 0.5], ids=["25cm", "50cm"])
def measured(request, road):
    site, rd = road
    x0, y0, z = road_grid(site, rd, request.param)
    surf = ArraySurface(x0, y0, request.param, z)
    cl = AlignmentCentreline(rd.align.to_json(CRS), "Haul road centreline")
    truth = rd.truth()
    return analyse_road(surf, cl, 10.0, truth["limits"]), truth


def truth_at(truth, chainage):
    return min(truth["stations"], key=lambda t: abs(t["chainage"] - chainage))


def test_width_grade_cross_fall_and_berms_are_within_the_targets(measured):
    stations, truth = measured
    checked = 0
    for st in stations:
        c = st["chainageM"]
        if c in ON_A_STEP:
            continue
        t = truth_at(truth, c)
        if abs(t["chainage"] - c) > 1e-6:
            # an end section, taken inside the road: the road's own values hold there
            t = {**t, "chainage": c}
        assert st["widthM"] == pytest.approx(t["widthM"], abs=0.25), c
        assert st["gradePct"] == pytest.approx(t["gradePct"], abs=0.2), c
        # cross fall as the fall away from the centreline (the truth is the rise)
        assert st["crossFallLeftPct"] == pytest.approx(-t["crossFallLeftPct"], abs=0.2), c
        assert st["crossFallRightPct"] == pytest.approx(-t["crossFallRightPct"], abs=0.2), c
        assert st["bermLeft"]["heightM"] == pytest.approx(t["bermLeftM"], abs=0.1), c
        assert st["bermRight"]["heightM"] == pytest.approx(t["bermRightM"], abs=0.1), c
        assert st["bermLeft"]["kind"] == st["bermRight"]["kind"] == "berm"
        if st["turn"] is not None:
            assert st["turn"] == "left"
            assert st["superelevationPct"] == pytest.approx(t["superelevationPct"], abs=0.2), c
        else:
            assert t["superelevationPct"] == 0.0
            assert st["shape"] == "crown"
        checked += 1
    assert checked == len(stations) - len(ON_A_STEP) == 23


def test_every_planted_violation_is_found_and_the_clean_stretch_passes(measured):
    stations, truth = measured
    steep = next(v for v in truth["violations"] if v["kind"] == "grade")
    low = next(v for v in truth["violations"] if v["kind"] == "berm")
    assert low["side"] == "left"
    for st in stations:
        c = st["chainageM"]
        if c in ON_A_STEP:
            continue
        in_steep = steep["fromChainage"] <= c < steep["toChainage"]
        in_low = low["fromChainage"] <= c < low["toChainage"]
        expect = {"grade": "fail" if in_steep else "pass", "bermLeft": "fail" if in_low else "pass"}
        assert st["checks"]["grade"] == expect["grade"], c
        assert st["checks"]["bermLeft"] == expect["bermLeft"], c
        assert st["checks"]["width"] == "pass", c
        assert st["checks"]["bermRight"] == "pass", c
        # cross fall on the tangents, superelevation (not adverse) on the curve
        assert st["checks"]["crossFall"] == ("n/a" if st["turn"] else "pass"), c
        assert st["checks"]["superelevation"] == ("pass" if st["turn"] else "n/a"), c
        assert st["status"] == ("fail" if in_steep or in_low else "pass"), c
    found = {st["chainageM"] for st in stations if st["status"] == "fail"} - ON_A_STEP
    assert found == {110.0, 170.0, 180.0, 190.0}


def test_a_drawn_centreline_finds_the_same_violations(road):
    """A polyline with a vertex every 10 m (as a person draws it): curvature from the line itself."""
    site, rd = road
    x0, y0, z = road_grid(site, rd, 0.5)
    surf = ArraySurface(x0, y0, 0.5, z)
    _, e, n, _ = rd.align.dense(10.0)
    cl = PolylineCentreline(np.c_[e, n].tolist(), "drawn", "Drawn")
    assert cl.length == pytest.approx(rd.align.length, abs=0.1)
    stations = analyse_road(surf, cl, 10.0, rd.truth()["limits"])
    failed = {round(st["chainageM"]) for st in stations if st["status"] == "fail"}
    assert {110, 170, 180, 190} <= failed
    assert failed - {100, 120} <= {110, 170, 180, 190}
    by = {round(st["chainageM"]): st for st in stations}
    assert by[120 - 10]["turn"] == "left" and by[30]["turn"] is None
    assert by[30]["widthM"] == pytest.approx(25.0, abs=0.25)


def test_end_stations_are_taken_inside_the_road():
    assert chainages(240.0, 10.0) == [10.0 * k for k in range(25)]
    assert chainages(245.0, 10.0)[-2:] == [240.0, 245.0]


def analytic_road(left: str, right: str, cell: float = 0.25):
    """A straight road along E (bearing 90): 20 m wide, crowned at 3 %, flat along. Left: a
    trapezoid berm 1.2 m high with a 1 m flat top, or a cut bank; right: a drop or a berm."""
    xs = np.arange(-30, 30, cell) + cell / 2
    ys = np.arange(-40, 40, cell) + cell / 2
    X, Y = np.meshgrid(xs, ys)
    o = Y  # left of an eastbound road is north
    a = np.abs(o)
    z = 100.0 - 0.03 * np.minimum(a, 10.0)
    edge = 100.0 - 0.3
    if left == "berm":
        h = np.clip(np.minimum((o - 10.0) / 1.5, (14.0 - o) / 1.5), 0, None) * 1.2
        z = np.where(o > 10.0, edge + np.minimum(h, 1.2), z)
    elif left == "bank":
        z = np.where(o > 10.0, edge + (o - 10.0) * 0.8, z)
    if right == "drop":
        z = np.where(o < -10.0, edge - (-o - 10.0) * 0.5, z)
    elif right == "berm":
        h = np.clip(np.minimum((-o - 10.0) / 1.5, (14.0 - -o) / 1.5), 0, None) * 1.2
        z = np.where(o < -10.0, edge + np.minimum(h, 1.2), z)
    return ArraySurface(-30.0, -40.0, cell, z), PolylineCentreline([[-20, 0], [20, 0]], "drawn", "Road")


def test_a_flat_topped_berm_a_bank_and_a_drop():
    surf, cl = analytic_road("berm", "drop")
    st = measure_station(surf, cl, 20.0)
    assert st["widthM"] == pytest.approx(20.0, abs=0.1)
    assert st["crossFallLeftPct"] == pytest.approx(3.0, abs=0.05)
    assert st["crossFallRightPct"] == pytest.approx(3.0, abs=0.05)
    assert st["shape"] == "crown"
    # a flat top (1 m, four cells) is read as it is, not where the faces would meet
    assert st["bermLeft"]["kind"] == "berm"
    assert st["bermLeft"]["heightM"] == pytest.approx(1.2, abs=0.01)
    assert st["bermLeft"]["widthM"] == pytest.approx(1.5 + 1.0 + 1.5, abs=0.3)
    assert st["bermRight"] == {"kind": "drop", "heightM": 0.0, "widthM": None, "crestOffsetM": None}
    limits = {"minBermHeightM": 1.0, "minWidthM": 18.0, "crossFallMinPct": 2.0, "crossFallMaxPct": 4.0}
    [res] = analyse_road(surf, PolylineCentreline([[0, 0], [0.5, 0]], "drawn", "x"), 10.0, limits)[:1]
    assert res["checks"]["bermRight"] == "fail" and res["checks"]["bermLeft"] == "pass"
    surf, cl = analytic_road("bank", "berm")
    st = measure_station(surf, cl, 20.0)
    assert st["bermLeft"]["kind"] == "bank" and st["bermLeft"]["heightM"] > 5
    assert st["bermRight"]["heightM"] == pytest.approx(1.2, abs=0.01)
    assert st["widthM"] == pytest.approx(20.0, abs=0.1)


def test_a_side_without_data_or_without_an_edge():
    d = np.arange(0, 40.01, 0.25)
    z = 100 - 0.02 * d
    assert read_side(d, z, 0.5).state == "none"
    z2 = z.copy()
    z2[d > 8] = np.nan
    side = read_side(d, z2, 0.5)
    assert side.state == "no-data" and side.edgeM == pytest.approx(8.0)
    z3 = z.copy()
    z3[:3] = np.nan
    assert read_side(d, z3, 0.5).state == "no-data"


def test_minimum_berm_height_from_the_wheel():
    assert min_berm_height(3.0) == 1.5
    assert min_berm_height(2.4, 0.75) == pytest.approx(1.8)
    with pytest.raises(ValueError):
        min_berm_height(0)


# ------------------------------------------------------------------------------------ pipeline


def write_surface(project, sid, x0, y0, cell, z):
    """A prepared surface (level 0 only) of ``z`` (row 0 south) in ``survey/surfaces/<sid>/``."""
    folder = project / "survey" / "surfaces" / sid
    rows, cols = math.ceil(z.shape[0] / TILE), math.ceil(z.shape[1] / TILE)
    tiles = []
    for r in range(rows):
        for c in range(cols):
            t = np.full((TILE, TILE), np.nan)
            part = z[r * TILE : (r + 1) * TILE, c * TILE : (c + 1) * TILE]
            t[: part.shape[0], : part.shape[1]] = part
            (folder / "0").mkdir(parents=True, exist_ok=True)
            (folder / "0" / f"{c}_{r}.bin").write_bytes(encode_tile(t))
            tiles.append(f"{c}_{r}")
    meta = {
        "schema": "aio.height-tiles/1",
        "id": sid,
        "name": "Quarry DSM",
        "source": {"kind": "dsm", "layer": "dsm-m1"},
        "capture": "m1",
        "crs": CRS,
        "cellM": cell,
        "tileSize": TILE,
        "originE": x0,
        "originN": y0,
        "cols": cols,
        "rows": rows,
        "levels": 1,
        "bounds": [
            x0,
            y0,
            float(np.nanmin(z)),
            x0 + z.shape[1] * cell,
            y0 + z.shape[0] * cell,
            float(np.nanmax(z)),
        ],
        "tiles": tiles,
        "fingerprint": "sha256:" + "ab" * 32,
        "preparedAt": "2026-10-09T08:00:00Z",
    }
    (folder / "tiles.json").write_text(json.dumps(meta), "utf-8")


def haul_project(tmp_path, site, rd):
    x0, y0, z = road_grid(site, rd, 0.5)
    write_surface(tmp_path, "dsm-m1", x0, y0, 0.5, z)
    folder = tmp_path / "survey" / "designs" / "haul-road"
    folder.mkdir(parents=True)
    write_alignment_json(folder / "road-cl.alignment.json", rd.align, CRS)
    _, e, n, _ = rd.align.dense(5.0)
    (folder / "road-edge.geojson").write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "crs": CRS,
                "features": [
                    {
                        "type": "Feature",
                        "properties": {},
                        "geometry": {"type": "LineString", "coordinates": [[0, 0, 0], [1, 0, 0]]},
                    },
                    {
                        "type": "Feature",
                        "properties": {},
                        "geometry": {"type": "LineString", "coordinates": np.c_[e, n, n * 0].tolist()},
                    },
                ],
            }
        ),
        "utf-8",
    )
    layer = {"visible": True, "archived": False, "verticalOffsetM": 0, "counts": {}}
    designs = {
        "schema": "aio.designs/1",
        "designs": [
            {
                "id": "haul-road",
                "name": "Haul road (synthetic)",
                "layers": [
                    {
                        **layer,
                        "id": "road-cl",
                        "name": "Centreline",
                        "kind": "alignment",
                        "file": "road-cl.alignment.json",
                    },
                    {
                        **layer,
                        "id": "road-edge",
                        "name": "Linework",
                        "kind": "linework",
                        "file": "road-edge.geojson",
                    },
                    {**layer, "id": "road", "name": "Road", "kind": "surface", "file": "road.tin"},
                ],
            }
        ],
    }
    (tmp_path / "survey" / "designs.json").write_text(json.dumps(designs), "utf-8")


def pipeline():
    return all_pipelines()["haul.analyse"]


def test_the_pipeline_writes_the_run_and_its_geojson(tmp_path, road):
    site, rd = road
    haul_project(tmp_path, site, rd)
    limits = rd.truth()["limits"]
    params = {
        "surface": "dsm-m1",
        "centreline": {"design": "haul-road", "layer": "road-cl"},
        "intervalM": 10,
        "limits": limits,
        "run": "road-check",
    }
    run_job(pipeline(), tmp_path, pipeline().validate(params), job_id="h1")
    out = tmp_path / "survey" / "haul" / "road-check"
    run = json.loads((out / "run.json").read_text("utf-8"))
    assert run["schema"] == "aio.haul-run/1" and run["id"] == "road-check" and run["jobId"] == "h1"
    assert run["params"] == params and run["limits"] == limits
    assert run["surface"]["fingerprint"] == "sha256:" + "ab" * 32 and run["surface"]["cellM"] == 0.5
    assert run["centreline"]["source"] == "alignment" and run["centreline"]["sha256"].startswith("sha256:")
    assert run["centreline"]["lengthM"] == pytest.approx(240.0)
    labels = [st["stationLabel"] for st in run["stations"]]
    # the alignment's own stationing: start 1+000, equation 1+150 = 1+200
    assert labels[:2] == ["1+001.000", "1+010.000"] and "1+200.000" in labels and labels[-1] == "1+289.000"
    assert run["summary"]["stations"] == 25
    bad = {(s["check"], s["fromStation"], s["toStation"]) for s in run["stretches"]}
    assert ("grade", "1+220.000", "1+240.000") in bad
    assert ("bermLeft", "1+110.000", "1+110.000") in bad
    assert {s["check"] for s in run["stretches"]} == {"grade", "bermLeft"}
    gj = json.loads((out / "haul.geojson").read_text("utf-8"))
    assert gj["crs"] == CRS
    kinds = [f["properties"]["kind"] for f in gj["features"]]
    assert kinds.count("centreline") == 25 and kinds.count("section") == 25 and kinds.count("edge") == 2
    red = {f["properties"]["station"] for f in gj["features"] if f["properties"].get("status") == "fail"}
    assert {"1+110.000", "1+220.000", "1+230.000", "1+240.000"} <= red
    first = next(f for f in gj["features"] if f["properties"]["kind"] == "centreline")
    assert len(first["geometry"]["coordinates"][0]) == 3
    # a second run of the same id replaces the folder
    (out / "stale.txt").write_text("x", "utf-8")
    run_job(pipeline(), tmp_path, pipeline().validate({**params, "intervalM": 20}), job_id="h2")
    again = json.loads((out / "run.json").read_text("utf-8"))
    assert again["jobId"] == "h2" and again["summary"]["stations"] == 13
    assert not (out / "stale.txt").exists()
    assert run["fingerprint"] != again["fingerprint"]


def test_a_linework_layer_or_drawn_points_as_the_centreline(tmp_path, road):
    site, rd = road
    haul_project(tmp_path, site, rd)
    limits = {"maxGradePct": 10.0}
    run_job(
        pipeline(),
        tmp_path,
        {
            "surface": "dsm-m1",
            "centreline": {"design": "haul-road", "layer": "road-edge"},
            "intervalM": 10,
            "limits": limits,
        },
        job_id="h3",
    )
    run = json.loads((tmp_path / "survey" / "haul" / "h3" / "run.json").read_text("utf-8"))
    assert run["centreline"]["source"] == "linework" and run["centreline"]["lengthM"] == pytest.approx(
        240, abs=0.1
    )
    grade = {round(st["chainageM"]) for st in run["stations"] if st["checks"]["grade"] == "fail"}
    assert grade == {170, 180, 190}
    assert all(st["checks"]["bermLeft"] == "n/a" for st in run["stations"])
    _, e, n, _ = rd.align.dense(20.0)
    run_job(
        pipeline(),
        tmp_path,
        {"surface": "dsm-m1", "centreline": np.c_[e, n].tolist()[:4], "intervalM": 10, "limits": limits},
        job_id="h4",
    )
    drawn = json.loads((tmp_path / "survey" / "haul" / "h4" / "run.json").read_text("utf-8"))
    assert drawn["centreline"] == {
        "source": "drawn",
        "name": "Drawn centreline",
        "lengthM": pytest.approx(60),
        "points": 4,
    }
    assert drawn["summary"]["fail"] == 0


@pytest.mark.parametrize(
    ("patch", "message"),
    [
        ({"centreline": [[0, 0]]}, "centreline must be 2 or more"),
        ({"centreline": {"design": "d"}}, "centreline must be 2 or more"),
        ({"centreline": [[0, 0], [1, "x"]]}, "centreline must be 2 or more"),
        ({"intervalM": 0}, "intervalM must be"),
        ({"limits": {"minWidthM": -1}}, "limits.minWidthM must be above 0"),
        ({"limits": {"crossFallMinPct": 4, "crossFallMaxPct": 1}}, "must not be above"),
        ({"limits": {"maxSpeed": 4}}, "does not take: maxSpeed"),
        ({"surface": "../x"}, "surface must be an id"),
        ({"run": "a b"}, "run must be an id"),
    ],
)
def test_bad_parameters_are_refused(patch, message):
    base = {"surface": "dsm-1", "centreline": [[0, 0], [100, 0]], "intervalM": 10, "limits": {}}
    with pytest.raises(JobError, match=message):
        pipeline().validate({**base, **patch})


def test_a_missing_surface_or_a_surface_layer_is_refused(tmp_path, road):
    site, rd = road
    haul_project(tmp_path, site, rd)
    base = {"centreline": [[0, 0], [100, 0]], "intervalM": 10, "limits": {}}
    with pytest.raises(JobError, match="is not prepared"):
        run_job(pipeline(), tmp_path, {**base, "surface": "nope"}, job_id="h5")
    with pytest.raises(JobError, match="pick an alignment or a linework"):
        run_job(
            pipeline(),
            tmp_path,
            {**base, "surface": "dsm-m1", "centreline": {"design": "haul-road", "layer": "road"}},
            job_id="h6",
        )
    with pytest.raises(JobError, match="is not in the designs list"):
        run_job(
            pipeline(),
            tmp_path,
            {**base, "surface": "dsm-m1", "centreline": {"design": "haul-road", "layer": "nope"}},
            job_id="h7",
        )
    assert not (tmp_path / "survey" / "haul").exists()
