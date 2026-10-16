"""Adversarial inputs to the measurement chain: neighbours, clutter, a missing base."""

from __future__ import annotations

import numpy as np
import pytest

from aio_pipelines.engineer.axis import Axis
from aio_pipelines.engineer.cloud import pdal_translate_args, region_centre
from aio_pipelines.engineer.measure import measure_shaft
from aio_pipelines.engineer.members import family_hints
from aio_pipelines.engineer.pipeline import _shaft_height
from aio_pipelines.engineer.sections import SliceFit, Taper, _coherent_sections, fit_sections, fit_taper
from synth_assets import compound_pole_cloud, monopole_cloud, radius_at, stack_cloud


def test_connected_compound_does_not_become_the_shaft():
    m = measure_shaft(compound_pole_cloud(), centre=(0.0, 0.0), step=0.4)
    assert len(m.slices) >= 50
    assert max(s.r for s in m.slices) < 0.6
    assert max(s.y for s in m.slices) > 30
    assert _shaft_height(m.kept, m.axis, m.taper, 0.4, "telecom-monopole") == pytest.approx(31, abs=0.6)
    assert family_hints(m.kept, m.axis, m.slices, []).suggested == "telecom-monopole"


def test_a_short_low_profile_cannot_claim_the_height_of_a_tall_asset():
    cloud = compound_pole_cloud()
    axis = Axis((0, 0, 0), (0, 1, 0), 0)
    assert _shaft_height(cloud, axis, Taper([(0.4, 3.8), (2.0, 3.8)], 0), 0.4, "chimney") is None


def test_an_isolated_bracket_does_not_cut_the_shaft_in_half():
    sections = [SliceFit(i * 0.4, (0, 0), 1.5 if i == 38 else 0.5, 0.002, 100, 1) for i in range(76)]
    kept = _coherent_sections(sections, 0.4)
    assert len(kept) == 75
    assert kept[0].y == 0 and kept[-1].y == 30


def test_dense_upper_attachments_do_not_hide_observed_shaft_sections():
    rng = np.random.default_rng(8)
    y = rng.uniform(0, 31, 30_000)
    a = rng.uniform(0, 2 * np.pi, len(y))
    r = 0.45 - y * 0.007
    pole = np.column_stack([r * np.cos(a), y, r * np.sin(a)])
    y = rng.uniform(24, 30, 30_000)
    a = rng.uniform(0, 2 * np.pi, len(y))
    equipment = np.column_stack([1.4 * np.cos(a), y, 1.4 * np.sin(a)])
    axis = Axis((0, 0, 0), (0, 1, 0), 0)
    slices = fit_sections(np.vstack([pole, equipment]), axis, 0.4)
    assert max(s.y for s in slices) > 30
    assert min(s.y for s in slices if s.y > 24) < 25
    assert all(s.r < 0.6 for s in slices)


def test_section_rejoin_cannot_bridge_a_long_gap_or_a_different_axis():
    low = [SliceFit(i * 0.4, (0, 0), 0.5, 0.002, 100, 1) for i in range(35)]
    high = [SliceFit(20 + i * 0.4, (0, 0), 0.5, 0.002, 100, 1) for i in range(20)]
    assert _coherent_sections(low + high, 0.4) == low
    other = [SliceFit(14 + i * 0.4, (3, 0), 0.5, 0.002, 100, 1) for i in range(20)]
    assert _coherent_sections(low + other, 0.4) == low


@pytest.mark.parametrize("partial", [False, True])
def test_coherent_sections_keep_a_real_step_in_the_shaft(partial):
    rng = np.random.default_rng(31)
    y = rng.uniform(0, 30, 30_000)
    a = rng.uniform(0, np.pi if partial else 2 * np.pi, len(y))
    r = np.where(y < 15, 0.8, 0.4) + rng.normal(0, 0.003, len(y))
    xyz = np.column_stack([r * np.sin(a), y, r * np.cos(a)])
    slices = fit_sections(xyz, Axis((0, 0, 0), (0, 1, 0), 0), 0.4)
    assert len([s for s in slices if s.y < 14]) > 25
    assert len([s for s in slices if s.y > 16]) > 25
    taper = fit_taper(slices)
    assert _shaft_height(xyz, Axis((0, 0, 0), (0, 1, 0), 0), taper, 0.4, "telecom-monopole") == pytest.approx(
        30, abs=0.4
    )


def _r_at(m, y):
    return float(np.interp(y, [p[0] for p in m.taper.profile], [p[1] for p in m.taper.profile]))


def _check_stack(m, truth, tol=0.03):
    assert m.axis.tilt_deg < 0.3
    assert abs(m.axis.point[0]) < 0.2 and abs(m.axis.point[2]) < 0.2
    for y in (5.0, 30.0, 60.0, 100.0):
        want = radius_at(truth["profile"], y)
        assert abs(_r_at(m, y) - want) / want < tol, y


def test_baseline_stack_with_ground():
    cloud, truth = stack_cloud(seed=7, noise=0.03)
    m = measure_shaft(cloud, centre=(0.0, 0.0))
    _check_stack(m, truth)
    assert m.base.observed and m.base.basis == "ground" and abs(m.base.point[1]) < 0.3
    assert not any("Excluded" in w for w in m.warnings) and m.isolation["dropped"] == []
    assert m.base.note is None


def test_a_neighbouring_tower_is_excluded_and_reported():
    stack, truth = stack_cloud(seed=7, noise=0.03)
    mono, _ = monopole_cloud(seed=2, ground=False)
    cloud = np.vstack([stack, mono + np.array([15.0, 0.0, 0.0])])
    m = measure_shaft(cloud, centre=(0.0, 0.0))
    _check_stack(m, truth)
    assert len(m.isolation["dropped"]) == 1
    d = m.isolation["dropped"][0]
    assert d["min"][0] > 12 and d["max"][0] < 18 and d["max"][1] > 25
    assert any("Excluded" in w and "other structure" in w for w in m.warnings)
    # the crop centre decides, not the size: centred on the neighbour it is the one kept
    other = measure_shaft(cloud, centre=(15.0, 0.0))
    assert other.kept[:, 0].min() > 12 and other.kept[:, 1].max() < 33


def test_clutter_does_not_move_axis_base_or_taper():
    stack, truth = stack_cloud(seed=7, noise=0.03)
    rng = np.random.default_rng(0)
    veg = np.column_stack(
        [rng.uniform(-15, 15, 20000), rng.uniform(0.2, 8, 20000), rng.uniform(-15, 15, 20000)]
    )
    # a parked vehicle: a 4.5 x 1.8 x 1.6 m box on the ground, 18 m from the asset
    n = 4000
    box = np.column_stack([rng.uniform(16, 20.5, n), rng.uniform(0.2, 1.8, n), rng.uniform(-0.9, 0.9, n)])
    birds = np.column_stack(
        [rng.uniform(-40, 40, 200), rng.uniform(150, 200, 200), rng.uniform(-40, 40, 200)]
    )
    outliers = np.column_stack(
        [rng.uniform(-20, 20, 1400), rng.uniform(0, 130, 1400), rng.uniform(-20, 20, 1400)]
    )
    m = measure_shaft(np.vstack([stack, veg, box, birds, outliers]), centre=(0.0, 0.0))
    _check_stack(m, truth, tol=0.04)
    assert abs(m.base.point[1]) < 0.5
    assert m.kept[:, 1].max() < 130  # the birds are not part of the asset
    assert any("Excluded" in w for w in m.warnings)


def test_a_scan_missing_its_bottom_keeps_heights_from_the_ground():
    cloud, truth = stack_cloud(seed=7, noise=0.03)
    wall = (np.hypot(cloud[:, 0], cloud[:, 2]) < 12) & (cloud[:, 1] < 20)
    m = measure_shaft(cloud[~wall], centre=(0.0, 0.0))
    assert m.base.basis == "ground" and not m.base.observed
    assert "not scanned" in m.base.note
    assert 19 < m.base.gap_m < 21.5 and abs(m.base.point[1]) < 0.4
    assert min(s.y for s in m.slices) > 18  # no section is invented below what was seen
    assert abs(_r_at(m, 30.0) - radius_at(truth["profile"], 30.0)) / 7.6 < 0.03
    assert abs(_r_at(m, 100.0) - 6.5) / 6.5 < 0.03
    assert any("not scanned" in w for w in m.warnings)


def test_no_ground_flags_the_base_and_says_what_heights_mean():
    cloud, truth = stack_cloud(seed=7, noise=0.03)
    m = measure_shaft(cloud[cloud[:, 1] > 20], centre=(0.0, 0.0))
    assert m.base.basis == "lowest-point" and not m.base.observed
    assert "lowest point seen" in m.base.note
    assert 20 < m.base.point[1] < 21
    assert min(s.y for s in m.slices) < 3  # heights count from the lowest point seen
    assert any("lowest point seen" in w for w in m.warnings)


def test_rejected_slices_are_reported():
    cloud, _ = stack_cloud(seed=3, noise=0.02)
    m = measure_shaft(cloud, centre=(0.0, 0.0))
    assert m.rejected["slices"] == len(m.slices)
    assert set(m.rejected["rejected"]) == {"no-fit", "radius-jump", "off-axis"}
    assert sum(m.rejected["rejected"].values()) > 0  # the flues above the crown are not the shaft
    assert any(w.startswith("Skipped") for w in m.warnings)


def test_pdal_arguments_apply_the_region_for_every_compressed_format():
    origin = (1000.0, 2000.0, 10.0)
    region = {"centre": [5.0, -3.0], "radiusM": 4.0}
    copc = pdal_translate_args("pdal", "a.copc.laz", "o.las", "copc", region, origin)
    assert copc[-1].startswith("--readers.copc.bounds=([1001.0,1009.0],[1999.0,2007.0])")
    laz = pdal_translate_args("pdal", "a.laz", "o.las", "laz", region, origin)
    assert laz[-2:] == ["crop", "--filters.crop.bounds=([1001.0,1009.0],[1999.0,2007.0])"]
    box = pdal_translate_args(
        "pdal", "a.laz", "o.las", "laz", {"min": [0.0, 1.0, -2.0], "max": [2.0, 5.0, 0.0]}, origin
    )
    assert box[-1] == "--filters.crop.bounds=([1000.0,1002.0],[2000.0,2002.0],[11.0,15.0])"
    assert pdal_translate_args("pdal", "a.laz", "o.las", "laz", None, origin) == [
        "pdal",
        "translate",
        "a.laz",
        "o.las",
        "--writers.las.forward=all",
    ]
    # the source header's scale and offset carry over, so no precision is lost on the way
    assert all("--writers.las.forward=all" in a for a in (copc, laz, box))
    assert region_centre(region) == (5.0, -3.0) and region_centre(None) is None
    assert region_centre({"min": [0, 0, 0], "max": [2, 1, 4]}) == (1.0, 2.0)
