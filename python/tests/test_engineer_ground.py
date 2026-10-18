import numpy as np
import pytest

from aio_pipelines.engineer.axis import Axis
from aio_pipelines.engineer.cloud import GroundSplit, find_base


def test_compound_radius_and_low_outlier_do_not_hide_local_ground():
    rng = np.random.default_rng(21)
    theta = rng.uniform(0, 2 * np.pi, 3000)
    radius = rng.uniform(1.2, 3.0, 3000)
    ground = np.c_[radius * np.cos(theta), rng.normal(1.24, 0.008, 3000), radius * np.sin(theta)]
    # Connected fencing extends beyond the ground crop; an isolated low return is not the datum.
    clutter = np.c_[6 * np.cos(theta), rng.uniform(0.95, 3, 3000), 6 * np.sin(theta)]
    shaft = np.c_[0.4 * np.cos(theta), rng.uniform(2, 28, 3000), 0.4 * np.sin(theta)]
    kept = np.r_[clutter, shaft]
    axis = Axis((0, 0.95, 0), (0, 1, 0), 0)
    base, moved = find_base(axis, kept, GroundSplit(kept, ground, lambda xz: np.full(len(xz), 0.98)))
    assert base.observed
    assert base.basis == "ground"
    assert moved.point[1] == pytest.approx(1.24, abs=0.02)


def test_local_sloping_ground_keeps_axis_intersection():
    rng = np.random.default_rng(22)
    theta = rng.uniform(0, 2 * np.pi, 5000)
    radius = rng.uniform(1.3, 3, 5000)
    x, z = radius * np.cos(theta), radius * np.sin(theta)
    ground = np.c_[x, 4 + 0.1 * x + 0.05 * z + rng.normal(0, 0.005, len(x)), z]
    shaft = np.c_[0.4 * np.cos(theta), rng.uniform(4.2, 20, len(x)), 0.4 * np.sin(theta)]
    base, _ = find_base(
        Axis((0, 4.2, 0), (0, 1, 0), 0), shaft, GroundSplit(shaft, ground, lambda xz: np.full(len(xz), 4))
    )
    assert base.point[1] == pytest.approx(4, abs=0.02)
