"""Antenna units on synthetic crowns: conventions by hand, then accuracy against the generator truth.

The helpers pass the truth axis and crop the crown band themselves, so these tests do not depend on
the crown step (`telecom/crown.py`).
"""

from __future__ import annotations

import math
from functools import cache
from itertools import combinations

import numpy as np
import pytest

from aio_pipelines.telecom.boxes import classify, pair_faces
from aio_pipelines.telecom.faces import planar_faces
from aio_pipelines.telecom.measure import (
    azimuth_deg,
    downtilt_deg,
    from_project,
    grid_convergence_deg,
    measure_unit,
    plumb_deg,
    to_project,
    to_project_dir,
)
from antenna_synth import tower_cloud

ORIGIN = (500.0, 1000.0, 10.0)


def shaft_radius(truth):
    prof = np.asarray(truth["shaftRadiusAt"], dtype=float)
    return lambda h: np.interp(h, prof[:, 0], prof[:, 1])


def crop_band(xyz, truth):
    """The crown band: from below the lowest unit (lower brackets included) to above the upper
    brackets, within 4 m of the axis."""
    ys = [u["centre"][1] for u in truth["units"]]
    lo, hi = min(ys) - 1.2, max(ys) + 2.2
    r = np.hypot(xyz[:, 0], xyz[:, 2])
    return xyz[(xyz[:, 1] >= lo) & (xyz[:, 1] <= hi) & (r < 4.0)]


@cache
def _detect(kind, seed, ppm2, attached):
    xyz, truth = tower_cloud(kind, seed=seed, points_per_m2=ppm2, attached=attached)
    crown = crop_band(xyz, truth)
    axis_point = np.asarray(truth["axis"]["point"], dtype=float)
    axis_dir = np.asarray(truth["axis"]["dir"], dtype=float)
    faces = planar_faces(crown, axis_point, axis_dir, shaft_radius(truth))
    units = pair_faces(faces, axis_point, crown)
    out = []
    for u in units:
        radial = u.centre - axis_point
        radial = radial - (radial @ axis_dir) * axis_dir
        assert classify(u, radial / np.linalg.norm(radial)) == u.kind
        out.append(measure_unit(u, ORIGIN, None))
    return out, truth


def detect_on_truth_axis(kind, seed=1, ppm2=4000.0, attached=False):
    """Crop the band, find faces, pair them into units, classify and measure (origin `ORIGIN`).
    `attached` uses the generator variant whose units clamp onto their mount pipes."""
    return _detect(kind, seed, ppm2, attached)


def _centre(u):
    return np.asarray(u["box"]["centre"], dtype=float)


def _truth_centre(t):
    return to_project(np.asarray([t["centre"]], dtype=float), ORIGIN)[0]


def match(units, t, radius):
    """The unit whose box centre is nearest the truth unit's centre, within `radius` metres."""
    c = _truth_centre(t)
    assert units, "no units found"
    d = [float(np.linalg.norm(_centre(u) - c)) for u in units]
    i = int(np.argmin(d))
    assert d[i] <= radius, f"no unit within {radius} m of {t['name']} (nearest {d[i]:.3f} m)"
    return units[i]


def ang(a, b):
    """Absolute angle between two bearings in degrees."""
    return abs((a - b + 180.0) % 360.0 - 180.0)


def _truth(truth, name):
    return next(u for u in truth["units"] if u["name"] == name)


def test_conventions_by_hand():
    n = np.array([0.0, -math.sin(math.radians(5)), -math.cos(math.radians(5))])  # north, beam 5° down
    assert azimuth_deg(n) == pytest.approx(0.0, abs=1e-6) and downtilt_deg(n) == pytest.approx(5.0)
    assert azimuth_deg(np.array([1.0, 0, 0])) == pytest.approx(90.0)
    assert azimuth_deg(np.array([0.0, 0, 1.0])) == pytest.approx(180.0)
    assert azimuth_deg(np.array([-1.0, 0, 0])) == pytest.approx(270.0)
    top_west = np.array([-math.sin(math.radians(2)), math.cos(math.radians(2)), 0.0])
    assert plumb_deg(top_west, np.array([0.0, 0, -1])) == pytest.approx(
        2.0
    )  # north-facing, top leans west = right
    # the sign of the long axis does not matter, and an east-facing unit leaning north leans right
    assert plumb_deg(-top_west, np.array([0.0, 0, -1])) == pytest.approx(2.0)
    top_north = np.array([0.0, math.cos(math.radians(3)), -math.sin(math.radians(3))])
    assert plumb_deg(top_north, np.array([1.0, 0, 0])) == pytest.approx(3.0)


def test_convergence_matches_the_app():
    assert grid_convergence_deg(18.0, 45.0, 32633) == pytest.approx(
        2.12, abs=0.02
    )  # east of the meridian: positive
    assert grid_convergence_deg(15.0, 45.0, 32633) == pytest.approx(0.0, abs=1e-3)
    assert grid_convergence_deg(12.0, 45.0, 32633) == pytest.approx(-2.12, abs=0.02)
    # the values packages/geo/src/crs.test.ts asserts for gridConvergenceDeg
    assert abs(grid_convergence_deg(51.0, 29.0, 32639)) < 1e-6
    east = grid_convergence_deg(53.0, 29.0, 32639)
    assert 0.9 < east < 1.05
    assert grid_convergence_deg(49.0, 29.0, 32639) == pytest.approx(-east, abs=1e-3)


def test_to_project_round_trip():
    local = np.array([[1.0, 2.0, 3.0], [-4.5, 0.25, -7.0]])
    proj = to_project(local, (100.0, 200.0, 10.0))
    assert proj.tolist() == [[101.0, 197.0, 12.0], [95.5, 207.0, 10.25]]
    assert np.allclose(from_project(proj, (100.0, 200.0, 10.0)), local)
    # directions carry no origin: east stays east, south (+z) becomes -N, up becomes +Z
    assert to_project_dir(np.array([[1.0, 0, 0], [0, 0, 1.0], [0, 1.0, 0]])).tolist() == [
        [1.0, 0.0, 0.0],
        [0.0, -1.0, 0.0],
        [0.0, 0.0, 1.0],
    ]


def _assert_accuracy(units, truth):
    for t in [u for u in truth["units"] if u["kind"] != "other"]:
        m = match(units, t, radius=0.3)
        assert m["kind"] == t["kind"], t["name"]
        assert ang(m["azimuthGridDeg"]["value"], t["azimuthDeg"]) <= 1.0, t["name"]
        if t["kind"] != "dish":
            assert abs(m["downtiltDeg"]["value"] - t["downtiltDeg"]) <= 1.5, t["name"]
            assert abs(m["plumbDeg"]["value"] - t["plumbDeg"]) <= 1.5, t["name"]
            for k in ("widthM", "heightM", "depthM"):
                assert abs(m[k]["value"] - t[k]) <= 0.03, (t["name"], k)
        else:  # ruling P6: the diameter and elevation stand for a dish's size
            assert abs(m["diameterM"]["value"] - t["diameterM"]) <= 0.03
            assert abs(m["elevationDeg"]["value"] - t["elevationDeg"]) <= 1.5
            assert "downtiltDeg" not in m and "plumbDeg" not in m


@pytest.mark.parametrize("kind", ["monopole", "lattice"])
def test_synthetic_crown_accuracy(kind):
    units, truth = detect_on_truth_axis(kind, seed=1)
    _assert_accuracy(units, truth)


def test_synthetic_crown_accuracy_at_e2e_density():
    # ruling P9: the end to end fixture samples 1500 points per square metre
    units, truth = detect_on_truth_axis("monopole", seed=1, ppm2=1500.0)
    _assert_accuracy(units, truth)


# Attached variant (ruling T4-R1): unit backs clamp onto their mount pipes, the dish is bolted to a
# pipe clamped to the frame, and a cable lies across the front of panel-0.


@pytest.mark.parametrize(("kind", "ppm2"), [("monopole", 4000.0), ("lattice", 4000.0), ("monopole", 1500.0)])
def test_attached_crown_accuracy(kind, ppm2):
    units, truth = detect_on_truth_axis(kind, seed=1, ppm2=ppm2, attached=True)
    _assert_accuracy(units, truth)


@pytest.mark.parametrize("kind", ["monopole", "lattice"])
def test_dish_bolted_to_its_pipe_is_found(kind):
    units, truth = detect_on_truth_axis(kind, seed=1, attached=True)
    m = match(units, _truth(truth, "dish-60"), radius=0.3)
    assert m["kind"] == "dish"
    assert abs(m["diameterM"]["value"] - 0.6) <= 0.03
    assert ang(m["azimuthGridDeg"]["value"], 60.0) <= 1.0


@pytest.mark.parametrize("kind", ["monopole", "lattice"])
def test_panel_clamped_to_its_pipe_keeps_its_size(kind):
    units, truth = detect_on_truth_axis(kind, seed=1, attached=True)
    for name in ("panel-120", "short-120", "wide-300"):  # backs touch a pipe that runs 3 m
        t = _truth(truth, name)
        m = match(units, t, radius=0.3)
        assert abs(m["heightM"]["value"] - t["heightM"]) <= 0.03, name
        assert abs(m["box"]["extents"][1] - t["heightM"]) <= 0.03, name


@pytest.mark.parametrize("kind", ["monopole", "lattice"])
def test_cable_across_a_front_does_not_widen_it(kind):
    units, truth = detect_on_truth_axis(kind, seed=1, attached=True)
    t = _truth(truth, "panel-0")  # the cable runs 0.45 m past both sides of the face
    m = match(units, t, radius=0.3)
    assert abs(m["widthM"]["value"] - t["widthM"]) <= 0.03
    assert abs(m["heightM"]["value"] - t["heightM"]) <= 0.03
    assert abs(m["plumbDeg"]["value"] - t["plumbDeg"]) <= 1.5


@pytest.mark.parametrize("kind", ["monopole", "lattice"])
def test_wide_unit_is_kept_as_a_panel(kind):
    units, truth = detect_on_truth_axis(kind, seed=1)
    m = match(units, _truth(truth, "wide-300"), radius=0.3)
    assert m["kind"] == "panel"
    assert abs(m["widthM"]["value"] - 1.5) <= 0.03
    assert abs(m["heightM"]["value"] - 1.3) <= 0.03


@pytest.mark.parametrize("kind", ["monopole", "lattice"])
def test_no_units_on_shaft_brackets(kind):
    units, truth = detect_on_truth_axis(kind, seed=1)
    shaft_r = shaft_radius(truth)
    assert units
    for u in units:
        local = from_project(_centre(u)[None, :], ORIGIN)[0]
        r = math.hypot(local[0], local[2])
        assert r > float(shaft_r(local[1])) + 0.1, u["box"]["centre"]


@pytest.mark.parametrize("kind", ["monopole", "lattice"])
def test_no_duplicates(kind):
    units, _ = detect_on_truth_axis(kind, seed=1)
    assert len(units) >= 8
    for a, b in combinations(units, 2):
        assert np.linalg.norm(_centre(a) - _centre(b)) > 0.3, (a["box"]["centre"], b["box"]["centre"])


@pytest.mark.parametrize("kind", ["monopole", "lattice"])
def test_radio_unit_is_never_an_antenna(kind):
    units, truth = detect_on_truth_axis(kind, seed=1)
    c = _truth_centre(_truth(truth, "radio-180"))
    near = [u for u in units if np.linalg.norm(_centre(u) - c) <= 0.3]
    assert all(u["kind"] not in ("panel", "short") for u in near)
    for u in near:  # other equipment is listed with size only, no angles
        assert not {"azimuthGridDeg", "downtiltDeg", "plumbDeg"} & set(u)


def test_occluded_panel_gets_inferred_depth():
    units, truth = detect_on_truth_axis("monopole", seed=1)
    m = match(units, _truth(truth, "panel-240"), radius=0.3)
    assert m["depthM"]["basis"] == "inferred"
    assert m["depthM"]["quality"]["basis"] == "inferred"
    assert "residualM" not in m["depthM"]["quality"] and "support" not in m["depthM"]["quality"]
    # its neighbours with a seen back face measure the depth
    assert match(units, _truth(truth, "panel-0"), radius=0.3)["depthM"]["basis"] == "measured"


def test_quality_fields():
    units, truth = detect_on_truth_axis("monopole", seed=1)
    antennas = [u for u in units if u["kind"] in ("panel", "short")]
    assert len(antennas) >= 7
    for u in antennas:
        for k in ("azimuthGridDeg", "downtiltDeg", "plumbDeg", "widthM", "heightM"):
            q = u[k]["quality"]
            assert u[k]["basis"] == "measured" and q["basis"] == "measured"
            assert 0 < q["residualM"] < 0.01
            assert q["support"] > 150 and isinstance(q["support"], int)
            assert 0 < q["coverage"] <= 1
        assert isinstance(u["support"], int) and u["support"] >= u["azimuthGridDeg"]["quality"]["support"]
    # values are rounded to 0.1 degree and 1 mm
    for u in units:
        if "azimuthGridDeg" in u:
            assert u["azimuthGridDeg"]["value"] == round(u["azimuthGridDeg"]["value"], 1)
        assert u["widthM"]["value"] == round(u["widthM"]["value"], 3)


def test_measure_unit_box_is_in_project_coordinates():
    units, truth = detect_on_truth_axis("monopole", seed=1)
    m = match(units, _truth(truth, "panel-0"), radius=0.3)
    box = m["box"]
    across, up, out = (np.asarray(a) for a in box["axes"])
    # panel-0 faces north (+N in project coordinates), stands up (+Z) and is right-handed
    assert out @ np.array([0.0, 1.0, 0.0]) > 0.99
    assert up @ np.array([0.0, 0.0, 1.0]) > 0.99
    assert np.allclose(np.cross(across, up), out, atol=1e-6)
    assert box["extents"] == [m["widthM"]["value"], m["heightM"]["value"], m["depthM"]["value"]]
