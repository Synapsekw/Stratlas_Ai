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
from imagery_synth import ground, noisy, ortho_project, paint, raster_params, shade, tint

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


def test_an_ignore_polygon_hides_a_change_and_a_mask_keeps_only_its_area(tmp_path):
    from rasterio.warp import transform

    a, b = dates()
    b = paint(b, 200, 260, SQUARE)
    ortho_project(tmp_path, a, b, CELL)

    def ring(r0, c0, size):
        x0, z0 = -N * CELL / 2 + c0 * CELL, -N * CELL / 2 + r0 * CELL
        x1, z1 = x0 + size * CELL, z0 + size * CELL
        xs, zs = [x0, x1, x1, x0, x0], [z0, z0, z1, z1, z0]
        lon, lat = transform("EPSG:32639", "EPSG:4326", [500000 + x for x in xs], [3200000 - z for z in zs])
        return [[a_, b_] for a_, b_ in zip(lon, lat, strict=True)]

    run_job(pipeline(), tmp_path, raster_params(ignore=[ring(190, 250, SQUARE + 20)]), job_id="j1")
    assert read_set(tmp_path)["items"] == []
    run_job(pipeline(), tmp_path, raster_params(mask=ring(0, 0, 150)), job_id="j2")
    assert read_set(tmp_path)["items"] == []
    run_job(pipeline(), tmp_path, raster_params(mask=ring(150, 200, 300)), job_id="j3")
    assert len(read_set(tmp_path)["items"]) == 1


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
