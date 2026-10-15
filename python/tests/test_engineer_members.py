"""Repeated members and the family suggestion, on the seeded synthetic assets."""

from __future__ import annotations

import math

import numpy as np

from aio_pipelines.engineer.axis import estimate_axis
from aio_pipelines.engineer.cloud import remove_ground
from aio_pipelines.engineer.members import (
    family_hints,
    find_antenna_candidates,
    find_bays,
    find_flues,
    find_legs,
    find_light_candidates,
    find_platforms,
)
from aio_pipelines.engineer.sections import fit_sections, fit_taper
from synth_assets import (
    FLARE,
    LATTICE,
    MONOPOLE,
    STACK,
    flare_cloud,
    lattice_cloud,
    monopole_cloud,
    stack_cloud,
    toward,
)


def _measure(cloud, step=2.0):
    kept, _ = remove_ground(cloud, 0.15)
    axis = estimate_axis(kept)
    slices = fit_sections(kept, axis, step)
    return kept, axis, slices, fit_taper(slices)


def _az_err(a, b):
    return abs((a - b + 180) % 360 - 180)


def test_stack_flues_and_light_levels():
    kept, axis, slices, taper = _measure(stack_cloud(seed=5, noise=0.02)[0])
    flues = find_flues(kept, axis, taper)
    assert len(flues.items) == 3
    for item, az in zip(flues.items, STACK["flueAzimuths"], strict=True):
        want = toward(az, STACK["fluePitchR"])
        assert math.hypot(item.centre[0] - want[0], item.centre[2] - want[2]) < 0.15
        assert abs(item.size - 2 * STACK["flueR"]) < 0.15  # a diameter
        assert _az_err(item.azimuth_deg, az) < 3
        assert item.support > 200
    lights = find_light_candidates(kept, axis, taper, noise=0.02)
    # the crown level (120 m) is a level too; 40 and 80 carry three candidates each
    assert len(lights.levels) == 3
    assert all(abs(a - b) < 0.5 for a, b in zip(lights.levels, STACK["lightLevels"], strict=True))
    assert len(lights.items) == 9
    for level in (40.0, 80.0):
        at = [i for i in lights.items if abs(i.centre[1] - level) < 1.0]
        assert len(at) == 3
        assert all(min(_az_err(i.azimuth_deg, a) for a in (0, 120, 240)) < 3 for i in at)
        assert len({round(i.azimuth_deg / 120) % 3 for i in at}) == 3
        assert all(abs(i.size - STACK["lightSize"]) < 0.15 for i in at)
    d = flues.to_dict()
    assert d["kind"] == "flue" and set(d["items"][0]) == {"centre", "size", "support", "azimuthDeg"}


def test_partial_stack_does_not_invent_the_flue_in_the_gap():
    cloud, truth = stack_cloud(seed=5, partial=True, noise=0.02)
    kept, axis, _, taper = _measure(cloud)
    flues = find_flues(kept, axis, taper)
    assert len(flues.items) == truth["fluesSeen"] == 2
    assert sorted(round(i.azimuth_deg) for i in flues.items) == [30, 270]
    hints = family_hints(kept, axis, [], [flues, find_light_candidates(kept, axis, taper, noise=0.02)])
    assert hints.suggested == "chimney"


def test_stack_hints():
    kept, axis, slices, taper = _measure(stack_cloud(seed=6)[0])
    flues = find_flues(kept, axis, taper)
    hints = family_hints(kept, axis, slices, [flues])
    assert hints.suggested == "chimney" and hints.top_features == 3
    assert hints.fill_ratio > 0.6 and hints.reasons
    assert 0 <= hints.to_dict()["fillRatio"] <= 1


def test_lattice_legs_bays_antennas_and_family():
    kept, axis, slices, taper = _measure(lattice_cloud(seed=2)[0])
    legs = find_legs(kept, axis)
    assert len(legs.items) == 4
    truth_legs = [(3, 3), (3, -3), (-3, -3), (-3, 3)]
    for x, z in truth_legs:
        assert min(math.hypot(i.centre[0] - x, i.centre[2] - z) for i in legs.items) < 0.15
    assert all(abs(i.size - 0.2) < 0.1 for i in legs.items)
    bays = find_bays(kept, axis, legs)
    assert bays is not None and bays["count"] == LATTICE["bays"]
    assert abs(bays["height"] - 5.0) < 0.5
    antennas = find_antenna_candidates(kept, axis)
    assert len(antennas.items) == 6
    got = sorted(round(i.azimuth_deg / 10) * 10 % 360 for i in antennas.items)
    assert all(min(_az_err(a, s) for s in LATTICE["sectors"]) < 15 for a in got)
    assert all(abs(i.size - 1.4) < 0.3 for i in antennas.items)
    hints = family_hints(kept, axis, slices, [legs, antennas])
    assert hints.suggested == "telecom-lattice" and hints.fill_ratio < 0.35
    assert hints.top_features == 3
    assert len(find_flues(kept, axis, taper).items) == 0


def test_monopole_family():
    kept, axis, slices, taper = _measure(monopole_cloud(seed=3)[0], step=1.0)
    flues = find_flues(kept, axis, taper)
    assert flues.items == []
    legs = find_legs(kept, axis)
    assert legs.items == []
    ants = find_antenna_candidates(kept, axis, taper)
    assert any(
        _az_err(i.azimuth_deg, 0) < 15 and abs(i.centre[1] - MONOPOLE["antennaY"]) < 1.0 for i in ants.items
    )
    hints = family_hints(kept, axis, slices, [flues, legs, ants])
    assert hints.suggested == "telecom-monopole"


def test_flare_family_and_platform():
    kept, axis, slices, taper = _measure(flare_cloud(seed=4)[0])
    flues = find_flues(kept, axis, taper)
    assert flues.items == []
    platforms = find_platforms(kept, axis, taper)
    assert any(abs(lv - FLARE["platformLevels"][0]) < 0.75 for lv in platforms.levels)
    hints = family_hints(kept, axis, slices, [flues, find_legs(kept, axis), platforms])
    assert hints.suggested == "flare"
    assert np.isfinite(hints.slenderness)
