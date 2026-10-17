"""Failure patterns seen on real crowns, reproduced on synthetic ones (`antenna_synth` opt-in parts).

- radios side by side with a slit between them grew into one wide unit;
- the headframe's own parts (a flat-bar frame, a cable tray with cables behind it) became units:
  a frame outline as one big low-coverage box, a tray as a panel whose depth was read off the
  cables behind it;
- faces that are no box's front: a side face (narrower than the box is deep), a face with no
  end to the points behind it, a thin plate, a pole;
- a pipe in front of a face shades a stripe of it, which is not a slit between two units, and
  hides part of a lone front, which must not read as patchy;
- slender units (0.12 to 0.2 m wide) were deleted; they are listed as other equipment unless
  clearly structure;
- candidate boxes were left out silently: each is now counted by reason and named in a warning.

The crown band and the bare shaft below it are covered in `test_telecom_crown.py`, the crop
margin in `test_telecom_photos.py`.
"""

from __future__ import annotations

import numpy as np
import pytest

from aio_pipelines.telecom.boxes import (
    DROP_COVERAGE,
    DROP_NO_BACK,
    DROP_PART,
    DROP_SIDE_FACE,
    DROP_SIZE,
    DROP_SPANS,
    DROP_STRUCTURE,
    MAX_D,
    MIN_LONE_COVERAGE,
    Unit,
    _drop_reason,
    _is_box,
    classify,
    drop_warning,
    pair_faces,
)
from aio_pipelines.telecom.faces import COVERAGE_CELL_M, Face, coverage, planar_faces
from aio_pipelines.telecom.measure import measure_unit
from antenna_synth import tower_cloud
from test_telecom_faces import AXIS_DIR, AXIS_POINT, _pipe, _plane, _shaft_r
from test_telecom_measure import (
    ORIGIN,
    _assert_accuracy,
    _centre,
    _truth,
    _truth_centre,
    ang,
    crop_band,
    match,
    shaft_radius,
)


def _detect(kind, ppm2=4000.0, **variant):
    xyz, truth = tower_cloud(kind, seed=1, points_per_m2=ppm2, **variant)
    crown = crop_band(xyz, truth)
    faces = planar_faces(crown, np.zeros(3), np.array([0.0, 1.0, 0.0]), shaft_radius(truth))
    units = pair_faces(faces, np.zeros(3), crown)
    return [measure_unit(u, ORIGIN, None) for u in units], units, truth


CASES = [
    ("monopole", 4000.0, False),
    ("lattice", 4000.0, False),
    ("monopole", 1500.0, False),
    ("monopole", 4000.0, True),
    ("lattice", 1500.0, True),
]


@pytest.mark.parametrize(("kind", "ppm2", "attached"), CASES)
def test_radios_side_by_side_stay_two_units(kind, ppm2, attached):
    units, _, truth = _detect(kind, ppm2, radios=True, attached=attached)
    _assert_accuracy(units, truth)  # the pair is in the truth: each one measured on its own
    for name in ("radio-pair-a", "radio-pair-b"):
        t = _truth(truth, name)
        m = match(units, t, radius=0.05)
        assert abs(m["widthM"]["value"] - t["widthM"]) <= 0.03, name
        assert ang(m["azimuthGridDeg"]["value"], 180.0) <= 1.0, name


@pytest.mark.parametrize(("kind", "ppm2"), [("monopole", 4000.0), ("lattice", 4000.0), ("monopole", 1500.0)])
def test_headframe_parts_are_no_units(kind, ppm2):
    units, raw, truth = _detect(kind, ppm2, interior=True)
    _assert_accuracy(units, truth)
    frame = _truth_centre(truth["interior"]["frame"])
    tray = _truth_centre(truth["interior"]["tray"])
    for m in units:
        w, h, _ = m["box"]["extents"]
        # no box outlines the frame (mostly air), none takes the tray for an antenna
        assert not (np.linalg.norm(_centre(m) - frame) < 1.0 and w > 1.2 and h > 1.2), m["box"]
        if np.linalg.norm(_centre(m) - tray) < 0.6:
            assert m["kind"] not in ("panel", "short"), m["box"]
    for u in raw:  # no depth read off clutter all the way to the cap
        assert u.depth_measured or u.extents[2] < MAX_D - 0.01


def _face(width, height, coverage=1.0, centre=(2.2, 10.0, 0.0), normal=(1.0, 0.0, 0.0)) -> Face:
    n = np.asarray(normal, dtype=float)
    up = np.array([0.0, 1.0, 0.0])
    return Face(
        np.zeros((200, 3)),
        np.asarray(centre, float),
        n,
        up,
        np.cross(up, n),
        height,
        width,
        0.003,
        200,
        coverage,
    )


def _unit(w, h, d, measured=True, coverage=1.0) -> Unit:
    f = _face(w, h, coverage)
    centre = f.centre - f.normal * d / 2
    return Unit(
        "", f, [f], centre, np.vstack([f.side, f.up, f.normal]), np.array([w, h, d]), measured, 200, None
    )


def test_a_box_needs_a_solid_front_wider_than_it_is_deep():
    assert _is_box(_unit(0.42, 2.6, 0.29))
    assert _is_box(_unit(0.30, 1.4, 0.15, measured=False))
    assert not _is_box(_unit(0.13, 2.5, 0.30))  # a side face: the box is deeper than its front is wide
    assert not _is_box(_unit(1.6, 2.8, 0.40, coverage=0.4))  # an outline of bars, mostly air
    assert not _is_box(_unit(0.45, 1.1, 0.20, measured=False, coverage=0.75))  # one sparse face
    assert not _is_box(_unit(0.40, 1.4, MAX_D, measured=False))  # nothing ended behind it
    assert not _is_box(_unit(0.15, 2.4, 0.08))  # a pole or a cable bundle: longer than equipment


def test_each_drop_has_its_reason():
    assert _drop_reason(_unit(0.42, 2.6, 0.29)) is None
    assert _drop_reason(_unit(0.42, 3.8, 0.29)) == DROP_SIZE
    assert _drop_reason(_unit(0.13, 2.5, 0.30)) == DROP_STRUCTURE  # slender and 2.5 m long
    assert _drop_reason(_unit(0.30, 1.0, 0.35)) == DROP_SIDE_FACE
    assert _drop_reason(_unit(1.6, 2.8, 0.40, coverage=0.4)) == DROP_COVERAGE
    assert _drop_reason(_unit(0.90, 1.4, MAX_D, measured=False)) == DROP_NO_BACK


def _flat_shaft(r):
    return lambda h: np.full_like(np.asarray(h, dtype=float), r)


def test_slender_equipment_is_listed_as_other():
    # R-width: 0.12 to 0.2 m wide and over 4 times taller, but no longer than equipment that
    # narrow (1.5 m) and clear of the shaft: kept, with kind "other" (no angles)
    radial = np.array([1.0, 0.0, 0.0])
    for w, h in ((0.15, 0.9), (0.12, 1.5), (0.19, 1.2)):
        u = _unit(w, h, 0.10)
        assert _is_box(u), (w, h)
        assert classify(u, radial) == "other", (w, h)
        assert not {"azimuthGridDeg", "downtiltDeg", "plumbDeg"} & set(
            measure_unit(_with_kind(u, radial), ORIGIN, None)
        )
    # clearly structure: longer than any equipment that narrow, or a box touching the shaft
    assert _drop_reason(_unit(0.15, 1.6, 0.10)) == DROP_STRUCTURE
    near = _unit(0.15, 0.9, 0.10)  # its back is 2.1 m from the axis
    assert _drop_reason(near, np.zeros(3), _flat_shaft(2.0)) == DROP_STRUCTURE
    assert _drop_reason(near, np.zeros(3), _flat_shaft(1.5)) is None
    # wider than 0.2 m, the slender rule does not apply
    assert _is_box(_unit(0.25, 2.4, 0.10))


def _with_kind(u: Unit, radial) -> Unit:
    u.kind = classify(u, radial)
    return u


def test_drop_warning_text():
    assert drop_warning({}) is None
    assert drop_warning({DROP_PART: 9}) is None  # faces of listed units left nothing out
    # not equipment by size or shape, or no back found: logged, never warned
    assert drop_warning({DROP_SIZE: 4, DROP_STRUCTURE: 2, DROP_NO_BACK: 1}) is None
    assert drop_warning({DROP_SIDE_FACE: 1}) == "1 candidate box was not listed: 1 side face."
    text = drop_warning(
        {DROP_SIDE_FACE: 7, DROP_COVERAGE: 3, DROP_SPANS: 2, DROP_PART: 5, DROP_STRUCTURE: 1, DROP_SIZE: 9}
    )
    assert text == (
        "12 candidate boxes were not listed: 7 side faces, 3 with low coverage, 2 overlapping other units."
    )
    assert "–" not in text and "—" not in text


def test_drops_are_counted_and_faces_of_listed_units_are_not_warned():
    xyz, truth = tower_cloud("monopole", seed=1, interior=True)
    crown = crop_band(xyz, truth)
    faces = planar_faces(crown, np.zeros(3), np.array([0.0, 1.0, 0.0]), shaft_radius(truth))
    drops: dict[str, int] = {}
    units = pair_faces(faces, np.zeros(3), crown, shaft_radius(truth), drops)
    assert len(units) >= 8
    # the side faces of the listed units are found and counted, but as parts of them
    assert drops.get(DROP_PART, 0) >= 6 and DROP_SIDE_FACE not in drops
    # the headframe's frame and tray are real candidates left out: the warning counts them
    left_out = sum(drops.get(k, 0) for k in (DROP_COVERAGE, DROP_SIDE_FACE, DROP_SPANS))
    assert left_out >= 1
    text = drop_warning(drops)
    assert text is not None and text.startswith(f"{left_out} candidate box")
    # the plain crown leaves out nothing but faces of its units: no warning
    plain, truth = tower_cloud("monopole", seed=1)
    crown = crop_band(plain, truth)
    faces = planar_faces(crown, np.zeros(3), np.array([0.0, 1.0, 0.0]), shaft_radius(truth))
    drops = {}
    pair_faces(faces, np.zeros(3), crown, shaft_radius(truth), drops)
    assert drops and drop_warning(drops) is None


def test_coverage_follows_the_point_spacing():
    # R-cov: a uniformly sampled 0.4 x 1.4 m face at 600 points per square metre left a fifth of
    # fixed 5 cm cells empty; cells sized by its spacing leave almost none
    rng = np.random.default_rng(31)
    w, h = 0.4, 1.4
    for ppm2 in (600.0, 1500.0, 4000.0):
        n = round(w * h * ppm2)
        a, b = rng.uniform(0, w, n), rng.uniform(0, h, n)
        assert coverage(a, b, w, h, 0.0, 0.0) >= 0.9, ppm2  # above MIN_LONE_COVERAGE
    # an outline of 5 cm bars (a frame, mostly air) stays patchy at any density
    for ppm2 in (600.0, 4000.0):
        n = round(1.6 * 2.8 * ppm2)
        a, b = rng.uniform(0, 1.6, n), rng.uniform(0, 2.8, n)
        bar = (a < 0.05) | (a > 1.55) | (b < 0.05) | (b > 2.75) | (np.abs(b - 1.4) < 0.025)
        assert coverage(a[bar], b[bar], 1.6, 2.8, 0.0, 0.0) < 0.5, ppm2
    assert COVERAGE_CELL_M == 0.05


def test_coverage_leaves_out_what_something_in_front_hides():
    rng = np.random.default_rng(32)
    w, h, n = 0.4, 1.4, 2000
    a, b = rng.uniform(0, w, n), rng.uniform(0, h, n)
    seen = np.abs(a - 0.15) > 0.05  # a 10 cm stripe (25 percent) has no points
    assert coverage(a[seen], b[seen], w, h, 0.0, 0.0) < MIN_LONE_COVERAGE
    # a pipe in front of the stripe: its cells are not judged
    sa, sb = rng.uniform(0.1, 0.2, 400), rng.uniform(-0.2, 1.6, 400)
    assert coverage(a[seen], b[seen], w, h, 0.0, 0.0, (sa, sb)) >= 0.95
    # something in front of all of a face whose points cover a third of it leaves too little
    # seen to judge: no credit
    patchy = a < 0.13
    wide = (rng.uniform(0, w, 4000), rng.uniform(0, h, 4000))
    assert coverage(a[patchy], b[patchy], w, h, 0.0, 0.0, wide) == pytest.approx(
        coverage(a[patchy], b[patchy], w, h, 0.0, 0.0)
    )


def _lone_panel(rng, ppm2, pipe):
    """A 0.40 x 1.40 x 0.15 m panel 2.3 m east of the axis facing east, with no back face seen and
    a 10 cm stripe of its front (25 percent) hidden, by a 10 cm pipe 0.2 m in front when `pipe`."""
    w, h, d, x = 0.40, 1.40, 0.15, 2.3
    fx = x + d / 2
    front = _plane(rng, [fx, 10.0, 0.0], [0, 0, 1.0], [0, 1.0, 0], w, h, ppm2=ppm2)
    parts = [front[np.abs(front[:, 2] - 0.05) > 0.05]]
    for s in (-1, 1):
        parts.append(_plane(rng, [x, 10.0, s * w / 2], [1.0, 0, 0], [0, 1.0, 0], d, h, ppm2=ppm2))
        parts.append(_plane(rng, [x, 10.0 + s * h / 2, 0.0], [1.0, 0, 0], [0, 0, 1.0], d, w, ppm2=ppm2))
    if pipe:
        parts.append(_pipe(rng, fx + 0.2, 0.05, 9.0, 11.0, r=0.05, ppm2=ppm2))
    return np.vstack(parts)


@pytest.mark.parametrize("ppm2", [4000.0, 1500.0])
def test_a_lone_panel_partly_behind_a_pipe_is_found(ppm2):
    xyz = _lone_panel(np.random.default_rng(21), ppm2, pipe=True)
    faces = planar_faces(xyz, AXIS_POINT, AXIS_DIR, _shaft_r)
    units = [u for u in pair_faces(faces, AXIS_POINT, xyz, _shaft_r) if u.extents[1] > 1.0]
    assert len(units) == 1
    u = units[0]
    m = measure_unit(u, ORIGIN, None)
    assert m["kind"] == "panel" and not u.depth_measured
    assert np.allclose(u.centre, [2.3, 10.0, 0.0], atol=0.03)
    assert abs(m["widthM"]["value"] - 0.40) <= 0.03 and abs(m["heightM"]["value"] - 1.40) <= 0.03
    assert ang(m["azimuthGridDeg"]["value"], 90.0) <= 1.0
    assert u.front.coverage >= MIN_LONE_COVERAGE


def test_a_gap_with_nothing_in_front_is_no_hidden_face():
    # the same stripe with no pipe is a slit: the two sides stay apart, no 0.4 m face is made up
    xyz = _lone_panel(np.random.default_rng(21), 4000.0, pipe=False)
    fronts = [f for f in planar_faces(xyz, AXIS_POINT, AXIS_DIR, _shaft_r) if f.normal[0] > 0.9]
    assert fronts and all(f.width < 0.3 for f in fronts)


def test_thin_or_narrow_faces_are_never_antennas():
    radial = np.array([1.0, 0.0, 0.0])
    assert classify(_unit(0.42, 2.6, 0.29), radial) == "panel"
    assert classify(_unit(0.22, 1.8, 0.06), radial) == "other"  # 6 cm deep: a plate
    assert classify(_unit(0.15, 1.4, 0.09), radial) == "other"  # 15 cm wide: a bar
    assert classify(_unit(0.40, 0.9, 0.04, measured=False), radial) == "short"  # depth unseen


def _two_plates(rng, gap):
    """Two 0.4 x 0.7 plates side by side, `gap` apart, 2.2 m east of the axis, facing east."""
    off = (0.4 + gap) / 2
    return [
        _plane(rng, [2.2, 10.0, s * off], [0, 0, 1.0], [0, 1.0, 0], 0.4, 0.7, noise=0.002) for s in (-1, 1)
    ]


def test_a_slit_between_two_plates_splits_them():
    rng = np.random.default_rng(11)
    faces = planar_faces(np.vstack(_two_plates(rng, 0.05)), AXIS_POINT, AXIS_DIR, _shaft_r)
    assert sorted(round(f.width, 2) for f in faces) == pytest.approx([0.4, 0.4], abs=0.03)


def test_a_pipe_shadow_does_not_split_a_plate():
    rng = np.random.default_rng(12)
    plate = _plane(rng, [2.2, 10.0, 0.0], [0, 0, 1.0], [0, 1.0, 0], 0.45, 0.7, noise=0.002)
    plate = plate[np.abs(plate[:, 2]) > 0.025]  # a 5 cm stripe hidden behind the pipe
    pipe = _pipe(rng, 2.4, 0.0, 9.3, 10.7, r=0.03, ppm2=4000.0)  # 0.2 m in front of the plate
    faces = [
        f for f in planar_faces(np.vstack([plate, pipe]), AXIS_POINT, AXIS_DIR, _shaft_r) if f.height > 0.5
    ]
    assert len(faces) == 1 and abs(faces[0].width - 0.45) < 0.03


def test_variants_leave_the_default_cloud_alone():
    for flag in ("radios", "interior", "clutter"):
        more, _ = tower_cloud("monopole", seed=1, points_per_m2=1500.0, noise=0.0, **{flag: True})
        plain, _ = tower_cloud("monopole", seed=1, points_per_m2=1500.0, noise=0.0)
        assert len(more) > len(plain)
        # the default parts come first and are the same points
        assert np.array_equal(more[: len(plain) - 30_000], plain[: len(plain) - 30_000])
