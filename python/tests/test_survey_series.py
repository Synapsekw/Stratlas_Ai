"""Volume per survey date and the spread across bases (W3, W4): the Python core reproduces the shared
fixtures in ``packages/schema/src/__fixtures__/survey/series.json``; the TypeScript executor's
``series.parity.test.ts`` reads the same file (ADR 0009).
"""

from __future__ import annotations

import json

import pytest

from aio_pipelines.survey.series import (
    SPREAD_BASES,
    base_spread,
    compare_series,
    series_applies,
    spread_pct,
)
from survey_fixtures import NOW, OUT, at_resolver, series_cases

STORED = json.loads((OUT / "series.json").read_text("utf-8"))
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


def _same_result(got: dict, want: dict) -> None:
    for k in NUMBERS:
        assert got[k] == pytest.approx(want[k], rel=1e-9, abs=1e-9), k
    rest = {k: v for k, v in want.items() if k not in NUMBERS}
    assert {k: got.get(k) for k in rest} == rest
    assert set(got) == set(want)


def test_the_stored_cases_are_what_the_generator_makes():
    fresh = json.loads(json.dumps(series_cases()))
    for kind in ("series", "spread", "formula"):
        assert [c["id"] for c in fresh[kind]] == [c["id"] for c in STORED[kind]]
        for a, b in zip(fresh[kind], STORED[kind], strict=True):
            assert {k: v for k, v in b.items() if k != "expected"} == a


def test_there_are_enough_cases_of_each_kind():
    series = STORED["series"]
    assert len(series) >= 8
    assert len(STORED["spread"]) >= 4
    lengths = {len(c["dates"]) for c in series}
    assert {2, 3} <= lengths
    statuses = {r["status"] for c in series for r in c["expected"]}
    assert statuses == {"ok", "partial", "refused"}
    assert any("design" in (c["item"]["from"]["kind"], c["item"]["to"]["kind"]) for c in series)
    spreads = [c["expected"] for c in STORED["spread"]]
    assert any(s is None for s in spreads) and any(s is not None and s["pct"] > 0 for s in spreads)


@pytest.mark.parametrize("case", STORED["series"], ids=[c["id"] for c in STORED["series"]])
def test_every_row_carries_its_viewing_date(case):
    assert series_applies(case["item"])
    for d, r in zip(case["dates"], case["expected"], strict=True):
        assert d["capture"] in (r.get("toCapture"), r.get("fromCapture"))


@pytest.mark.parametrize("case", STORED["formula"], ids=[c["id"] for c in STORED["formula"]])
def test_spread_pct_reproduces_each_formula_case(case):
    got = spread_pct(case["totals"])
    if case["expected"] is None:
        assert got is None
    else:
        assert got == pytest.approx(case["expected"], rel=1e-12)


def test_spread_pct_by_hand():
    assert spread_pct([120.0]) is None
    assert spread_pct([100.0, 200.0, 300.0]) == 50.0
    assert spread_pct([0.0, 1e-7]) is None


@pytest.mark.parametrize("case", STORED["series"], ids=[c["id"] for c in STORED["series"]])
def test_compare_series_reproduces_each_case(case):
    got = compare_series(
        case["ring"],
        case["item"],
        lambda c: at_resolver(SURFACES, case["dates"], c),
        [d["capture"] for d in case["dates"]],
        case.get("site"),
        now=NOW,
    )
    assert len(got) == len(case["expected"])
    for g, w in zip(got, case["expected"], strict=True):
        assert g["engine"] == "py"
        g = {k: v for k, v in g.items() if k not in ("engine", "computedAt")}
        _same_result(g, w)


@pytest.mark.parametrize("case", STORED["spread"], ids=[c["id"] for c in STORED["spread"]])
def test_base_spread_reproduces_each_case(case):
    got = base_spread(
        case["ring"],
        case["item"],
        at_resolver(SURFACES, case["dates"], case["at"]),
        case.get("site"),
        now=NOW,
    )
    want = case["expected"]
    if want is None:
        assert got is None
        return
    assert got is not None
    assert got["pct"] == pytest.approx(want["pct"], rel=1e-9, abs=1e-12)
    assert [n["base"] for n in got["nets"]] == [n["base"] for n in want["nets"]]
    for g, w in zip(got["nets"], want["nets"], strict=True):
        assert g["netM3"] == pytest.approx(w["netM3"], rel=1e-9, abs=1e-9)


def test_each_date_is_the_current_side_and_previous_follows_it():
    case = next(c for c in STORED["series"] if c["id"] == "previous-current-three-dates")
    caps = [d["capture"] for d in case["dates"]]
    got = compare_series(
        case["ring"], case["item"], lambda c: at_resolver(SURFACES, case["dates"], c), caps, now=NOW
    )
    assert [r["toCapture"] for r in got] == caps
    assert got[0]["status"] == "refused"
    assert got[0]["reason"] == "There is no previous survey with a prepared surface."
    assert [r.get("fromCapture") for r in got[1:]] == caps[:-1]


def test_series_applies_only_to_items_with_a_current_side():
    sv = {"kind": "survey", "surface": "a", "capture": "c1"}
    design = {"kind": "design", "design": "d", "layer": "l"}
    assert series_applies({"from": {"kind": "smart"}, "to": {"kind": "current"}})
    assert series_applies({"from": {"kind": "previous"}, "to": {"kind": "current"}})
    # a previous side alone: its rows would not carry the viewing date
    assert not series_applies({"from": {"kind": "previous"}, "to": design})
    assert not series_applies({"from": sv, "to": design})


def test_spread_bases_and_formula():
    assert [b["kind"] for b in SPREAD_BASES] == ["smart", "fit-plane", "perimeter-mean", "reference"]
    assert SPREAD_BASES[3]["mode"] == "perimeter-min"
    case = next(c for c in STORED["spread"] if c["expected"] is not None and c["expected"]["pct"] > 0)
    s = base_spread(case["ring"], case["item"], at_resolver(SURFACES, case["dates"], case["at"]), now=NOW)
    assert s is not None
    # (max - min) / 2 / mean of the total volumes, in percent: rebuilt from the per-base results
    from aio_pipelines.survey.compare import compare_item

    totals = [
        r["totalM3"]
        for r in (
            compare_item(
                case["ring"],
                {**case["item"], "from": b},
                at_resolver(SURFACES, case["dates"], case["at"]),
                now=NOW,
            )
            for b in SPREAD_BASES
        )
        if r["status"] in ("ok", "partial")
    ]
    mean = sum(totals) / len(totals)
    assert s["pct"] == pytest.approx((max(totals) - min(totals)) / 2 / mean * 100, rel=1e-12)


def test_spread_is_none_for_a_surface_to_surface_item():
    case = STORED["spread"][0]
    item = {**case["item"], "from": {"kind": "survey", "surface": "flat"}}
    assert base_spread(case["ring"], item, at_resolver(SURFACES, case["dates"], case["at"]), now=NOW) is None
