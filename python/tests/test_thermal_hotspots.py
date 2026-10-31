"""The hot-spot finder (``thermal/hotspots.py``) on synthetic temperature rasters (thermal plan task 3.3)."""

from __future__ import annotations

import numpy as np
import pytest

from aio_pipelines.thermal.hotspots import find_hotspots

H, W = 128, 160


def scene(bg=30.0, noise=0.3, seed=0):
    rng = np.random.default_rng(seed)
    return (bg + rng.normal(0, noise, (H, W))).astype(np.float32)


def patch(c, x, y, size=3, value=85.0):
    c[y : y + size, x : x + size] = value
    return c


def test_one_hot_patch_gives_one_candidate_with_its_delta():
    c = patch(scene(), 70, 60)
    found = find_hotspots(c, "delta", 4.0)
    assert len(found) == 1
    h = found[0]
    assert h.peak_c == pytest.approx(85.0)
    assert h.mean_c == pytest.approx(85.0)
    assert h.reference_c == pytest.approx(30.0, abs=0.1)
    assert h.delta_c == pytest.approx(55.0, abs=0.1)
    assert h.box == (70, 60, 3, 3)
    assert h.peak_at[0] in range(70, 73) and h.peak_at[1] in range(60, 63)


def test_close_patches_merge_and_far_ones_stay_apart():
    c = patch(patch(scene(), 40, 60), 47, 60)  # a 4 px gap
    assert len(find_hotspots(c, "delta", 4.0)) == 1
    c = patch(patch(scene(), 40, 60), 63, 60)  # a 20 px gap
    assert len(find_hotspots(c, "delta", 4.0)) == 2


def test_a_two_pixel_glint_is_dropped():
    c = scene()
    c[50, 50:52] = 90.0
    assert find_hotspots(c, "delta", 4.0) == []
    assert len(find_hotspots(c, "delta", 4.0, min_area_px=2)) == 1


def test_at_most_max_per_photo_by_delta():
    c = scene()
    k = 0
    for row in range(5):
        for col in range(6):
            patch(c, 8 + col * 25, 8 + row * 24, value=40.0 + k)
            k += 1
    found = find_hotspots(c, "delta", 4.0)
    assert len(found) == 20
    deltas = [h.delta_c for h in found]
    assert deltas == sorted(deltas, reverse=True)
    assert min(h.peak_c for h in found) == pytest.approx(50.0)  # the 10 coolest are left out


def test_a_patch_just_under_the_threshold_proposes_nothing():
    c = patch(scene(noise=0.05), 70, 60, size=5, value=33.0)
    assert find_hotspots(c, "delta", 4.0) == []
    assert len(find_hotspots(c, "delta", 2.5)) == 1


def test_cold_sky_does_not_make_the_ground_a_hot_spot():
    c = scene()
    c[:24, :] = -30.0
    assert find_hotspots(c, "delta", 4.0) == []
    # a hot spot right under the sky still reads against the ground
    patch(c, 70, 26, size=4)
    found = find_hotspots(c, "delta", 4.0)
    assert len(found) == 1
    assert found[0].reference_c == pytest.approx(30.0, abs=0.3)


def test_nan_pixels_are_ignored():
    c = patch(scene(), 70, 60)
    c[:, :10] = np.nan
    c[61, 71] = np.nan  # a hole in the patch itself
    found = find_hotspots(c, "delta", 4.0)
    assert len(found) == 1
    assert np.isfinite(found[0].mean_c) and found[0].peak_c == pytest.approx(85.0)
    assert find_hotspots(np.full((H, W), np.nan, np.float32), "delta", 4.0) == []


def test_absolute_rule_takes_pixels_above_a_temperature():
    c = patch(patch(scene(), 30, 30, value=50.0), 100, 80, value=85.0)
    found = find_hotspots(c, "absolute", 60.0)
    assert len(found) == 1 and found[0].peak_c == pytest.approx(85.0)
    assert found[0].delta_c == pytest.approx(55.0, abs=0.1)


def test_a_large_hot_object_is_found_whole():
    c = scene()
    c[40:100, 50:120] = 70.0  # a transformer filling a good part of the frame
    found = find_hotspots(c, "delta", 4.0)
    assert len(found) == 1
    x, y, w, h = found[0].box
    assert (x, y, w, h) == (50, 40, 70, 60)
    assert found[0].delta_c == pytest.approx(40.0, abs=0.3)
