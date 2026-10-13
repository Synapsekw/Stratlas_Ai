"""photo/budget.py: the point budget per preset, the site's area and the disk a run needs."""

from __future__ import annotations

import math

import numpy as np
import pytest
from shapely.geometry import box

from aio_pipelines.photo import budget as B


def _block(x0: float, x1: float, y0: float, y1: float, cell: float = 2.0) -> np.ndarray:
    """Two points in every 2 m cell of a rectangle."""
    gx, gy = np.meshgrid(np.arange(x0 + 0.5, x1, cell), np.arange(y0 + 0.5, y1, cell))
    pts = np.column_stack([gx.ravel(), gy.ravel()])
    return np.concatenate([pts, pts + 0.3])


def test_the_budgets_of_the_presets():
    assert B.BUDGET == {"fast": 0, "standard": 150_000_000, "high": 400_000_000}


def test_the_site_is_the_occupied_cells_dilated_by_two():
    xy = _block(0, 100, 0, 50)  # 50 x 25 cells of 2 m
    lone = np.column_stack([500.0 + 10 * np.arange(30), np.full(30, 500.0)])  # one point a cell
    area = B.site_area(np.concatenate([xy, lone]))
    assert area == pytest.approx((50 + 4) * (25 + 4) * 4.0)


def test_the_site_is_clipped_to_the_region():
    xy = _block(0, 100, 0, 50)
    assert B.site_area(xy, box(0, 0, 50, 50)) == pytest.approx(25 * 25 * 4.0)
    assert B.site_area(np.zeros((0, 2))) == 0.0


@pytest.mark.parametrize(
    "gsd, scale, area, budget, want",
    [
        (0.02, 0.5, 100_000.0, 150_000_000, 0.04),  # a small site: the matching GSD
        (0.02, 0.5, 1_000_000.0, 150_000_000, math.sqrt(1e6 / (0.9 * 150e6))),  # widened
        (0.02, 1.0, 100_000.0, 400_000_000, 0.02),  # High, a site within its budget
        (0.02, 0.0, 1_000_000.0, 0, 0.02),  # Fast: the sparse points at the photo GSD
    ],
)
def test_the_spacing_widens_only_over_the_budget(gsd, scale, area, budget, want):
    assert B.budget_voxel(gsd, scale, area, budget) == pytest.approx(want)


def test_a_merge_over_the_budget_is_done_again_wider():
    assert not B.needs_remerge(180_000_000, 150_000_000)
    assert B.needs_remerge(180_000_001, 150_000_000)
    assert not B.needs_remerge(10**12, 0)  # no budget, no re-merge
    assert B.remerge_voxel(0.04, 600_000_000, 150_000_000) == pytest.approx(0.08)


def test_the_disk_estimate_reserves_twice_the_copc_for_untwine():
    kw = dict(photos=1000, pixels=20_000_000, scale=0.5, area=1e6, gsd=0.02, ortho_res=0.02,
              dsm_res=0.04, voxel=0.1, budget=150_000_000, sparse_points=500_000)  # fmt: skip
    without = B.disk_need(**kw, cloud=False)
    with_cloud = B.disk_need(**kw, cloud=True)
    merged = 1e6 / 0.1**2  # 100 M points
    assert with_cloud - without == pytest.approx(merged * (36 + 15 * 3) * 1.3, rel=1e-6)
    fast = B.disk_need(**{**kw, "scale": 0.0, "voxel": 0.02, "budget": 0}, cloud=False)
    assert 0 < fast < without
