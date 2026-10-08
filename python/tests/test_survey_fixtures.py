"""The Python core still reproduces the shared engine fixtures (packages/schema/src/__fixtures__/survey).

The TypeScript executor's parity test reads the same files; regenerate them with
``uv run python tests/survey_fixtures.py`` when the specification changes (and say why).
"""

from __future__ import annotations

import json

import numpy as np
import pytest

from aio_pipelines.survey.grid import decode_tile
from survey_fixtures import OUT, cases, resolved, run_case, surfaces

STORED = json.loads((OUT / "cases.json").read_text("utf-8"))["cases"]
SURFACES = json.loads((OUT / "surfaces.json").read_text("utf-8"))
NUMBERS = (
    "cutM3",
    "fillM3",
    "netM3",
    "totalM3",
    "areaM2",
    "areaCutM2",
    "areaFillM2",
    "areaUnchangedM2",
    "uncoveredM2",
    "deadbandM",
    "cellM",
)


def test_the_stored_surfaces_and_cases_are_what_the_generator_makes():
    assert json.loads(json.dumps(surfaces())) == SURFACES
    fresh = cases()
    assert [c["id"] for c in fresh] == [c["id"] for c in STORED]
    for a, b in zip(fresh, STORED, strict=True):
        assert {k: v for k, v in b.items() if k != "expected"} == json.loads(json.dumps(a))


@pytest.mark.parametrize("case", STORED, ids=[c["id"] for c in STORED])
def test_the_core_reproduces_each_case(case):
    got = run_case(SURFACES, case)
    want = case["expected"]
    for k in NUMBERS:
        assert got[k] == pytest.approx(want[k], rel=1e-9, abs=1e-9), k
    rest = {k: v for k, v in want.items() if k not in NUMBERS}
    assert {k: got.get(k) for k in rest} == rest
    assert set(got) == set(want)


def test_every_status_and_path_is_covered():
    statuses = {c["expected"]["status"] for c in STORED}
    assert statuses == {"ok", "partial", "refused"}
    assert any(c["expected"]["cellM"] == 0 and c["expected"]["status"] == "ok" for c in STORED)
    assert any(c["expected"]["cellM"] > 0 for c in STORED)


def test_the_prepared_cone_tile_holds_the_fixture_heights():
    tile = decode_tile((OUT / "tiles" / "cone" / "0" / "0_0.bin").read_bytes())
    cone = resolved(SURFACES["cone"])
    assert cone.grid is not None
    h = cone.grid.read(0, 0, 40, 40)
    assert np.array_equal(tile[:40, :40], h)
    assert np.isnan(tile[40:, :]).all() and np.isnan(tile[:, 40:]).all()
