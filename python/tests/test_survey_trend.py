"""Volume rate and forecast (intelligence review I2): the Python twin reproduces the shared
fixture ``packages/schema/src/__fixtures__/survey/trend.json``; the TypeScript executor's
``trend.parity.test.ts`` reads the same file (ADR 0009).
"""

from __future__ import annotations

import json

import pytest

from aio_pipelines.survey.trend import volume_trend
from survey_fixtures import OUT

CASES = json.loads((OUT / "trend.json").read_text("utf-8"))["cases"]


def test_has_the_cases() -> None:
    assert len(CASES) >= 8


@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
def test_trend_matches_the_fixture(case: dict) -> None:
    got = volume_trend(case["points"])
    want = case["expected"]
    assert sorted(got) == sorted(want)
    for k, v in want.items():
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            assert isinstance(got[k], (int, float)), k
            assert got[k] == pytest.approx(v, rel=1e-9, abs=1e-9), k
        else:
            assert got[k] == v, k


def test_two_dates_give_the_plain_rate_and_no_forecast() -> None:
    got = volume_trend(
        [
            {"capture": "a", "date": "2026-01-01", "valueM3": 100.0},
            {"capture": "b", "date": "2026-01-11", "valueM3": 80.0},
        ]
    )
    assert got["status"] == "not-enough-dates"
    assert got["rateM3PerDay"] == pytest.approx(-2)
    assert got["daysToEmpty"] is None
