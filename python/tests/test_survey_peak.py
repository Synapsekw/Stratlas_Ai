"""Peak height (``peakM``): the surface's greatest height above its base inside the polygon.

The same cases as ``packages/survey/src/engine/peak.test.ts`` (the two engines must agree).
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from aio_pipelines.survey.compare import compare_item
from survey_fixtures import E0, N0, grid, resolved, tin

CX = CY = 10.25  # on a cell centre of a 0.5 m grid
H = 4.0


def cone_grid():
    return resolved(
        grid(
            "Cone",
            "fp-cone",
            0.5,
            41,
            41,
            lambda X, Y: 100.0 + np.clip(H * (1 - np.hypot(X - CX, Y - CY) / 7.0), 0, None),
        )
    )


def pyramid():
    v = [[0, 0, 100.0], [20, 0, 100.0], [20, 20, 100.0], [0, 20, 100.0], [10, 10, 103.0]]
    return resolved(tin("Pyramid", "fp-pyramid", v, [[0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]]))


def circle(cx, cy, r, n=48):
    return [
        [E0 + cx + r * math.cos(2 * math.pi * k / n), N0 + cy + r * math.sin(2 * math.pi * k / n)]
        for k in range(n)
    ]


SURVEY = {"kind": "survey", "surface": "s"}


def level(z):
    return {"kind": "reference", "mode": "level", "levelM": z}


def run(ring, frm, to, surface):
    item = {"id": "a", "from": frm, "to": to, "useDeadband": False}
    return compare_item(ring, item, lambda ref: surface)


def test_cone_height_above_a_level_base():
    r = run(circle(CX, CY, 8), level(100.0), SURVEY, cone_grid())
    assert r["status"] == "ok"
    assert r["peakM"] == pytest.approx(H, abs=1e-9)


def test_measured_above_the_base_the_volume_uses():
    assert run(circle(CX, CY, 8), level(101.0), SURVEY, cone_grid())["peakM"] == pytest.approx(H - 1)


def test_base_on_the_to_side():
    assert run(circle(CX, CY, 8), SURVEY, level(100.0), cone_grid())["peakM"] == pytest.approx(H)


def test_zero_when_the_surface_is_below_its_base():
    assert run(circle(CX, CY, 8), level(110.0), SURVEY, cone_grid())["peakM"] == 0.0


def test_pyramid_on_the_exact_path():
    r = run(circle(10, 10, 9), level(100.0), SURVEY, pyramid())
    assert r["cellM"] == 0.0
    assert r["peakM"] == pytest.approx(3.0, abs=1e-9)


def test_absent_between_surfaces_and_when_refused():
    assert "peakM" not in run(circle(CX, CY, 8), SURVEY, SURVEY, cone_grid())
    out = run(circle(CX + 60, CY, 8), level(100.0), SURVEY, cone_grid())
    assert out["status"] == "refused"
    assert "peakM" not in out
