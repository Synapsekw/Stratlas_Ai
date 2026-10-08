"""survey.compare (M11 G2): the reference core's quality targets and the pipeline.

The core is held to analytic truth (M11 plan, "Quality targets"); the same targets are asserted in
the TypeScript executor (``packages/survey/src/engine/quality.test.ts``), and the two agree on the
shared fixtures (``test_survey_fixtures.py``, ``parity.test.ts``). Synthetic surfaces only.
"""

from __future__ import annotations

import json
import math

import numpy as np
import pytest

from aio_pipelines.pipelines import all_pipelines
from aio_pipelines.runtime import JobError
from aio_pipelines.survey.compare import Resolved, canonical, compare_item
from aio_pipelines.survey.grid import ArraySurface, Window, coverage
from aio_pipelines.survey.tin import delaunay
from conftest import run_job
from imagery_synth import ORIGIN, surface_project

E0, N0 = 302000.0, 2574000.0
EXTENT = 30.0


def grid(cell, fn, name="g"):
    n = round(EXTENT / cell)
    c = (np.arange(n) + 0.5) * cell
    X, Y = np.meshgrid(c, c)
    return Resolved(
        kind="grid", name=name, fingerprint=f"fp-{name}", grid=ArraySurface(E0, N0, cell, fn(X, Y))
    )


def r(X, Y):
    return np.hypot(X - 15, Y - 15)


SHAPES = {
    "cone": (lambda X, Y: 100 + np.clip(5 * (1 - r(X, Y) / 10), 0, None), math.pi * 100 * 5 / 3),
    "frustum": (lambda X, Y: 100 + np.clip(4 * (10 - r(X, Y)) / 6, 0, 4), math.pi * 4 / 3 * (100 + 40 + 16)),
    "paraboloid": (lambda X, Y: 100 + np.clip(6 * (1 - r(X, Y) ** 2 / 100), 0, None), math.pi * 100 * 6 / 2),
    # walls on cell edges at both cells (a grid samples cell centres)
    "prism": (lambda X, Y: np.where((X > 4.8) & (X < 24.8) & (Y > 8) & (Y < 20), 103.0, 100.0), 20 * 12 * 3),
    "wedge": (
        lambda X, Y: np.where((X > 4.8) & (X < 24.8) & (Y > 8) & (Y < 22), 100 + 4 * (X - 4.8) / 20, 100.0),
        20 * 14 * 4 / 2,
    ),
}
SQUARE = [[E0 + 2, N0 + 2], [E0 + 28, N0 + 2], [E0 + 28, N0 + 28], [E0 + 2, N0 + 28]]


def sv(sid):
    return {"kind": "survey", "surface": sid}


def item(frm, to, **kw):
    return {"id": "q", "from": frm, "to": to, "useDeadband": kw.pop("useDeadband", False), **kw}


def resolver(m):
    return lambda ref: m[ref["surface"] if ref["kind"] == "survey" else ref["kind"]]


@pytest.mark.parametrize("name", sorted(SHAPES))
@pytest.mark.parametrize("cell, tol", [(20 / 50, 0.005), (20 / 200, 0.001)])
def test_grid_volumes_of_analytic_shapes(name, cell, tol):
    fn, volume = SHAPES[name]
    res = resolver({"base": grid(cell, lambda X, Y: 100 + 0 * X, "flat"), "shape": grid(cell, fn, name)})
    v = compare_item(SQUARE, item(sv("base"), sv("shape")), res)
    assert v["status"] == "ok" and v["engine"] == "py"
    assert abs(v["fillM3"] - volume) / volume < tol
    assert v["cutM3"] == 0
    lv = compare_item(SQUARE, item({"kind": "reference", "mode": "level", "levelM": 100}, sv("shape")), res)
    assert lv["fillM3"] == pytest.approx(v["fillM3"], rel=1e-12)
    for base in (
        {"kind": "smart"},
        {"kind": "fit-plane"},
        {"kind": "perimeter-mean"},
        {"kind": "reference", "mode": "perimeter-min"},
    ):
        b = compare_item(SQUARE, item(base, sv("shape")), res)
        assert abs(b["fillM3"] - volume) / volume < tol, base


def pad(offset=0.0):
    v = []
    for s, z in ((3.0, 102.0), (6.0, 100.0)):
        v += [
            [E0 + 10 - s, N0 + 10 - s, z],
            [E0 + 10 + s, N0 + 10 - s, z],
            [E0 + 10 + s, N0 + 10 + s, z],
            [E0 + 10 - s, N0 + 10 + s, z],
        ]
    t = [[0, 1, 2], [0, 2, 3]]
    for k in range(4):
        a, b = k, (k + 1) % 4
        t += [[4 + a, 4 + b, b], [4 + a, b, a]]
    return Resolved(
        kind="tin",
        name="Pad",
        fingerprint=f"fp-pad{offset}",
        vertices=np.array(v),
        triangles=np.array(t),
        offset=offset,
    )


BOX = [[E0 + 4, N0 + 4], [E0 + 16, N0 + 4], [E0 + 16, N0 + 16], [E0 + 4, N0 + 16]]


def design_resolver(ref):
    return pad(-0.3) if ref.get("layer") == "sub" else pad(0.0)


def test_tin_to_a_level_is_exact():
    v = compare_item(
        BOX,
        item(
            {"kind": "reference", "mode": "level", "levelM": 100},
            {"kind": "design", "design": "d", "layer": "top"},
        ),
        design_resolver,
    )
    truth = 2 / 3 * (36 + 6 * 12 + 144)
    assert v["cellM"] == 0
    assert abs(v["fillM3"] - truth) / truth < 1e-9
    assert v["areaFillM2"] == pytest.approx(144, rel=1e-12)


def test_two_offset_designs_differ_by_area_times_offset():
    v = compare_item(
        BOX,
        item(
            {"kind": "design", "design": "d", "layer": "sub"},
            {"kind": "design", "design": "d", "layer": "top"},
        ),
        design_resolver,
    )
    assert abs(v["fillM3"] - 144 * 0.3) / (144 * 0.3) < 1e-9
    assert v["cutM3"] == 0
    assert v["fromLabel"] == "Pad (offset -0.300 m)" and v["toLabel"] == "Pad"


def test_a_tin_deadband_counts_only_the_parts_beyond_it():
    # 0.3 m everywhere, a deadband of 0.5 m: nothing counts; of 0.2 m: everything
    on = compare_item(
        BOX,
        item(
            {"kind": "design", "design": "d", "layer": "sub"},
            {"kind": "design", "design": "d", "layer": "top"},
            deadbandM=0.5,
            useDeadband=True,
        ),
        design_resolver,
    )
    assert on["fillM3"] == 0 and on["areaUnchangedM2"] == pytest.approx(144, rel=1e-12)
    low = compare_item(
        BOX,
        item(
            {"kind": "design", "design": "d", "layer": "sub"},
            {"kind": "design", "design": "d", "layer": "top"},
            deadbandM=0.2,
            useDeadband=True,
        ),
        design_resolver,
    )
    assert low["fillM3"] == pytest.approx(144 * 0.3, rel=1e-9)


def test_areas_split_the_polygon_and_the_polygon_area_is_exact():
    fn, _ = SHAPES["cone"]
    res = resolver({"base": grid(0.1, lambda X, Y: 100 + 0 * X), "shape": grid(0.1, fn)})
    ring = [
        [E0 + 15 + 12 * math.cos(2 * math.pi * k / 7), N0 + 15 + 12 * math.sin(2 * math.pi * k / 7)]
        for k in range(7)
    ]
    local = [(p[0] - E0, p[1] - N0) for p in ring]
    a = (
        abs(sum(local[k][0] * local[(k + 1) % 7][1] - local[(k + 1) % 7][0] * local[k][1] for k in range(7)))
        / 2
    )
    v = compare_item(ring, item(sv("base"), sv("shape")), res)
    assert abs(v["areaM2"] - a) / a < 1e-9
    parts = v["areaFillM2"] + v["areaCutM2"] + v["areaUnchangedM2"] + v["uncoveredM2"]
    assert abs(parts - v["areaM2"]) / v["areaM2"] < 1e-9
    assert abs(v["areaFillM2"] - math.pi * 100) / (math.pi * 100) < 0.01


def test_coverage_weights_are_exact_shares_of_each_cell():
    ring = [(0.25, 0.1), (2.6, 0.35), (1.7, 2.45), (0.3, 1.9)]
    w = coverage(ring, Window(0.5, 0, 0, 6, 5))
    a = abs(sum(ring[k][0] * ring[(k + 1) % 4][1] - ring[(k + 1) % 4][0] * ring[k][1] for k in range(4))) / 2
    assert w.sum() * 0.25 == pytest.approx(a, rel=1e-12)
    assert ((w > 0) & (w < 1)).any() and w.max() == 1 and w.min() == 0


def test_noise_below_the_deadband_gives_exactly_zero():
    rng = np.random.default_rng(7)
    noisy = grid(0.2, lambda X, Y: 100 + rng.uniform(-0.02, 0.02, X.shape), "noise")
    res = resolver({"base": grid(0.2, lambda X, Y: 100 + 0 * X), "shape": noisy})
    on = compare_item(SQUARE, item(sv("base"), sv("shape"), deadbandM=0.05, useDeadband=True), res)
    assert on["fillM3"] == 0 and on["cutM3"] == 0 and on["usedDeadband"] is True
    off = compare_item(SQUARE, item(sv("base"), sv("shape"), deadbandM=0.05, useDeadband=False), res)
    assert (
        off["fillM3"] > 0 and off["cutM3"] > 0 and off["usedDeadband"] is False and off["deadbandM"] == 0.05
    )


def test_a_polygon_outside_the_survey_is_partial_then_refused():
    res = resolver({"base": grid(0.2, lambda X, Y: 100 + 0 * X), "shape": grid(0.2, SHAPES["cone"][0])})

    def box(x0, x1):
        return [[E0 + x0, N0 + 5], [E0 + x1, N0 + 5], [E0 + x1, N0 + 25], [E0 + x0, N0 + 25]]

    half = compare_item(box(20, 40), item(sv("base"), sv("shape")), res)
    assert half["status"] == "refused" and half["reason"] == "50% outside the survey"
    assert half["uncoveredM2"] == pytest.approx(200) and half["fillM3"] == 0
    tenth = compare_item(box(12, 32), item(sv("base"), sv("shape")), res)
    assert tenth["status"] == "partial" and tenth["reason"] == "10% outside the survey"
    assert tenth["uncoveredM2"] == pytest.approx(40) and tenth["fillM3"] > 0
    assert compare_item(box(14, 34.2), item(sv("base"), sv("shape")), res)["status"] == "refused"
    assert compare_item(box(10, 30.2), item(sv("base"), sv("shape")), res)["status"] == "ok"


def test_a_base_on_both_sides_and_bad_polygons_are_refused():
    res = resolver({"base": grid(0.5, lambda X, Y: 100 + 0 * X)})
    both = compare_item(SQUARE, item({"kind": "smart"}, {"kind": "fit-plane"}), res)
    assert both["status"] == "refused" and "a base is sampled on the other side" in both["reason"]
    line = compare_item(SQUARE[:2], item({"kind": "smart"}, sv("base")), res)
    assert line["reason"] == "The polygon needs three or more points."
    bow = [[E0 + 2, N0 + 2], [E0 + 18, N0 + 18], [E0 + 18, N0 + 2], [E0 + 2, N0 + 18]]
    assert (
        compare_item(bow, item({"kind": "smart"}, sv("base")), res)["reason"] == "The polygon crosses itself."
    )
    missing = compare_item(
        SQUARE,
        item({"kind": "smart"}, sv("nope")),
        lambda ref: (_ for _ in ()).throw(JobError("The surface is gone.")),
    )
    assert missing["status"] == "refused" and missing["reason"] == "The surface is gone."


def test_the_fingerprint_changes_with_every_input():
    res = resolver({"base": grid(0.5, lambda X, Y: 100 + 0 * X), "shape": grid(0.5, SHAPES["cone"][0])})
    a = compare_item(SQUARE, item(sv("base"), sv("shape")), res)["fingerprint"]
    assert compare_item(SQUARE, item(sv("base"), sv("shape")), res)["fingerprint"] == a
    others = [
        compare_item(SQUARE, item(sv("base"), sv("shape"), deadbandM=0.1), res),
        compare_item(SQUARE, item(sv("base"), sv("shape"), useDeadband=True), res),
        compare_item(SQUARE, item(sv("base"), sv("shape"), cellM=1.0), res),
        compare_item([*SQUARE[:3], [E0 + 3, N0 + 28]], item(sv("base"), sv("shape")), res),
        compare_item(SQUARE, item(sv("base"), sv("shape")), res, site={"verticalDatum": {"kind": "project"}}),
        compare_item(SQUARE, item({"kind": "smart"}, sv("shape")), res),
    ]
    fps = {o["fingerprint"] for o in others}
    assert a not in fps and len(fps) == len(others)


def test_canonical_json_is_what_the_typescript_executor_writes():
    assert (
        canonical({"b": 1.0, "a": [0.1, -0.0, 1e-7, 1.5e21, "x\n"]})
        == '{"a":[1e-1,0,1e-7,1.5e+21,"x\\n"],"b":1}'
    )


def test_the_shared_delaunay_triangulates_cocircular_points():
    xs = [0, 1, 2, 2, 2, 1, 0, 0]
    ys = [0, 0, 0, 1, 2, 2, 2, 1]
    t = delaunay(xs, ys)
    area = sum(
        abs((xs[b] - xs[a]) * (ys[c] - ys[a]) - (xs[c] - xs[a]) * (ys[b] - ys[a])) / 2 for a, b, c in t
    )
    assert area == pytest.approx(4.0) and len(t) == 6


# -------------------------------------------------------------------------------------- pipeline


def pipeline():
    return all_pipelines()["survey.compare"]


def prepared(project):
    surface_project(project, pile=1000.0, pit=300.0)
    params = {
        "surfaces": [
            {"id": "dsm-c1", "name": "DSM 1", "source": {"kind": "dsm", "layer": "surf-a"}, "capture": "c1"},
            {"id": "dsm-c2", "name": "DSM 2", "source": {"kind": "dsm", "layer": "surf-b"}, "capture": "c2"},
        ]
    }
    run_job(all_pipelines()["survey.prepare"], project, params, job_id="prep")


def around(e, n, rad, k=48):
    return [
        [e + rad * math.cos(2 * math.pi * i / k), n + rad * math.sin(2 * math.pi * i / k)] for i in range(k)
    ]


PILE = around(ORIGIN[0] - 10, ORIGIN[1] + 8, 14)
PIT = around(ORIGIN[0] + 14, ORIGIN[1] - 12, 11)


def test_items_of_many_measurements_are_computed_into_one_file(tmp_path):
    prepared(tmp_path)
    cur = {"kind": "current"}
    items = [
        {
            "measurement": "pile",
            "ring": PILE,
            "item": {
                "id": "a",
                "from": {"kind": "previous"},
                "to": cur,
                "deadbandM": 0.05,
                "useDeadband": True,
            },
        },
        {
            "measurement": "pile",
            "ring": PILE,
            "item": {"id": "b", "from": {"kind": "smart"}, "to": cur, "useDeadband": False},
        },
        {
            "measurement": "pit",
            "ring": PIT,
            "item": {
                "id": "c",
                "from": {"kind": "survey", "surface": "dsm-c1"},
                "to": {"kind": "survey", "surface": "dsm-c2"},
                "deadbandM": 0.05,
                "useDeadband": True,
            },
            "capture": "c2",
        },
        {
            "measurement": "old",
            "ring": PILE,
            "item": {"id": "d", "from": {"kind": "previous"}, "to": cur, "useDeadband": False},
            "capture": "c1",
        },
    ]
    result, _ = run_job(pipeline(), tmp_path, {"items": items})
    out = result["outputs"]["commit"]
    assert out["out"] == "survey/compare/j1.json" and out["items"] == 4
    doc = json.loads((tmp_path / out["out"]).read_text("utf-8"))
    rs = {(x["measurement"], x["result"]["item"]): x["result"] for x in doc["results"]}
    a = rs[("pile", "a")]
    assert a["fillM3"] == pytest.approx(1000, rel=0.01) and a["cutM3"] < 1
    assert a["fromCapture"] == "c1" and a["toCapture"] == "c2"
    assert a["fromLabel"] == "Previous survey (DSM 1)" and a["toLabel"] == "Current survey (DSM 2)"
    assert a["engine"] == "py" and a["cellM"] == pytest.approx(0.1)
    assert rs[("pile", "b")]["fillM3"] == pytest.approx(1000, rel=0.02)
    assert rs[("pit", "c")]["cutM3"] == pytest.approx(300, rel=0.02)
    # viewed on the first survey there is no previous one
    old = rs[("old", "d")]
    assert (
        old["status"] == "refused" and old["reason"] == "There is no previous survey with a prepared surface."
    )


def test_a_whole_site_comparison_writes_the_difference_heat_map_and_contours(tmp_path):
    prepared(tmp_path)
    params = {"site": {"from": {"kind": "previous"}, "to": {"kind": "current"}, "deadbandM": 0.05}}
    result, _ = run_job(pipeline(), tmp_path, params)
    out = tmp_path / result["outputs"]["commit"]["out"]
    assert result["outputs"]["commit"]["out"] == "survey/compare/j1"
    res = json.loads((out / "result.json").read_text("utf-8"))["result"]
    assert res["fillM3"] == pytest.approx(1000, rel=0.02) and res["cutM3"] == pytest.approx(300, rel=0.02)
    assert res["areaM2"] == pytest.approx(3600, rel=1e-6) and res["status"] == "ok"
    grid_meta = json.loads((out / "difference.json").read_text("utf-8"))
    assert grid_meta["schema"] == "aio.grid/1" and grid_meta["kind"] == "difference"
    from PIL import Image

    png = np.array(Image.open(out / "difference.png"))
    assert png.shape == (grid_meta["height"], grid_meta["width"])
    dz = grid_meta["offset"] + png.astype(np.float64) * grid_meta["scale"]
    assert float(dz[png > 0].max()) == pytest.approx(6.0, abs=0.1)
    heat = json.loads((out / "heat" / "tiles.json").read_text("utf-8"))
    assert heat["schema"] == "aio.tiles/1" and heat["levels"]
    contours = json.loads((out / "contours.geojson").read_text("utf-8"))
    levels = {f["properties"]["levelM"] for f in contours["features"]}
    assert 0 in levels or any(abs(x) < 1e-9 for x in levels)
    assert any(x > 0 for x in levels) and any(x < 0 for x in levels)
    lon, lat = contours["features"][0]["geometry"]["coordinates"][0]
    assert 50 < lon < 52 and 28 < lat < 30  # EPSG:32639 near the synthetic site


@pytest.mark.parametrize(
    "params, message",
    [
        ({}, "Give items or site, not both"),
        (
            {"site": {"from": {"kind": "smart"}, "to": {"kind": "fit-plane"}}},
            "a base is sampled on the other side",
        ),
        (
            {
                "items": [
                    {
                        "measurement": "m",
                        "ring": [[0, 0], [1, 1]],
                        "item": {"id": "a", "from": {"kind": "current"}, "to": {"kind": "smart"}},
                    }
                ]
            },
            "three or more",
        ),
        ({"items": [], "bogus": 1}, "does not take: bogus"),
    ],
)
def test_bad_parameters_are_refused(params, message):
    with pytest.raises(JobError, match=message):
        pipeline().validate(params)


def test_a_whole_site_base_needs_a_ring(tmp_path):
    prepared(tmp_path)
    with pytest.raises(JobError, match="needs a boundary"):
        run_job(pipeline(), tmp_path, {"site": {"from": {"kind": "smart"}, "to": {"kind": "current"}}})
