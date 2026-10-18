import numpy as np
import pytest

from aio_pipelines.engineer.axis import Axis
from aio_pipelines.engineer.finial import fit_finial
from aio_pipelines.engineer.pipeline import _shaft_height
from aio_pipelines.engineer.sections import Taper


def test_cables_and_partial_crown_returns_cannot_extend_a_mast_wall():
    rng = np.random.default_rng(1)
    theta = rng.uniform(0, 2 * np.pi, 25000)
    height = rng.uniform(0, 29.6, len(theta))
    shaft = np.c_[0.26 * np.cos(theta), height, 0.26 * np.sin(theta)]
    cables = np.c_[np.full(1000, 0.26), rng.uniform(29.6, 31, 1000), np.zeros(1000)]
    measured = _shaft_height(
        np.r_[shaft, cables],
        Axis((0, 0, 0), (0, 1, 0), 0),
        Taper([(0, 0.26), (30.6, 0.26)], 0.001),
        0.4,
        "telecom-monopole",
    )
    assert measured == pytest.approx(29.6, abs=0.1)


def test_terminal_rod_preserves_its_measured_tip_and_lean():
    rng = np.random.default_rng(9)
    h = rng.uniform(30.5, 32.4, 1800)
    theta = rng.uniform(0, 2 * np.pi, len(h))
    rod = np.c_[0.15 + 0.015 * h + 0.01 * np.cos(theta), h, -0.12 + 0.01 * np.sin(theta)]
    base = np.array([[0, 0, 0], [1, 29, 1]])
    (item,) = fit_finial(np.r_[rod, base], [{"kind": "cloud", "ref": "scan"}])
    assert item["path"][-1][1] == pytest.approx(32.4, abs=0.03)
    assert item["path"][0][0] < item["path"][-1][0]
    assert item["size"][0] == pytest.approx(0.02, abs=0.01)


def test_sparse_bands_and_nearby_crown_do_not_leave_a_floating_terminal_rod():
    rng = np.random.default_rng(22)
    heights = np.arange(29.65, 32.4, 0.025)
    rod = np.c_[
        0.02 * (heights - 30) + rng.normal(0, 0.008, len(heights)),
        heights,
        rng.normal(0, 0.008, len(heights)),
    ]
    crown = np.c_[rng.uniform(0.18, 0.45, 1000), rng.uniform(29.6, 30.5, 1000), rng.uniform(-0.4, 0.4, 1000)]
    (item,) = fit_finial(np.r_[rod, crown, [[0, 0, 0]]], [{"kind": "cloud", "ref": "scan"}])
    assert item["path"][0][1] < 29.8
    assert item["path"][-1][1] > 32.3
    assert max(abs(p[0]) for p in item["path"]) < 0.1
