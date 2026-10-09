"""survey.overlay (M11 G5): contours on the cone within half a cell of truth with rings closed and
the major interval a multiple of the minor; the slope of a 30 degree plane is 57.74%; elevation
ramps, shaded relief and a comparison's difference as kit pyramids listed in survey/overlays.json.

Synthetic only (survey_synth.py analytic surfaces), prepared through the real survey.prepare.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pytest

from aio_pipelines.pipelines import all_pipelines
from aio_pipelines.runtime import JobError
from aio_pipelines.survey.contours import contour_lines, label_index, levels_of
from aio_pipelines.survey.overlay import hillshade, ramp, resolve_options, slope_ratio
from conftest import run_job
from survey_synth import SITE_E0, SITE_EPSG, SITE_H0, cone, sample_grid, write_cog

N0 = 2331400.0
TAN30 = math.tan(math.radians(30))


def _project(root: Path, grids: dict[str, object]) -> None:
    layers = []
    caps = []
    for k, (lid, g) in enumerate(grids.items()):
        write_cog(g, root / "rasters" / f"{lid}.tif")
        cap = f"c{k + 1}"
        caps.append({"id": cap, "label": f"Survey {k + 1}", "date": f"2026-0{k + 1}-01"})
        layers.append(
            {
                "kind": "raster",
                "id": lid,
                "name": f"DSM {lid}",
                "visible": True,
                "capture": cap,
                "role": "dsm",
                "format": "cog",
                "src": {"path": f"rasters/{lid}.tif"},
            }
        )
    manifest = {
        "schema": "aio.project/1",
        "id": "synthetic-overlays",
        "name": "Synthetic overlays",
        "crs": {"epsg": SITE_EPSG},
        "origin": [SITE_E0, N0, 0.0],
        "captures": caps,
        "layers": layers,
        "severityModels": [],
        "classCatalogues": [],
    }
    (root / "manifest.json").write_text(json.dumps(manifest), "utf-8")
    params = {
        "surfaces": [
            {"id": lid, "name": f"DSM {lid}", "source": {"kind": "dsm", "layer": lid}, "capture": f"c{k + 1}"}
            for k, lid in enumerate(grids)
        ],
        "geodesy": False,
    }
    run_job(all_pipelines()["survey.prepare"], root, params, job_id="prep")


def _overlay(root: Path, params: dict, job_id: str = "ov") -> dict:
    result, _ = run_job(all_pipelines()["survey.overlay"], root, params, job_id=job_id)
    return result


def _plane30(e, n):
    return SITE_H0 + (e - SITE_E0) * TAN30


CONE = cone(radius=20.0, height=8.0, centre=(SITE_E0, N0))
CELL = 0.25


@pytest.fixture(scope="module")
def project(tmp_path_factory) -> Path:
    root = tmp_path_factory.mktemp("overlays")
    flat = sample_grid(lambda e, n: SITE_H0 + 0 * e, (SITE_E0, N0), 26, CELL)
    _project(
        root,
        {
            "flat": flat,
            "cone": CONE.grid(CELL, 26),
            "plane": sample_grid(_plane30, (SITE_E0, N0), 10, CELL),
        },
    )
    return root


# --------------------------------------------------------------------------------- the maths


def test_contours_on_the_cone_are_closed_rings_within_half_a_cell_of_truth():
    g = CONE.grid(CELL, 26)
    z = g.z[::-1]  # rows going north
    south = g.y1 - g.height * g.res
    feats = contour_lines(z, g.x0, south, g.res, 1.0, 2.0)
    truth = {round(c["levelM"], 6): c["radiusM"] for c in CONE.truth["contours"]}
    seen = set()
    for f in feats:
        level = f["properties"]["levelM"]
        if level not in truth:
            continue
        seen.add(level)
        c = np.array(f["geometry"]["coordinates"])
        assert f["properties"]["closed"]
        assert (c[0] == c[-1]).all()
        assert (c[:, 2] == level).all()
        r = np.hypot(c[:-1, 0] - SITE_E0, c[:-1, 1] - N0)
        assert abs(r.mean() - truth[level]) < CELL / 2, level
        assert f["properties"]["major"] == (abs(level / 2 - round(level / 2)) < 1e-9)
    assert seen == set(truth)
    labels = label_index(feats)
    assert labels and all(feats[x["feature"]]["properties"]["major"] for x in labels)


def test_the_major_interval_must_be_a_multiple_of_the_minor():
    assert resolve_options("contours", None) == {"minorM": 0.5, "majorM": 2.5}
    with pytest.raises(JobError, match="whole multiple"):
        resolve_options("contours", {"minorM": 0.5, "majorM": 1.2})
    with pytest.raises(JobError, match="whole multiple"):
        resolve_options("contours", {"minorM": 1, "majorM": 0.5})
    with pytest.raises(JobError, match="contour levels"):
        levels_of(0, 1000, 0.01)
    assert levels_of(100.05, 101.4, 0.5) == [100.5, 101.0]


def test_the_slope_of_a_30_degree_plane_is_57_74_percent():
    g = sample_grid(_plane30, (SITE_E0, N0), 10, CELL)
    pct = slope_ratio(g.z[::-1], CELL) * 100
    assert np.abs(pct - 100 * TAN30).max() < 0.01
    assert abs(100 * TAN30 - 57.74) < 0.01
    deg = np.degrees(np.arctan(pct / 100))
    assert np.abs(deg - 30).max() < 1e-6


def test_slope_stops_default_to_0_30_45_and_60_degrees():
    o = resolve_options("slope", {"style": "degrees"})
    assert [s["value"] for s in o["stops"]] == [0.0, 57.74, 100.0, 173.21]
    assert [round(math.degrees(math.atan(s["value"] / 100))) for s in o["stops"]] == [0, 30, 45, 60]
    with pytest.raises(JobError, match="style must be one of"):
        resolve_options("slope", {"style": "grade"})
    with pytest.raises(JobError, match="ascending"):
        resolve_options(
            "slope", {"stops": [{"value": 5, "color": "#000000"}, {"value": 1, "color": "#ffffff"}]}
        )


def test_ramps_smooth_and_stepped_and_the_hillshade():
    stops = [{"value": 0, "color": "#000000"}, {"value": 10, "color": "#ffffff"}]
    v = np.array([[0.0, 5.0, 10.0, np.nan]])
    smooth = ramp(v, stops)
    assert smooth[0, :3, 0].tolist() == [0, 128, 255] and smooth[0, 3, 3] == 0
    stepped = ramp(v, stops, stepped=True)
    assert stepped[0, :3, 0].tolist() == [0, 0, 255]
    flat = np.full((5, 5), 100.0)
    assert np.allclose(hillshade(flat, 1.0, 315, 45), math.sin(math.radians(45)))
    # a slope rising to the west faces east: a sun in the east at 45 degrees lights it fully
    e = np.arange(5.0)
    facing = np.tile(-e * math.tan(math.radians(45)), (5, 1))
    assert np.allclose(hillshade(facing, 1.0, 90, 45), 1.0)
    assert np.allclose(hillshade(facing, 1.0, 270, 45), 0.0)


# ------------------------------------------------------------------------------ the pipeline


def test_contours_of_a_prepared_surface_are_written_and_listed(project):
    _overlay(
        project, {"surface": "cone", "kind": "contours", "options": {"minorM": 0.5, "majorM": 2.5}}, "c1"
    )
    reg = json.loads((project / "survey" / "overlays.json").read_text("utf-8"))
    assert reg["schema"] == "aio.survey-overlays/1"
    o = next(x for x in reg["overlays"] if x["kind"] == "contours")
    assert o["id"] == "contours-cone" and o["dir"] == "survey/overlays/contours-cone"
    assert o["source"] == {"surface": "cone"} and o["visible"] is True
    assert o["options"] == {"minorM": 0.5, "majorM": 2.5}
    assert o["fingerprint"].startswith("sha256:")
    doc = json.loads((project / o["dir"] / "contours.geojson").read_text("utf-8"))
    assert doc["crs"] == {"epsg": SITE_EPSG}
    levels = {f["properties"]["levelM"] for f in doc["features"]}
    assert {SITE_H0 + k * 0.5 for k in range(1, 16)} <= levels
    for f in doc["features"]:
        lv = f["properties"]["levelM"]
        assert abs(lv / 0.5 - round(lv / 0.5)) < 1e-9
        assert f["properties"]["major"] == (abs(lv / 2.5 - round(lv / 2.5)) < 1e-9)
        if abs(lv - SITE_H0) > 0.1:
            assert f["properties"]["closed"]
    # never in the manifest
    m = json.loads((project / "manifest.json").read_text("utf-8"))
    assert all(layer["id"] != o["id"] for layer in m["layers"])


def test_a_slope_overlay_is_a_kit_pyramid(project):
    _overlay(project, {"surface": "plane", "kind": "slope", "options": {"style": "degrees"}}, "s1")
    reg = json.loads((project / "survey" / "overlays.json").read_text("utf-8"))
    o = next(x for x in reg["overlays"] if x["kind"] == "slope")
    assert o["stats"]["minPercent"] == pytest.approx(57.735, abs=0.01)
    assert o["stats"]["maxPercent"] == pytest.approx(57.735, abs=0.01)
    tiles = json.loads((project / o["dir"] / "tiles.json").read_text("utf-8"))
    assert tiles["schema"] == "aio.tiles/1" and tiles["legend"]["style"] == "degrees"
    lv = tiles["levels"][0]
    assert lv["pattern"].startswith(f"{o['dir']}/")
    first = project / lv["pattern"].format(x=0, y=0).replace("{z}", str(lv["z"]))
    assert first.is_file()
    # corners in the local frame: the plane's west edge is 10 m west of the origin
    assert tiles["corners"]["tl"][0] == pytest.approx(-10.0, abs=1e-6)


def test_elevation_relief_and_a_difference(project):
    _overlay(
        project,
        {"surface": "cone", "kind": "elevation", "options": {"stepped": True, "range": [121, 126]}},
        "e1",
    )
    _overlay(
        project, {"surface": "cone", "kind": "relief", "options": {"azimuth": 300, "intensity": 0.6}}, "r1"
    )
    comp = {"from": {"kind": "survey", "surface": "flat"}, "to": {"kind": "survey", "surface": "cone"}}
    _overlay(project, {"comparison": comp, "kind": "contours", "options": {"minorM": 1, "majorM": 2}}, "d1")
    reg = json.loads((project / "survey" / "overlays.json").read_text("utf-8"))
    by = {o["id"]: o for o in reg["overlays"]}
    el = by["elevation-cone"]
    assert el["options"]["stepped"] is True and len(el["options"]["stops"]) == 5
    assert el["legend"]["stepped"] is True
    assert by["relief-cone"]["options"] == {"azimuth": 300.0, "altitude": 45.0, "intensity": 0.6}
    diff = by["contours-flat-to-cone"]
    assert diff["source"] == {"comparison": comp}
    doc = json.loads((project / diff["dir"] / "contours.geojson").read_text("utf-8"))
    radii = {}
    for f in doc["features"]:
        c = np.array(f["geometry"]["coordinates"])
        radii[f["properties"]["levelM"]] = np.hypot(c[:, 0] - SITE_E0, c[:, 1] - N0).mean()
    # the difference is the cone above the flat ground: level L at radius 20 (1 - L / 8)
    for level in (1.0, 2.0, 4.0, 6.0):
        assert abs(radii[level] - 20 * (1 - level / 8)) < CELL / 2
    # running again replaces the overlay in place
    _overlay(project, {"surface": "cone", "kind": "relief", "options": {"intensity": 0.2}}, "r2")
    reg2 = json.loads((project / "survey" / "overlays.json").read_text("utf-8"))
    assert [o["id"] for o in reg2["overlays"]].count("relief-cone") == 1
    assert (project / "survey" / "overlays.json.bak").is_file()


def test_bad_parameters_are_refused(project):
    p = all_pipelines()["survey.overlay"]
    with pytest.raises(JobError, match="not prepared"):
        _overlay(project, {"surface": "nope", "kind": "slope"}, "bad1")
    with pytest.raises(JobError, match=r"comparison.from"):
        p.validate({"comparison": {"from": {"kind": "smart"}, "to": {"kind": "current"}}, "kind": "slope"})
    with pytest.raises(JobError, match="does not take"):
        p.validate({"surface": "cone", "kind": "relief", "options": {"sun": 1}})
    with pytest.raises(JobError, match="between"):
        p.validate({"surface": "cone", "kind": "relief", "options": {"intensity": 3}})
