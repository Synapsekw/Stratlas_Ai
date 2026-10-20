"""change.raster (M8 C2): two orthos to a change heat map, polygons and region items.

Synthetic two-date imagery only (``imagery_synth``): a painted square must be found with its area,
a shaded patch and an overall tint must not, and misaligned dates are measured and refused.
"""

from __future__ import annotations

import json
import threading

import numpy as np
import pytest

from aio_pipelines.change.register import estimate_shift
from aio_pipelines.pipelines import all_pipelines
from aio_pipelines.runtime import Job, JobError
from conftest import Recorder, run_job
from imagery_synth import (
    cloud_shadow,
    compressed,
    ground,
    noisy,
    ortho_project,
    paint,
    raster_params,
    shade,
    tint,
)

CELL = 0.25
N = 640  # 160 m at 25 cm
SQUARE = 160  # 40 m: 1,600 m2


def pipeline():
    return all_pipelines()["change.raster"]


def dates(seed=1, shift=0):
    """The earlier ortho and the later one (shifted by ``shift`` px east), same ground."""
    big = ground(N + 64, N + 64, seed)
    a = noisy(big[32 : 32 + N, 32 : 32 + N], 101)
    b = noisy(big[32 : 32 + N, 32 - shift : 32 - shift + N], 102)
    return a, b


def read_set(project):
    return json.loads((project / "change" / "c1-c2-raster.json").read_text("utf-8"))


def layers(project):
    return {x["id"]: x for x in json.loads((project / "manifest.json").read_text("utf-8"))["layers"]}


# ------------------------------------------------------------------------------- co-registration


def test_the_shift_between_two_dates_is_measured_to_a_fraction_of_a_pixel():
    a, b = dates(shift=3)
    lum = lambda im: im.mean(axis=2)  # noqa: E731
    s = estimate_shift(lum(a), lum(b), np.ones(a.shape[:2], bool))
    assert s["dy"] == pytest.approx(0, abs=0.3)
    # the later ortho shows the ground 3 px further east: it moves back by 3 px
    assert s["dx"] == pytest.approx(-3, abs=0.3)
    assert s["px"] == pytest.approx(3, abs=0.3)
    assert s["tiles"] >= 4


def test_no_texture_gives_no_shift_and_says_so():
    flat = np.full((256, 256), 0.5)
    s = estimate_shift(flat, flat, np.ones(flat.shape, bool))
    assert s["tiles"] == 0
    assert s["px"] == 0


# --------------------------------------------------------------------------------- end to end


@pytest.mark.parametrize("fmt", ["kit-pyramid", "image", "cog"])
def test_a_painted_square_gives_one_region_with_its_area(tmp_path, fmt):
    a, b = dates()
    b = paint(b, 200, 260, SQUARE)
    ortho_project(tmp_path, a, b, CELL, fmt)
    result, rec = run_job(pipeline(), tmp_path, raster_params())
    assert result["status"] == "done"
    cs = read_set(tmp_path)
    assert cs["schema"] == "aio.change/1"
    assert (cs["from"], cs["to"], cs["producer"]) == ("c1", "c2", "change.raster")
    assert len(cs["items"]) == 1
    item = cs["items"][0]
    assert item["kind"] == "region" and item["verdict"] == "changed"
    assert item["id"] == "region:0001"
    assert item["areaM2"] == pytest.approx(SQUARE * SQUARE * CELL * CELL, rel=0.02)
    assert 0 < item["score"] <= 1
    # the square's centre in the local frame (x east, z south)
    cx = -N * CELL / 2 + (260 + SQUARE / 2) * CELL
    cz = -N * CELL / 2 + (200 + SQUARE / 2) * CELL
    assert item["at"][0] == pytest.approx(cx, abs=0.5)
    assert item["at"][2] == pytest.approx(cz, abs=0.5)
    assert len(item["outline"]) >= 4 and len(item["outlineLocal"]) >= 4
    lon, lat = item["outline"][0]
    assert 50.9 < lon < 51.1 and 28.8 < lat < 29.0
    assert cs["registration"]["ok"] is True
    assert cs["coverage"] == pytest.approx(1, abs=0.01)
    assert cs["stats"]["items"] == 1

    # the heat map (a kit pyramid) and the polygons are new layers of the later date
    lay = layers(tmp_path)
    heat, regions = lay["c1-c2-raster-heat"], lay["c1-c2-raster-regions"]
    for x in (heat, regions):
        assert x["capture"] == "c2"
        assert x["derived"] == {
            "kind": "change",
            "from": "c1",
            "to": "c2",
            "changeId": "c1-c2-raster",
            "runId": "j1",
            "source": ["ortho-a", "ortho-b"],
        }
    assert heat["kind"] == "raster" and heat["format"] == "kit-pyramid" and heat["role"] == "plan"
    tiles = json.loads((tmp_path / heat["src"]["path"]).read_text("utf-8"))
    assert tiles["schema"] == "aio.tiles/1"
    assert tiles["legend"]["kind"] == "score"
    for lvl in tiles["levels"]:
        for tx in range(lvl["cols"]):
            for ty in range(lvl["rows"]):
                assert (tmp_path / lvl["pattern"].format(z=lvl["z"], x=tx, y=ty)).is_file()
    assert regions["kind"] == "vector" and regions["format"] == "geojson"
    fc = json.loads((tmp_path / regions["src"]["path"]).read_text("utf-8"))
    assert [f["properties"]["id"] for f in fc["features"]] == ["region:0001"]
    assert item["layer"] == "c1-c2-raster-regions" and item["feature"] == "region:0001"
    assert set(cs["layers"]) == {"c1-c2-raster-heat", "c1-c2-raster-regions"}
    assert any(p["path"] == "manifest.json" for p in rec.of("artifact"))


def test_light_shade_and_tint_alone_give_no_region(tmp_path):
    a, b = dates()
    b = tint(shade(b, 120, 120, 120, 0.6, soft=2.0))
    b = shade(b, 400, 380, 100, 0.7, soft=0.0)  # a hard-edged shadow too
    ortho_project(tmp_path, a, b, CELL)
    run_job(pipeline(), tmp_path, raster_params())
    cs = read_set(tmp_path)
    assert cs["items"] == []
    assert cs["stats"]["items"] == 0


YARD = 400  # 100 m at 25 cm
SKID = (0.85, 0.55, 0.15)


def yard(later: bool) -> np.ndarray:
    """A yard on one date, as a compressed ortho: a tank (its roof and hard shadow) and a pipe
    (its shadow on the ground) that stay put, and a 3 m skid with its shadow that moves 15 m east.
    The later date is warmer and has a cloud shadow over the pipe; the pipe stays lit, so its edge
    with the shaded ground beside it vanishes (as on the change demo)."""
    img = ground(YARD, YARD, 1)
    img = paint(shade(img, 40, 40, 70, 0.45, soft=0.0), 70, 70, 50, (0.40, 0.45, 0.55))
    img[196:200, 180:330] *= 0.45
    if later:
        img = cloud_shadow(img, 240, 260, 40, 70, 0.6)
    img[200:204, 180:330] = (0.42, 0.45, 0.55)
    c0 = 140 if later else 80
    img[300:312, c0 + 12 : c0 + 15] *= 0.5
    img = paint(img, 300, c0, 12, SKID)
    if later:
        img = tint(img)
    return compressed(noisy(img, 102 if later else 101), 80)


@pytest.mark.parametrize(
    ("threshold", "min_area"),
    [(0.5, 2.0), (0.4, 1.0), (0.3, 0.5)],
    ids=["conservative", "balanced", "sensitive"],
)
def test_a_moved_skid_is_found_and_a_cloud_shadow_and_tank_shadow_are_not(tmp_path, threshold, min_area):
    from shapely.geometry import Point, Polygon

    ortho_project(tmp_path, yard(False), yard(True), CELL)
    run_job(pipeline(), tmp_path, raster_params(threshold=threshold, minAreaM2=min_area))
    items = read_set(tmp_path)["items"]
    regions = [Polygon([(p[0], p[2]) for p in it["outlineLocal"]]) for it in items]

    def at(row: float, col: float) -> Point:
        return Point(-YARD * CELL / 2 + col * CELL, -YARD * CELL / 2 + row * CELL)

    # the skid's old place and its new one, nothing else
    assert len(items) == 2, [(it["areaM2"], it["at"]) for it in items]
    for c0 in (80, 140):
        assert sum(r.contains(at(306, c0 + 6)) for r in regions) == 1
    for it in items:
        # the skid (9 m2) and its shadow strip (2.25 m2)
        assert it["areaM2"] == pytest.approx(11.25, rel=0.2)
    cloud = at(240, 260).buffer(1).union(at(205, 255).buffer(1))  # the shadow and the lit pipe
    tank = at(75, 75).buffer(1)
    assert not any(r.intersects(cloud) or r.intersects(tank) for r in regions)


def test_a_change_beside_shade_and_tint_is_still_found(tmp_path):
    a, b = dates()
    b = tint(shade(paint(b, 60, 60, SQUARE), 360, 300, 140, 0.6))
    ortho_project(tmp_path, a, b, CELL)
    run_job(pipeline(), tmp_path, raster_params())
    items = read_set(tmp_path)["items"]
    assert len(items) == 1
    assert items[0]["areaM2"] == pytest.approx(SQUARE * SQUARE * CELL * CELL, rel=0.02)


def test_a_three_pixel_shift_is_measured_reported_and_corrected(tmp_path):
    a, b = dates(shift=3)
    b = paint(b, 200, 260, SQUARE)
    ortho_project(tmp_path, a, b, CELL)
    run_job(pipeline(), tmp_path, raster_params(maxShiftPx=5))
    cs = read_set(tmp_path)
    reg = cs["registration"]
    assert reg["ok"] is True
    assert reg["shiftPx"] == pytest.approx(3, abs=0.3)
    assert reg["shiftM"] == pytest.approx(3 * CELL, abs=0.1)
    assert reg["tolerancePx"] == 5
    # corrected: the shifted ground is not flagged, only the square
    assert len(cs["items"]) == 1


def test_a_twenty_pixel_shift_is_refused(tmp_path):
    a, b = dates(shift=20)
    ortho_project(tmp_path, a, b, CELL)
    with pytest.raises(JobError, match=r"(19\.\d|20(\.\d)?) px .* apart.*2 px"):
        run_job(pipeline(), tmp_path, raster_params())
    assert not (tmp_path / "change").exists()


def test_the_default_tolerance_refuses_three_pixels(tmp_path):
    a, b = dates(shift=3)
    ortho_project(tmp_path, a, b, CELL)
    with pytest.raises(JobError, match="apart"):
        run_job(pipeline(), tmp_path, raster_params())


def ortho_ring(r0, c0, size):
    """A lon/lat polygon over ``size`` cells of the synthetic ortho, from row ``r0`` and column ``c0``."""
    from rasterio.warp import transform

    x0, z0 = -N * CELL / 2 + c0 * CELL, -N * CELL / 2 + r0 * CELL
    x1, z1 = x0 + size * CELL, z0 + size * CELL
    xs, zs = [x0, x1, x1, x0, x0], [z0, z0, z1, z1, z0]
    lon, lat = transform("EPSG:32639", "EPSG:4326", [500000 + x for x in xs], [3200000 - z for z in zs])
    return [[a_, b_] for a_, b_ in zip(lon, lat, strict=True)]


def test_a_scoped_run_keeps_its_own_set_beside_the_whole_map_one(tmp_path):
    a, b = dates()
    b = paint(b, 200, 260, SQUARE)
    ortho_project(tmp_path, a, b, CELL)
    scope = {"id": "pad-a", "name": "Pad A"}
    run_job(pipeline(), tmp_path, raster_params(), job_id="j1")
    run_job(pipeline(), tmp_path, raster_params(mask=ortho_ring(150, 200, 300), scope=scope), job_id="j2")
    assert len(read_set(tmp_path)["items"]) == 1
    scoped = json.loads((tmp_path / "change" / "c1-c2-raster-area-pad-a.json").read_text("utf-8"))
    assert scoped["scope"] == scope
    assert len(scoped["items"]) == 1
    assert "scope" not in read_set(tmp_path)
    ls = layers(tmp_path)
    for lid in (
        "c1-c2-raster-heat",
        "c1-c2-raster-regions",
        "c1-c2-raster-area-pad-a-heat",
        "c1-c2-raster-area-pad-a-regions",
    ):
        assert lid in ls
    assert ls["c1-c2-raster-area-pad-a-heat"]["name"].startswith("Pad A: imagery change heat map")
    assert ls["c1-c2-raster-area-pad-a-regions"]["name"].startswith("Pad A: imagery change areas")
    assert ls["c1-c2-raster-heat"]["name"].startswith("Imagery change heat map")
    assert (tmp_path / "change" / "c1-c2-raster-area-pad-a" / "heat" / "tiles.json").is_file()


def test_an_ignore_polygon_hides_a_change_and_a_mask_keeps_only_its_area(tmp_path):
    a, b = dates()
    b = paint(b, 200, 260, SQUARE)
    ortho_project(tmp_path, a, b, CELL)
    ring = ortho_ring

    run_job(pipeline(), tmp_path, raster_params(ignore=[ring(190, 250, SQUARE + 20)]), job_id="j1")
    assert read_set(tmp_path)["items"] == []
    run_job(pipeline(), tmp_path, raster_params(mask=ring(0, 0, 150)), job_id="j2")
    assert read_set(tmp_path)["items"] == []
    run_job(pipeline(), tmp_path, raster_params(mask=ring(150, 200, 300)), job_id="j3")
    assert len(read_set(tmp_path)["items"]) == 1


AREA_SCOPE = {"id": "pad-a", "name": "Pad A"}
AREA_SET = "c1-c2-raster-area-pad-a.json"


def test_an_area_outside_the_overlap_is_refused_not_an_all_clear(tmp_path):
    a, b = dates()
    ortho_project(tmp_path, a, b, CELL)
    params = raster_params(mask=ortho_ring(-400, -400, 100), scope=AREA_SCOPE)
    with pytest.raises(JobError, match="no imagery on both dates"):
        run_job(pipeline(), tmp_path, params)
    assert not (tmp_path / "change" / AREA_SET).exists()


def test_an_area_inside_a_gap_of_one_ortho_is_refused(tmp_path):
    a, b = dates()
    ortho_project(tmp_path, a, b, CELL)
    # the earlier ortho has no first tile: a gap over rows and columns 0 to 255
    (tmp_path / "rasters" / "ortho-a" / "0" / "0_0.png").unlink()
    params = raster_params(mask=ortho_ring(40, 40, 100), scope=AREA_SCOPE)
    with pytest.raises(JobError, match="no imagery on both dates"):
        run_job(pipeline(), tmp_path, params)


def test_an_area_reports_the_coverage_of_its_own_polygon(tmp_path):
    a, b = dates()
    ortho_project(tmp_path, a, b, CELL)
    (tmp_path / "rasters" / "ortho-a" / "0" / "0_0.png").unlink()
    # the polygon covers rows 64 to 319 and columns 128 to 383; the gap is rows and columns 0 to 255
    params = raster_params(mask=ortho_ring(64, 128, 256), scope=AREA_SCOPE)
    run_job(pipeline(), tmp_path, params)
    cs = json.loads((tmp_path / "change" / AREA_SET).read_text("utf-8"))
    # rows 64 to 255 of columns 128 to 255 are missing: 192 x 128 of 256 x 256 cells
    assert cs["coverage"] == pytest.approx(1 - (192 * 128) / (256 * 256), abs=0.03)


def test_a_recompute_keeps_the_reviews_and_a_backup(tmp_path):
    a, b = dates()
    b = paint(b, 200, 260, SQUARE)
    ortho_project(tmp_path, a, b, CELL)
    run_job(pipeline(), tmp_path, raster_params(), job_id="j1")
    path = tmp_path / "change" / "c1-c2-raster.json"
    cs = json.loads(path.read_text("utf-8"))
    review = {"status": "confirmed", "by": "Tester", "at": "2026-10-06T10:00:00Z"}
    cs["items"][0]["review"] = review
    path.write_text(json.dumps(cs), "utf-8")
    run_job(pipeline(), tmp_path, raster_params(), job_id="j2")
    again = read_set(tmp_path)
    assert again["items"][0]["review"] == review
    assert (tmp_path / "change" / "c1-c2-raster.json.bak").is_file()
    assert (tmp_path / "manifest.json.bak").is_file()
    ids = [x["id"] for x in json.loads((tmp_path / "manifest.json").read_text("utf-8"))["layers"]]
    assert ids.count("c1-c2-raster-heat") == 1
    assert layers(tmp_path)["c1-c2-raster-heat"]["derived"]["runId"] == "j2"


def test_resume_after_the_orthos_changed_is_refused(tmp_path):
    a, b = dates()
    ortho_project(tmp_path, a, b, CELL)
    cancel = threading.Event()
    rec = Recorder()

    def emit(method, params):
        rec(method, params)
        if method == "progress" and params.get("step") == "read" and params.get("state") == "done":
            cancel.set()

    from aio_pipelines.runtime import Cancelled

    with pytest.raises(Cancelled):
        Job("j1", pipeline(), tmp_path, raster_params(), emit, cancel).run()
    tile = tmp_path / "rasters" / "ortho-b" / "0" / "0_0.png"
    tile.write_bytes(tile.read_bytes() + b"\0")
    with pytest.raises(JobError, match="changed since this job started"):
        Job("j1", pipeline(), tmp_path, raster_params(), Recorder(), threading.Event()).run()


@pytest.mark.parametrize(
    ("params", "message"),
    [
        (raster_params(method="magic"), "method"),
        (raster_params(layerTo="nope"), 'no layer "nope"'),
        (raster_params(threshold=2), "threshold"),
        (raster_params(to="c1"), "two different dates"),
        ({**raster_params(), "bogus": 1}, "does not take: bogus"),
        ({**raster_params(), "scope": {"id": "pad-a", "name": "Pad A"}}, "needs its mask"),
    ],
)
def test_bad_parameters_are_refused_with_a_clear_message(tmp_path, params, message):
    a, b = dates()
    ortho_project(tmp_path, a, b, CELL)
    with pytest.raises(JobError, match=message):
        run_job(pipeline(), tmp_path, params)


def test_a_dsm_is_not_an_ortho(tmp_path):
    a, b = dates()
    ortho_project(tmp_path, a, b, CELL)
    m = json.loads((tmp_path / "manifest.json").read_text("utf-8"))
    m["layers"][1]["role"] = "dsm"
    (tmp_path / "manifest.json").write_text(json.dumps(m), "utf-8")
    with pytest.raises(JobError, match="not an ortho"):
        run_job(pipeline(), tmp_path, raster_params())


@pytest.mark.parametrize("method", ["ssim", "rgb"])
def test_the_other_methods_find_the_square_too(tmp_path, method):
    a, b = dates()
    b = paint(b, 200, 260, SQUARE)
    ortho_project(tmp_path, a, b, CELL)
    run_job(pipeline(), tmp_path, raster_params(method=method))
    items = read_set(tmp_path)["items"]
    assert len(items) == 1
    assert items[0]["method"] == method
    assert items[0]["areaM2"] == pytest.approx(SQUARE * SQUARE * CELL * CELL, rel=0.05)


# ------------------------------------------------------------------------------ lined-up dates


def line_up(project, capture, east, north):
    """Save a date shift on ``capture`` in the project's manifest."""
    path = project / "manifest.json"
    m = json.loads(path.read_text("utf-8"))
    for c in m["captures"]:
        if c["id"] == capture:
            c["lineUp"] = {"eastM": east, "northM": north, "with": "c1", "at": "2026-10-16T09:00:00Z"}
    path.write_text(json.dumps(m), "utf-8")
    return m


@pytest.mark.parametrize("fmt", ["kit-pyramid", "cog"])
def test_ortho_reads_with_the_date_shift(tmp_path, fmt):
    from aio_pipelines.change.imagery import Grid, Ortho

    a, b = dates()
    ortho_project(tmp_path, a, b, CELL, fmt)
    plain_m = json.loads((tmp_path / "manifest.json").read_text("utf-8"))
    moved_m = line_up(tmp_path, "c1", 2.0, 0.0)
    layer = next(x for x in plain_m["layers"] if x["id"] == "ortho-a")
    plain = Ortho(tmp_path, plain_m, layer)
    moved = Ortho(tmp_path, moved_m, layer)
    assert moved.box == pytest.approx((plain.box[0] + 2, plain.box[1], plain.box[2] + 2, plain.box[3]))
    here = Grid(-20.0, -20.0, CELL, 80, 80)
    east = Grid(-18.0, -20.0, CELL, 80, 80)
    rgb, ok = plain.sample(here)
    rgb2, ok2 = moved.sample(east)
    assert ok.all() and ok2.all()
    assert np.abs(rgb2 - rgb).max() < 1e-3


def test_raster_refusal_has_the_misaligned_code(tmp_path):
    a, b = dates(shift=8)  # the later date's content sits 8 px (2 m) east
    ortho_project(tmp_path, a, b, CELL)
    with pytest.raises(JobError, match=r"Line up the dates first\.$") as err:
        run_job(pipeline(), tmp_path, raster_params())
    job = json.loads((tmp_path / "jobs" / "j1" / "job.json").read_text("utf-8"))
    failure = job["failure"]
    assert failure["code"] == "misaligned" == err.value.code
    data = failure["data"]
    assert (data["from"], data["to"]) == ("c1", "c2")
    assert abs(data["eastM"] - 2.0) < 0.1
    assert abs(data["northM"]) < 0.1
    assert data["shiftPx"] == pytest.approx(8, abs=0.3)
    assert data["shiftM"] == pytest.approx(2, abs=0.1)
    assert not (tmp_path / "change").exists()


def test_a_lined_up_pair_runs(tmp_path):
    a, b = dates(shift=8)
    ortho_project(tmp_path, a, b, CELL)
    line_up(tmp_path, "c2", -2.0, 0.0)
    result, _ = run_job(pipeline(), tmp_path, raster_params())
    assert result["status"] == "done"
    cs = read_set(tmp_path)
    assert cs["registration"]["shiftPx"] < 0.5
    assert cs["lineUp"] == {"from": {"eastM": 0.0, "northM": 0.0}, "to": {"eastM": -2.0, "northM": 0.0}}


def test_a_line_up_since_the_job_started_is_refused(tmp_path):
    a, b = dates()
    ortho_project(tmp_path, a, b, CELL)
    cancel = threading.Event()

    def emit(method, params):
        if method == "progress" and params.get("step") == "read" and params.get("state") == "done":
            cancel.set()

    from aio_pipelines.runtime import Cancelled

    with pytest.raises(Cancelled):
        Job("j1", pipeline(), tmp_path, raster_params(), emit, cancel).run()
    line_up(tmp_path, "c2", 1.0, 0.0)
    with pytest.raises(JobError, match="changed since this job started"):
        Job("j1", pipeline(), tmp_path, raster_params(), Recorder(), threading.Event()).run()


# ------------------------------------------------------------------------------ a turned line-up

#: A 0.5 degree turn about the site's south-west corner, then 2 m east.
TURN = {"rotationDeg": 0.5, "scale": 1.0, "pivotE": 500000.0 - 80.0, "pivotN": 3200000.0 - 80.0}


def turn_up(project, capture, east, north, turn):
    m = line_up(project, capture, east, north)
    for c in m["captures"]:
        if c["id"] == capture:
            c["lineUpTurn"] = turn
    (project / "manifest.json").write_text(json.dumps(m), "utf-8")
    return m


def bright_centre(rgb, ok, grid):
    """The local (x, z) centre of the bright cells of a sampled grid."""
    lum = np.where(ok, rgb.mean(axis=2), 0)
    rows, cols = np.nonzero(lum > 0.5)
    w = lum[rows, cols]
    return (
        grid.x0 + (np.average(cols, weights=w) + 0.5) * grid.cell,
        grid.z0 + (np.average(rows, weights=w) + 0.5) * grid.cell,
    )


@pytest.mark.parametrize("fmt", ["kit-pyramid", "image", "cog"])
def test_ortho_follows_a_turned_line_up(tmp_path, fmt):
    from aio_pipelines.change.imagery import Grid, Ortho
    from aio_pipelines.change.raster import ortho_fingerprint
    from aio_pipelines.similarity import Similarity

    # a dark ortho with one bright 4 x 4 px block near its north-east corner
    a = np.full((N, N, 3), 0.1)
    a[16:20, 616:620] = 1.0
    ortho_project(tmp_path, a, a.copy(), CELL, fmt)
    layer = next(x for x in json.loads((tmp_path / "manifest.json").read_text("utf-8"))["layers"])
    plain_m = json.loads((tmp_path / "manifest.json").read_text("utf-8"))
    shifted_m = line_up(tmp_path, "c1", 2.0, 0.0)
    turned_m = turn_up(tmp_path, "c1", 2.0, 0.0, TURN)
    plain, shifted, turned = (Ortho(tmp_path, m, layer) for m in (plain_m, shifted_m, turned_m))
    sim = Similarity.from_line_up({"eastM": 2.0, "northM": 0.0}, TURN)
    origin = plain_m["origin"]

    # the corners move as a whole: the box holds the turned corners
    x0, z0, x1, z1 = plain.box
    xs, zs = sim.apply_local(np.array([x0, x1, x0, x1]), np.array([z0, z0, z1, z1]), origin)
    assert turned.box == pytest.approx((xs.min(), zs.min(), xs.max(), zs.max()), abs=1e-6)

    grid = Grid(-84.0, -84.0, CELL, 680, 680)
    here = bright_centre(*plain.sample(grid), grid)
    assert here == pytest.approx((-80 + 618 * CELL, -80 + 18 * CELL), abs=0.05)
    want = sim.apply_local(here[0], here[1], origin)
    got = bright_centre(*turned.sample(grid), grid)
    assert got == pytest.approx(want, abs=0.1)
    # the turn moves the block about 1.2 m more than the shift alone
    assert np.hypot(want[0] - here[0] - 2.0, want[1] - here[1]) > 1.0

    # the fingerprint tells the turn from the shift alone
    prints = {ortho_fingerprint(tmp_path, [o, o])["hash"] for o in (plain, shifted, turned)}
    assert len(prints) == 3
