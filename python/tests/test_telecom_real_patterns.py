"""Failure patterns seen on real crowns, reproduced on synthetic ones (`antenna_synth` opt-in parts).

- radios side by side with a slit between them grew into one wide unit;
- the headframe's own parts (a flat-bar frame, a cable tray with cables behind it) became units:
  a frame outline as one big low-coverage box, a tray as a panel whose depth was read off the
  cables behind it;
- faces that are no box's front: a side face (narrower than the box is deep), a face with no
  end to the points behind it, a thin plate, a pole;
- a pipe in front of a face shades a stripe of it, which is not a slit between two units.

The crown band and the bare shaft below it are covered in `test_telecom_crown.py`, the crop
margin in `test_telecom_photos.py`.
"""

from __future__ import annotations

import numpy as np
import pytest

from aio_pipelines.telecom.boxes import MAX_D, Unit, _is_box, classify, pair_faces
from aio_pipelines.telecom.faces import Face, planar_faces
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
    assert not _is_box(_unit(0.15, 2.4, 0.08))  # a pole or a cable bundle


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
