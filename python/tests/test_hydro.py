"""Hydrology (M11 G10): flood to level, runoff and catchments, direct rainfall, on G13's analytic
surfaces (``survey_synth.bowl``, ``survey_synth.catchment``) and a tilted plane, against their
exact truths. Synthetic only.

WhiteboxTools is not available offline on this machine or in CI, so the accumulation oracle of the
plan (agreement within 1% of cells) is skipped; the analytic truths below are asserted instead.
"""

from __future__ import annotations

import itertools
import json
import math
import shutil
from pathlib import Path

import numpy as np
import pytest

from aio_pipelines.hydro import dem
from aio_pipelines.hydro.common import read_hyetograph
from aio_pipelines.hydro.flood import HydroFlood
from aio_pipelines.hydro.flow import HydroFlow
from aio_pipelines.hydro.rainfall import HydroRainfall, frame_interval, rain_function
from aio_pipelines.runtime import JobError
from aio_pipelines.survey.grid import TILE, encode_tile
from conftest import run_job
from survey_synth import Grid, bowl, catchment

# ------------------------------------------------------------------------------------ fixtures


def write_surface(
    project: Path, sid: str, z_south: np.ndarray, origin_e: float, origin_n: float, cell: float
) -> None:
    """``z_south`` (row 0 south, NaN no data) as a prepared surface ``survey/surfaces/<sid>/``."""
    folder = project / "survey" / "surfaces" / sid
    ny, nx = z_south.shape
    cols, rows = math.ceil(nx / TILE), math.ceil(ny / TILE)
    present = []
    for r in range(rows):
        for c in range(cols):
            t = np.full((TILE, TILE), np.nan)
            part = z_south[r * TILE : (r + 1) * TILE, c * TILE : (c + 1) * TILE]
            t[: part.shape[0], : part.shape[1]] = part
            if not np.isfinite(t).any():
                continue
            (folder / "0").mkdir(parents=True, exist_ok=True)
            (folder / "0" / f"{c}_{r}.bin").write_bytes(encode_tile(t))
            present.append(f"{c}_{r}")
    ok = np.isfinite(z_south)
    meta = {
        "schema": "aio.height-tiles/1",
        "id": sid,
        "name": sid.upper(),
        "source": {"kind": "dsm", "layer": sid},
        "crs": {"epsg": 32639},
        "cellM": cell,
        "tileSize": TILE,
        "originE": origin_e,
        "originN": origin_n,
        "cols": cols,
        "rows": rows,
        "levels": 1,
        "bounds": [
            origin_e,
            origin_n,
            float(z_south[ok].min()),
            origin_e + nx * cell,
            origin_n + ny * cell,
            float(z_south[ok].max()),
        ],
        "tiles": present,
        "fingerprint": f"sha256:{sid}",
        "preparedAt": "2026-10-09T10:00:00Z",
    }
    (folder / "tiles.json").write_text(json.dumps(meta), "utf-8")


def write_grid(project: Path, sid: str, g: Grid) -> None:
    write_surface(project, sid, g.z[::-1].copy(), g.x0, g.y1 - g.height * g.res, g.res)


def run_of(project: Path, out: dict) -> dict:
    return json.loads((project / out["out"] / "run.json").read_text("utf-8"))


# ---------------------------------------------------------------------------------- flood to level


@pytest.mark.parametrize("mode", ["all-below", "connected"])
def test_flooding_the_bowl_matches_its_area_and_volume_within_one_percent(tmp_path, mode):
    s = bowl()
    write_grid(tmp_path, "bowl", s.grid(0.25))
    for k, truth in enumerate(s.truth["flood"]):
        params = {"surface": "bowl", "levelM": truth["levelM"], "mode": mode, "run": f"bowl-{k}"}
        if mode == "connected":
            params["seed"] = [s.centre[0] + 1.0, s.centre[1] - 0.5]
        result, rec = run_job(HydroFlood(), tmp_path, params, job_id=f"f{k}")
        doc = run_of(tmp_path, result["outputs"]["commit"])
        res = doc["results"]
        assert res["areaM2"] == pytest.approx(truth["areaM2"], rel=0.01)
        assert res["volumeM3"] == pytest.approx(truth["volumeM3"], rel=0.01)
        assert res["outlineAreaM2"] == pytest.approx(truth["areaM2"], rel=0.01)
        assert res["maxDepthM"] == pytest.approx(truth["levelM"] - s.truth["lowestM"], abs=0.01)
        assert doc["schema"] == "aio.hydro-run/1" and doc["id"] == f"bowl-{k}"
        assert doc["surface"] == {"id": "bowl", "name": "BOWL", "fingerprint": "sha256:bowl"}
        assert doc["fingerprint"].startswith("sha256:")
        folder = tmp_path / "survey" / "hydro" / f"bowl-{k}"
        for f in ("outline.geojson", "outline.dxf", "depth.json", "depth.png", "depth-view.png"):
            assert (folder / f).is_file(), f
        assert doc["files"]["view"]["file"] == "depth-view.png"


def test_the_outline_dxf_holds_the_waters_edge_at_the_level(tmp_path):
    import ezdxf

    s = bowl()
    write_grid(tmp_path, "bowl", s.grid(0.25))
    truth = s.truth["flood"][1]
    result, _ = run_job(
        HydroFlood(), tmp_path, {"surface": "bowl", "levelM": truth["levelM"], "mode": "all-below"}
    )
    folder = tmp_path / result["outputs"]["commit"]["out"]
    doc = ezdxf.readfile(folder / "outline.dxf")
    assert doc.header["$INSUNITS"] == 6
    plines = list(doc.modelspace().query("LWPOLYLINE"))
    assert len(plines) == 1 and plines[0].closed and plines[0].dxf.layer == "FLOOD-OUTLINE"
    assert plines[0].dxf.elevation == pytest.approx(truth["levelM"])
    pts = np.array([(p[0], p[1]) for p in plines[0].get_points()])
    rad = np.hypot(pts[:, 0] - s.centre[0], pts[:, 1] - s.centre[1])
    want = math.sqrt(truth["areaM2"] / math.pi)
    assert np.all(np.abs(rad - want) < 0.05)
    gj = json.loads((folder / "outline.geojson").read_text("utf-8"))
    assert gj["features"][0]["geometry"]["type"] == "Polygon"
    assert gj["features"][0]["properties"]["levelM"] == truth["levelM"]


def two_basins(tmp_path: Path) -> tuple[float, float, float]:
    """Two paraboloid pits 40 m apart on flat ground at 100 m; the east one with an island."""
    cell = 0.5
    n = 200
    e = (np.arange(n) + 0.5) * cell
    E, N = np.meshgrid(e, e)
    z = np.full((n, n), 100.0)
    for cx in (30.0, 70.0):
        r2 = (E - cx) ** 2 + (N - 50.0) ** 2
        z = np.minimum(z, 100.0 - np.clip(3.0 * (1 - r2 / 100.0), 0, None))
    # an island in the east pit: a cone poking above 99 m
    r_isl = np.hypot(E - 70.0, N - 50.0)
    z = np.where(r_isl < 2.0, np.maximum(z, 99.5 - r_isl * 0.25), z)
    write_surface(tmp_path, "pits", z, 0.0, 0.0, cell)
    return 30.0, 70.0, 50.0


def test_connected_mode_floods_only_the_seeded_pit_and_islands_are_holes(tmp_path):
    w, e, n = two_basins(tmp_path)
    level = 99.0
    all_res, _ = run_job(
        HydroFlood(), tmp_path, {"surface": "pits", "levelM": level, "mode": "all-below"}, job_id="a"
    )
    one_res, _ = run_job(
        HydroFlood(),
        tmp_path,
        {"surface": "pits", "levelM": level, "mode": "connected", "seed": [w, n]},
        job_id="b",
    )
    a = run_of(tmp_path, all_res["outputs"]["commit"])["results"]
    b = run_of(tmp_path, one_res["outputs"]["commit"])["results"]
    disc = math.pi * 100.0 * 2 / 3  # z < 99 where r^2 < R^2 (1 - 1 / 3), R = 10 m
    assert b["areaM2"] == pytest.approx(disc, rel=0.02)
    assert a["areaM2"] > 1.9 * b["areaM2"]
    gj = json.loads((tmp_path / "survey/hydro/a/outline.geojson").read_text("utf-8"))
    rings = [len(f["geometry"]["coordinates"]) for f in gj["features"]]
    assert sorted(rings) == [1, 2]  # the east pit has its island as a hole


def test_flood_refuses_a_dry_seed_and_reports_an_empty_flood(tmp_path):
    w, _, n = two_basins(tmp_path)
    with pytest.raises(JobError, match="not below the water level"):
        run_job(
            HydroFlood(),
            tmp_path,
            {"surface": "pits", "levelM": 99.0, "mode": "connected", "seed": [5.0, 5.0]},
        )
    res, _ = run_job(
        HydroFlood(), tmp_path, {"surface": "pits", "levelM": 90.0, "mode": "all-below"}, job_id="j2"
    )
    doc = run_of(tmp_path, res["outputs"]["commit"])
    assert doc["results"]["areaM2"] == 0 and doc["results"]["volumeM3"] == 0
    assert doc["files"] == {} and doc["notes"]


def test_a_region_limits_the_flood(tmp_path):
    w, e, n = two_basins(tmp_path)
    ring = [[50, 30], [95, 30], [95, 70], [50, 70]]
    res, _ = run_job(
        HydroFlood(), tmp_path, {"surface": "pits", "levelM": 99.0, "mode": "all-below", "region": ring}
    )
    whole, _ = run_job(
        HydroFlood(), tmp_path, {"surface": "pits", "levelM": 99.0, "mode": "all-below"}, job_id="w"
    )
    a = run_of(tmp_path, res["outputs"]["commit"])["results"]["areaM2"]
    b = run_of(tmp_path, whole["outputs"]["commit"])["results"]["areaM2"]
    # the region holds the east pit only: the whole flood less the west pit's disc
    assert a == pytest.approx(b - math.pi * 100.0 * 2 / 3, rel=0.03)


@pytest.mark.parametrize(
    "params, message",
    [
        ({"surface": "s", "levelM": "high", "mode": "all-below"}, "levelM must be a number"),
        ({"surface": "s", "levelM": 1, "mode": "spill"}, "mode must be one of"),
        ({"surface": "s", "levelM": 1, "mode": "connected", "seed": [1]}, "seed must be a point"),
        ({"surface": "s", "levelM": 1, "mode": "all-below", "run": "../x"}, "run must be an id"),
        (
            {"surface": "s", "levelM": 1, "mode": "all-below", "region": [[0, 0], [1, 1]]},
            "region must be a ring",
        ),
        ({"surface": "s", "mode": "all-below"}, "needs: levelM"),
    ],
)
def test_flood_parameters_are_checked(params, message):
    with pytest.raises(JobError, match=message):
        HydroFlood().validate(params)


def test_a_missing_surface_is_a_clear_error(tmp_path):
    with pytest.raises(JobError, match="is not prepared"):
        run_job(HydroFlood(), tmp_path, {"surface": "nope", "levelM": 1, "mode": "all-below"})


# ---------------------------------------------------------------------------------- flow routing


def v_grid(res: float):
    """G13's V catchment over a whole number of cells either side of the channel, so the channel
    runs along a column of cell centres (its half-size grows by half a cell)."""
    half = 50.0 + res / 2
    s = catchment(half=half)
    return s, s.grid(res, half=half)


def test_priority_flood_fills_a_pit_and_every_cell_drains():
    z = np.array(
        [[5, 5, 5, 5, 5], [5, 2, 2, 2, 5], [5, 2, 1, 2, 5], [5, 2, 2, 2, 4.5], [5, 5, 5, 5, 5]], float
    )
    fl = dem.priority_flood(z)
    inner = fl.filled[1:4, 1:4]
    assert np.all(inner > 4.5) and np.all(inner < 4.5 + 1e-9)
    assert fl.order.size == z.size and sorted(fl.order.tolist()) == list(range(z.size))
    rt = dem.routing(fl.filled, "d8")
    # every cell reaches the grid's edge
    for c in range(z.size):
        assert dem.trace(rt, c)[-1] in {k for k in range(z.size) if rt.d8r[k] < 0}
    # breaching carves the spill path instead: the pit keeps its height, the outlet is lowered
    b = dem.breach(z, fl)
    assert b[2, 2] == 1.0 and b[3, 4] < 1.0
    assert np.all(b <= z)


@pytest.mark.parametrize("res", [1.0, 0.5])
def test_the_v_catchment_pour_point_is_exact_and_its_area_within_one_perimeter_cell(tmp_path, res):
    s, g = v_grid(res)
    write_grid(tmp_path, "v", g)
    truth = s.truth["catchmentAreaM2"]
    tol = 4 * g.width * res * res  # the catchment's perimeter times one cell
    for method in ("d8", "dinf"):
        result, _ = run_job(
            HydroFlow(), tmp_path, {"surface": "v", "mode": "catchment", "method": method}, job_id=method
        )
        doc = run_of(tmp_path, result["outputs"]["commit"])
        (out,) = doc["results"]["outlets"]
        assert out["pourPoint"] == pytest.approx([s.centre[0], s.centre[1] - g.width * res / 2], abs=1e-9)
        if method == "dinf":
            assert abs(out["contributingAreaM2"] - truth) <= tol
        elif res == 1.0:
            # D8 cannot send water off the edge at the plane's true angle, so only at 1 m
            assert abs(out["areaM2"] - truth) <= tol
        gj = json.loads((tmp_path / doc_path(doc) / "catchments.geojson").read_text("utf-8"))
        assert gj["features"][0]["properties"]["areaM2"] == pytest.approx(out["areaM2"], abs=0.1)


def doc_path(doc: dict) -> str:
    return f"survey/hydro/{doc['id']}"


def test_a_given_outlet_snaps_to_the_channel_and_nested_outlets_split_the_catchment(tmp_path):
    s, g = v_grid(1.0)
    write_grid(tmp_path, "v", g)
    e0, n0 = s.centre
    outlets = [[e0 + 2.0, n0 - 50.5], [e0 - 1.0, n0]]
    result, _ = run_job(HydroFlow(), tmp_path, {"surface": "v", "mode": "catchment", "outlets": outlets})
    lo, mid = run_of(tmp_path, result["outputs"]["commit"])["results"]["outlets"]
    assert lo["pourPoint"] == pytest.approx([e0, n0 - 50.5], abs=1e-9)
    # snapped to the largest accumulation within 5 m: down the channel
    assert mid["pourPoint"][0] == e0 and n0 - 5.5 <= mid["pourPoint"][1] < n0
    # the upper outlet takes the valley upstream of it
    up = s.centre[1] + 50.5 - mid["pourPoint"][1]
    assert mid["areaM2"] == pytest.approx(101 * up, rel=0.03)
    assert lo["areaM2"] + mid["areaM2"] == pytest.approx(101 * 101, rel=1e-9)


@pytest.mark.parametrize("method", ["d8", "dinf"])
def test_a_runoff_path_ends_at_the_pour_point(tmp_path, method):
    s, g = v_grid(1.0)
    write_grid(tmp_path, "v", g)
    e0, n0 = s.centre
    drop = [e0 - 30.2, n0 + 40.3]
    result, _ = run_job(
        HydroFlow(), tmp_path, {"surface": "v", "mode": "runoff", "drop": drop, "method": method}
    )
    doc = run_of(tmp_path, result["outputs"]["commit"])
    path = doc["results"]["path"]
    assert path["end"] == pytest.approx([e0, n0 - 50.5], abs=1e-9)
    assert path["leavesSurface"] is True and path["start"] == drop
    assert path["fallM"] == pytest.approx(
        float(s.heights(np.array(drop[0]), np.array(drop[1]))) - s.base, abs=0.4
    )
    gj = json.loads((tmp_path / doc_path(doc) / "path.geojson").read_text("utf-8"))
    coords = gj["features"][0]["geometry"]["coordinates"]
    assert len(coords[0]) == 3 and coords[-1][:2] == pytest.approx([e0, n0 - 50.5], abs=1e-3)
    chain = gj["features"][0]["properties"]["chainageM"]
    assert chain[0] == 0 and chain[-1] == pytest.approx(path["lengthM"], abs=0.01)
    # downhill all the way
    zs = [c[2] for c in coords]
    assert all(b <= a + 1e-9 for a, b in itertools.pairwise(zs))


def test_streams_follow_the_channel_from_the_threshold(tmp_path):
    s, g = v_grid(1.0)
    write_grid(tmp_path, "v", g)
    result, _ = run_job(HydroFlow(), tmp_path, {"surface": "v", "mode": "streams", "streamAreaM2": 2000})
    doc = run_of(tmp_path, result["outputs"]["commit"])
    assert doc["results"]["streamAreaM2"] == 2000 and doc["results"]["streamLinks"] >= 1
    gj = json.loads((tmp_path / doc_path(doc) / "streams.geojson").read_text("utf-8"))
    xs = [c[0] for f in gj["features"] for c in f["geometry"]["coordinates"]]
    assert max(abs(x - s.centre[0]) for x in xs) < 1e-6  # all on the channel
    # the stream starts where the channel has drained 2,000 m² (about 20 rows from the top)
    ys = [c[1] for f in gj["features"] for c in f["geometry"]["coordinates"]]
    assert s.centre[1] + 50.5 - max(ys) == pytest.approx(20, abs=2)


def test_a_flat_area_with_a_pit_drains_after_filling_or_breaching(tmp_path):
    w, e, n = two_basins(tmp_path)
    for dep in ("fill", "breach"):
        result, _ = run_job(
            HydroFlow(),
            tmp_path,
            {"surface": "pits", "mode": "runoff", "drop": [w + 3, n], "depressions": dep},
            job_id=dep,
        )
        path = run_of(tmp_path, result["outputs"]["commit"])["results"]["path"]
        assert path["leavesSurface"] is True


@pytest.mark.parametrize(
    "params, message",
    [
        ({"surface": "s", "mode": "runoff"}, "Runoff needs a drop point"),
        ({"surface": "s", "mode": "catchment", "method": "mfd"}, "method must be one of"),
        ({"surface": "s", "mode": "streams", "streamAreaM2": 0}, "streamAreaM2 must be a positive area"),
        ({"surface": "s", "mode": "catchment", "outlets": [[0, 0]] * 101}, "up to 100"),
    ],
)
def test_flow_parameters_are_checked(params, message):
    with pytest.raises(JobError, match=message):
        HydroFlow().validate(params)


def test_a_surface_too_large_for_the_tool_asks_for_a_region(tmp_path, monkeypatch):
    import aio_pipelines.hydro.flow as flow

    s, g = v_grid(1.0)
    write_grid(tmp_path, "v", g)
    monkeypatch.setattr(flow, "MAX_CELLS", 1000)
    with pytest.raises(JobError, match="Draw a region"):
        run_job(HydroFlow(), tmp_path, {"surface": "v", "mode": "streams"})


# ---------------------------------------------------------------------------------- direct rainfall


def plane(
    tmp_path: Path, slope: float, cell: float = 0.5, length: float = 100.0, width: float = 20.0
) -> None:
    """A plane falling east at ``slope``, ``length`` by ``width`` metres, prepared at ``cell``."""
    nx, ny = round(length / cell), round(width / cell)
    x = (np.arange(nx) + 0.5) * cell
    z = np.tile(50.0 + slope * (length - x), (ny, 1))
    write_surface(tmp_path, "plane", z, 1000.0, 2000.0, cell)


def write_rain(path: Path, rows: list[tuple[float, float]]) -> str:
    path.write_text("time_min,intensity_mm_h\n" + "".join(f"{t},{i}\n" for t, i in rows), "utf-8")
    return str(path)


@pytest.mark.parametrize("cell", [2, 1, 0.5])
@pytest.mark.parametrize("slope, n, rain, infil", [(0.01, 0.03, 50.0, 0.0), (0.05, 0.03, 60.0, 10.0)])
def test_rain_on_a_tilted_plane_reaches_the_steady_outflow_within_5_percent(
    tmp_path, cell, slope, n, rain, infil
):
    plane(tmp_path, slope)
    hy = write_rain(tmp_path / "rain.csv", [(0, rain), (120, 0)])
    params = {
        "surface": "plane",
        "hyetograph": hy,
        "manningN": n,
        "infiltrationMmPerH": infil,
        "cellM": cell,
        "durationMin": 90,
    }
    result, _ = run_job(HydroRainfall(), tmp_path, params)
    doc = run_of(tmp_path, result["outputs"]["commit"])
    res = doc["results"]
    steady = (rain - infil) / 1000 / 3600 * 100 * 20  # m³/s: effective rain times area
    assert res["finalOutflowM3s"] == pytest.approx(steady, rel=0.05)
    assert res["massErrorPct"] < 1e-6
    assert "preview" not in doc
    assert res["areaM2"] == pytest.approx(2000)
    assert res["frameMin"] == 2 and len(res["frames"]) == 45
    folder = tmp_path / doc_path(doc)
    f = res["frames"][-1]
    assert (folder / f["file"]).is_file() and (folder / f["view"]).is_file()
    hydro = (folder / "hydrograph.csv").read_text("utf-8").splitlines()
    assert hydro[0] == "timeMin,rainM3s,outflowM3s,storedM3" and len(hydro) == 451


def test_the_steady_depth_matches_the_kinematic_wave():
    # at 0.5 m the outlet depth is (q n / S^0.5)^(3/5) for q the rain over the plane's length
    from aio_pipelines.hydro.inertial import InertialModel, run

    dx, length, width, slope, n = 0.5, 100.0, 10.0, 0.01, 0.03
    nx, ny = round(length / dx), round(width / dx)
    x = (np.arange(nx) + 0.5) * dx
    m = InertialModel(np.tile(10 + slope * (length - x), (ny, 1)), dx, n, 0.0)
    i = 50 / 1000 / 3600
    run(m, lambda t: i, [], 3600.0, lambda t: None)
    want = (i * length * n / math.sqrt(slope)) ** 0.6
    assert m.h[ny // 2, -1] == pytest.approx(want, rel=0.02)


def test_rain_stops_and_the_water_drains_and_soaks_in(tmp_path):
    plane(tmp_path, 0.01, cell=1.0, length=40, width=10)
    hy = write_rain(tmp_path / "rain.csv", [(0, 40), (10, 0)])
    params = {
        "surface": "plane",
        "hyetograph": hy,
        "manningN": 0.03,
        "infiltrationMmPerH": 5,
        "cellM": 1,
        "durationMin": 60,
    }
    result, _ = run_job(HydroRainfall(), tmp_path, params)
    res = run_of(tmp_path, result["outputs"]["commit"])["results"]
    assert res["rainM3"] == pytest.approx(40 / 1000 / 6 * 400)
    assert res["storedM3"] < 0.01 * res["rainM3"]
    assert res["infiltratedM3"] > 0 and res["outflowM3"] > 0
    assert res["massErrorPct"] < 1e-6
    assert res["peakAtMin"] <= 12


def test_a_pond_fills_and_holds_its_water(tmp_path):
    w, e, n = two_basins(tmp_path)
    hy = write_rain(tmp_path / "rain.csv", [(0, 100), (30, 0)])
    params = {
        "surface": "pits",
        "hyetograph": hy,
        "manningN": 0.03,
        "infiltrationMmPerH": 0,
        "cellM": 2,
        "region": [[10, 30], [50, 30], [50, 70], [10, 70]],
    }
    result, _ = run_job(HydroRainfall(), tmp_path, params)
    doc = run_of(tmp_path, result["outputs"]["commit"])
    res = doc["results"]
    # all the rain on the pit's catchment stays in the pit: most of the region drains to it
    assert res["storedM3"] > 0.5 * res["rainM3"] and res["maxDepthM"] > 0.05
    assert res["durationMin"] == 30 and res["frameMin"] == 1


def test_the_hyetograph_reader_and_the_rain_steps(tmp_path):
    p = tmp_path / "r.csv"
    p.write_text("minutes;mm per hour\n0;10\n5;20\n15;0\n", "utf-8")
    rows = read_hyetograph(p)
    assert rows == [(0, 10), (5, 20), (15, 0)]
    at, changes = rain_function(rows)
    assert changes == [0, 300, 900]
    assert at(10) == pytest.approx(10 / 3.6e6) and at(300) == pytest.approx(20 / 3.6e6) and at(900) == 0
    for bad, msg in (
        ("0,1\n", "at least two rows"),
        ("0,1\n0,2\n", "must increase"),
        ("0,1\n5,-1\n", "negative"),
    ):
        p.write_text(bad, "utf-8")
        with pytest.raises(JobError, match=msg):
            read_hyetograph(p)
    assert frame_interval(90) == 2 and frame_interval(10_080) == 180


def test_rainfall_parameters_are_checked():
    base = {
        "surface": "s",
        "hyetograph": str(Path.cwd() / "r.csv"),
        "manningN": 0.03,
        "infiltrationMmPerH": 0,
        "cellM": 1,
    }
    assert HydroRainfall().validate(base) == base
    for bad, msg in (
        ({"cellM": 5}, "cellM must be one of"),
        ({"manningN": 0}, "manningN must be above 0"),
        ({"infiltrationMmPerH": -1}, "infiltrationMmPerH must be at least 0"),
        ({"durationMin": 20_000}, "durationMin must be above 0 and at most 10080"),
        ({"hyetograph": "rain.csv"}, "full path"),
    ):
        with pytest.raises(JobError, match=msg):
            HydroRainfall().validate({**base, **bad})


def test_a_coarse_model_reads_a_fine_surface_through_its_pyramid(tmp_path):
    # a 0.25 m surface with a pyramid: the 2 m model reads level 3, not the whole surface
    from aio_pipelines.hydro.common import load_surface

    plane(tmp_path, 0.01, cell=0.25, length=64, width=16)
    folder = tmp_path / "survey" / "surfaces" / "plane"
    meta = json.loads((folder / "tiles.json").read_text("utf-8"))
    z0 = 50.0 + 0.01 * (64 - (np.arange(256) + 0.5) * 0.25)
    for lv in (1, 2, 3):
        c = 0.25 * 2**lv
        nx, ny = round(64 / c), round(16 / c)
        t = np.full((TILE, TILE), np.nan)
        t[:ny, :nx] = np.tile(50.0 + 0.01 * (64 - (np.arange(nx) + 0.5) * c), (ny, 1))
        (folder / str(lv)).mkdir()
        (folder / str(lv) / "0_0.bin").write_bytes(encode_tile(t))
    meta["levels"] = 4
    (folder / "tiles.json").write_text(json.dumps(meta), "utf-8")
    shutil.rmtree(folder / "0")  # level 0 gone: reading it would fail the test
    surf = load_surface(tmp_path, "plane", None, 10_000, cell=2.0)
    assert surf.raster.z.shape == (8, 32) and surf.raster.cell == 2.0
    want = 50.0 + 0.01 * (64 - (np.arange(32) + 0.5) * 2.0)
    assert np.allclose(surf.raster.z[3], want, atol=1e-6)
    assert z0.size == 256
