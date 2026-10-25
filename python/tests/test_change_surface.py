"""change.surface (M8 C2): two DSMs or point clouds to cut and fill regions with volumes.

Synthetic surfaces only (``imagery_synth``): a yard whose later date adds a cone pile of known
volume and digs a pit, with +-2 cm survey noise.
"""

from __future__ import annotations

import json
import threading

import numpy as np
import pytest

from aio_pipelines.pipelines import all_pipelines
from aio_pipelines.runtime import Cancelled, Job, JobError
from conftest import Recorder, run_job
from imagery_synth import ORIGIN, surface_params, surface_project


def pipeline():
    return all_pipelines()["change.surface"]


def read_set(project):
    return json.loads((project / "change" / "c1-c2-surface.json").read_text("utf-8"))


def by_verdict(cs, verdict):
    return [it for it in cs["items"] if it["verdict"] == verdict and it["id"].startswith("region:")]


def test_a_pile_gives_fill_and_a_pit_gives_cut_with_their_volumes(tmp_path):
    surface_project(tmp_path)
    result, _ = run_job(pipeline(), tmp_path, surface_params())
    assert result["status"] == "done"
    cs = read_set(tmp_path)
    assert (cs["from"], cs["to"], cs["producer"]) == ("c1", "c2", "change.surface")
    [fill] = by_verdict(cs, "fill")
    [cut] = by_verdict(cs, "cut")
    assert fill["volume"]["fillM3"] == pytest.approx(1000, rel=0.01)
    assert fill["volume"]["netM3"] == pytest.approx(1000, rel=0.01)
    assert cut["volume"]["cutM3"] == pytest.approx(300, rel=0.02)
    assert cut["volume"]["netM3"] == pytest.approx(-300, rel=0.02)
    assert fill["at"][0] == pytest.approx(-10, abs=0.5) and fill["at"][2] == pytest.approx(-8, abs=0.5)
    assert cut["at"][0] == pytest.approx(14, abs=0.5) and cut["at"][2] == pytest.approx(12, abs=0.5)
    # cone radius 12.6 m: about 500 m2
    assert fill["areaM2"] == pytest.approx(np.pi * 12.62**2, rel=0.05)
    assert fill["outline"] and fill["outlineLocal"]
    s = cs["stats"]
    assert s["fillM3"] == pytest.approx(1000, rel=0.01)
    assert s["cutM3"] == pytest.approx(300, rel=0.02)
    assert s["netM3"] == pytest.approx(700, rel=0.02)
    assert s["siteNetM3"] == pytest.approx(700, rel=0.03)
    assert cs["registration"]["ok"] is True
    assert abs(s["verticalOffsetM"]) < 0.01

    m = json.loads((tmp_path / "manifest.json").read_text("utf-8"))
    lay = {x["id"]: x for x in m["layers"]}
    heat, regions = lay["c1-c2-surface-heat"], lay["c1-c2-surface-regions"]
    assert heat["capture"] == regions["capture"] == "c2"
    assert heat["derived"]["source"] == ["surf-a", "surf-b"]
    tiles = json.loads((tmp_path / heat["src"]["path"]).read_text("utf-8"))
    assert tiles["legend"]["kind"] == "metres"
    assert tiles["legend"]["unit"] == "m"
    fc = json.loads((tmp_path / regions["src"]["path"]).read_text("utf-8"))
    assert sorted(f["properties"]["verdict"] for f in fc["features"]) == ["cut", "fill"]
    assert regions["style"]["colorBy"]["field"] == "sign"


def test_survey_noise_alone_gives_no_region(tmp_path):
    surface_project(tmp_path, pile=0, pit=0)
    run_job(pipeline(), tmp_path, surface_params())
    cs = read_set(tmp_path)
    assert cs["items"] == []
    assert abs(cs["stats"]["siteNetM3"]) < 5


@pytest.mark.parametrize("kinds", [("cloud", "cloud"), ("dsm", "cloud")])
def test_point_clouds_give_the_same_volumes_as_dsms(tmp_path, kinds):
    surface_project(tmp_path, kinds=kinds)
    run_job(pipeline(), tmp_path, surface_params(kinds))
    cs = read_set(tmp_path)
    [fill] = by_verdict(cs, "fill")
    [cut] = by_verdict(cs, "cut")
    assert fill["volume"]["fillM3"] == pytest.approx(1000, rel=0.02)
    assert cut["volume"]["cutM3"] == pytest.approx(300, rel=0.03)


@pytest.mark.parametrize("kinds", [("grid", "grid"), ("grid", "las"), ("las", "las"), ("dsm", "grid")])
def test_height_grids_and_las_sources_of_viewing_layers_give_the_same_volumes(tmp_path, kinds):
    # a shaded relief (kit-pyramid) with its aio.grid/1 heights, a png-packed cloud with its LAS
    surface_project(tmp_path, kinds=kinds)
    result, _ = run_job(pipeline(), tmp_path, surface_params(kinds))
    assert result["status"] == "done"
    cs = read_set(tmp_path)
    [fill] = by_verdict(cs, "fill")
    [cut] = by_verdict(cs, "cut")
    assert fill["volume"]["fillM3"] == pytest.approx(1000, rel=0.02)
    assert cut["volume"]["cutM3"] == pytest.approx(300, rel=0.03)
    assert fill["volume"]["cutM3"] == 0 and str(fill["volume"]["cutM3"]) == "0.0"
    assert cs["registration"]["ok"] is True


def test_a_dsm_without_a_height_grid_is_refused_with_what_to_import(tmp_path):
    surface_project(tmp_path, kinds=("grid", "grid"))
    (tmp_path / "sources" / "surf-a.json").unlink()
    with pytest.raises(JobError, match=r'"DSM c1 \(shaded relief\)" has no height grid .*GeoTIFF'):
        run_job(pipeline(), tmp_path, surface_params(("grid", "grid")))


def test_a_viewing_cloud_without_its_las_is_refused(tmp_path):
    surface_project(tmp_path, kinds=("las", "las"))
    (tmp_path / "sources" / "surf-b.las").unlink()
    with pytest.raises(JobError, match=r'"Cloud c2" has no measured points \(sources/surf-b\.las\)'):
        run_job(pipeline(), tmp_path, surface_params(("las", "las")))


def test_a_height_grid_that_changed_since_the_job_started_is_refused(tmp_path):
    import os

    kinds = ("grid", "grid")
    surface_project(tmp_path, kinds=kinds)
    cancel = threading.Event()

    def emit(method, params):
        if method == "progress" and params.get("step") == "read" and params.get("state") == "done":
            cancel.set()

    with pytest.raises(Cancelled):
        Job("j1", pipeline(), tmp_path, surface_params(kinds), emit, cancel).run()
    p = tmp_path / "sources" / "surf-a.png"
    os.utime(p, ns=(p.stat().st_atime_ns, p.stat().st_mtime_ns + 10_000_000))
    with pytest.raises(JobError, match="changed since this job started"):
        Job("j1", pipeline(), tmp_path, surface_params(kinds), Recorder(), threading.Event()).run()


def test_a_cloud_offset_that_changed_since_the_job_started_is_refused(tmp_path):
    kinds = ("cloud", "cloud")
    surface_project(tmp_path, kinds=kinds)
    cancel = threading.Event()

    def emit(method, params):
        if method == "progress" and params.get("step") == "read" and params.get("state") == "done":
            cancel.set()

    with pytest.raises(Cancelled):
        Job("j1", pipeline(), tmp_path, surface_params(kinds), emit, cancel).run()
    path = tmp_path / "manifest.json"
    m = json.loads(path.read_text("utf-8"))
    m["layers"][1]["heightOffsetM"] = 5.0
    path.write_text(json.dumps(m), "utf-8")
    with pytest.raises(JobError, match="changed since this job started"):
        Job("j1", pipeline(), tmp_path, surface_params(kinds), Recorder(), threading.Event()).run()


def local_ring(cx, cz, r):
    from rasterio.warp import transform

    xs = [cx - r, cx + r, cx + r, cx - r, cx - r]
    zs = [cz - r, cz - r, cz + r, cz + r, cz - r]
    lon, lat = transform("EPSG:32639", "EPSG:4326", [ORIGIN[0] + x for x in xs], [ORIGIN[1] - z for z in zs])
    return [[a, b] for a, b in zip(lon, lat, strict=True)]


def test_areas_report_their_own_volumes(tmp_path):
    surface_project(tmp_path)
    areas = [{"id": "yard-west", "name": "West bay", "ring": local_ring(-10, -8, 15)}]
    run_job(pipeline(), tmp_path, surface_params(areas=areas))
    cs = read_set(tmp_path)
    [area] = [it for it in cs["items"] if it["id"] == "area:yard-west"]
    assert area["label"].startswith("West bay")
    assert area["volume"]["fillM3"] == pytest.approx(1000, rel=0.02)
    assert area["volume"]["cutM3"] < 5


SCOPE = {"id": "pile", "name": "Pile"}


def test_a_mask_keeps_only_the_regions_inside(tmp_path):
    surface_project(tmp_path)
    params = surface_params(mask=local_ring(-10, -8, 15), scope=SCOPE)
    result, _ = run_job(pipeline(), tmp_path, params)
    assert result["status"] == "done"
    cs = json.loads((tmp_path / "change" / "c1-c2-surface-area-pile.json").read_text("utf-8"))
    regions = [it for it in cs["items"] if it["id"].startswith("region:")]
    assert len(regions) == 1
    assert regions[0]["verdict"] == "fill"
    assert regions[0]["volume"]["fillM3"] == pytest.approx(1000, rel=0.02)
    assert not by_verdict(cs, "cut")
    assert cs["stats"]["siteCutM3"] < 5
    assert cs["scope"] == SCOPE
    for it in regions:
        assert -25 <= it["at"][0] <= 5 and -23 <= it["at"][2] <= 7
    assert not (tmp_path / "change" / "c1-c2-surface.json").exists()
    m = json.loads((tmp_path / "manifest.json").read_text("utf-8"))
    ls = {x["id"]: x for x in m["layers"]}
    # one row for the area: with no imagery run it shows the cut and fill heat map
    area = "c1-c2-change-area-pile"
    assert [lid for lid in ls if "pile" in lid] == [area]
    assert ls[area]["name"].startswith("Pile: change, ")
    assert ls[area]["src"] == {"path": "change/c1-c2-surface-area-pile/heat/tiles.json"}
    assert cs["layers"] == [area]
    assert {it["layer"] for it in regions} == {area}


def test_an_area_outside_the_surfaces_is_refused_not_an_all_clear(tmp_path):
    surface_project(tmp_path)
    params = surface_params(mask=local_ring(200, 200, 10), scope=SCOPE)
    with pytest.raises(JobError, match="no elevation data on both dates"):
        run_job(pipeline(), tmp_path, params)
    assert not (tmp_path / "change" / "c1-c2-surface-area-pile.json").exists()


def punch_hole(project, lid, cx, cz, r):
    """Nodata over a square of half-size ``r`` around local (cx, cz) in a DSM of ``surface_project``."""
    import rasterio

    path = project / "rasters" / f"{lid}.tif"
    with rasterio.open(path, "r+") as d:
        Y = d.read(1)
        rows, cols = np.indices(Y.shape)
        cell = d.transform.a
        x = -30 + (cols + 0.5) * cell
        z = -30 + (rows + 0.5) * cell
        Y[(np.abs(x - cx) <= r) & (np.abs(z - cz) <= r)] = d.nodata
        d.write(Y, 1)


def test_an_area_inside_a_hole_of_one_surface_is_refused(tmp_path):
    surface_project(tmp_path)
    punch_hole(tmp_path, "surf-a", -10, -8, 8)
    params = surface_params(mask=local_ring(-10, -8, 5), scope=SCOPE)
    with pytest.raises(JobError, match="no elevation data on both dates"):
        run_job(pipeline(), tmp_path, params)


def test_an_area_reports_the_coverage_of_its_own_polygon(tmp_path):
    surface_project(tmp_path)
    # the west half of a 20 m square around (0, 0) has no earlier surface
    punch_hole(tmp_path, "surf-a", -10, 0, 10)
    run_job(pipeline(), tmp_path, surface_params(mask=local_ring(0, 0, 10), scope=SCOPE))
    cs = json.loads((tmp_path / "change" / "c1-c2-surface-area-pile.json").read_text("utf-8"))
    assert cs["coverage"] == pytest.approx(0.5, abs=0.03)


def test_an_area_s_site_totals_match_its_own_volume(tmp_path):
    surface_project(tmp_path)
    ring = local_ring(-10.03, -8.07, 9.6)
    areas = [{"id": "pile", "name": "Pile", "ring": ring}]
    run_job(pipeline(), tmp_path, surface_params(mask=ring, scope=SCOPE, areas=areas))
    cs = json.loads((tmp_path / "change" / "c1-c2-surface-area-pile.json").read_text("utf-8"))
    [area] = [it for it in cs["items"] if it["id"].startswith("area:")]
    assert cs["stats"]["siteFillM3"] == pytest.approx(area["volume"]["fillM3"], abs=0.01)
    assert cs["stats"]["siteCutM3"] == pytest.approx(area["volume"]["cutM3"], abs=0.01)


def test_a_scoped_surface_run_leaves_the_whole_map_set(tmp_path):
    surface_project(tmp_path)
    run_job(pipeline(), tmp_path, surface_params())
    run_job(pipeline(), tmp_path, surface_params(mask=local_ring(-10, -8, 15), scope=SCOPE), job_id="j2")
    cs = read_set(tmp_path)
    assert by_verdict(cs, "fill") and by_verdict(cs, "cut")
    m = json.loads((tmp_path / "manifest.json").read_text("utf-8"))
    ids = {x["id"] for x in m["layers"]}
    assert {"c1-c2-surface-heat", "c1-c2-surface-regions", "c1-c2-change-area-pile"} <= ids
    assert "c1-c2-surface-area-pile-heat" not in ids


def both_project(tmp_path):
    """Orthos (``ortho-a``, ``ortho-b``) and surfaces (``surf-a``, ``surf-b``) of the same two dates."""
    from imagery_synth import ground, noisy, ortho_project, paint

    big = ground(704, 704, 1)
    a = noisy(big[32:672, 32:672], 101)
    b = paint(noisy(big[32:672, 32:672], 102), 200, 260, 160)
    ortho_project(tmp_path, a, b, 0.25)
    orthos = json.loads((tmp_path / "manifest.json").read_text("utf-8"))["layers"]
    surface_project(tmp_path)
    m = json.loads((tmp_path / "manifest.json").read_text("utf-8"))
    m["layers"] = orthos + m["layers"]
    (tmp_path / "manifest.json").write_text(json.dumps(m, indent=1), "utf-8")
    return [x["id"] for x in m["layers"]]


def area_params(producer):
    from imagery_synth import raster_params

    extra = {"mask": local_ring(-10, -8, 15), "scope": SCOPE}
    return raster_params(**extra) if producer == "change.raster" else surface_params(**extra)


@pytest.mark.parametrize("order", [("change.raster", "change.surface"), ("change.surface", "change.raster")])
def test_an_area_compare_with_volumes_leaves_one_layer_that_lists_both_sets(tmp_path, order):
    before = both_project(tmp_path)
    pipes = all_pipelines()
    for i, producer in enumerate(order):
        result, _ = run_job(pipes[producer], tmp_path, area_params(producer), job_id=f"j{i}")
        assert result["status"] == "done", result
        if i == 0:
            # hidden by the person between the two runs: the later run keeps that
            m = json.loads((tmp_path / "manifest.json").read_text("utf-8"))
            for x in m["layers"]:
                if x["id"] == "c1-c2-change-area-pile":
                    x["visible"] = False
            (tmp_path / "manifest.json").write_text(json.dumps(m, indent=1), "utf-8")
    m = json.loads((tmp_path / "manifest.json").read_text("utf-8"))
    area = "c1-c2-change-area-pile"
    assert [x["id"] for x in m["layers"]] == [*before, area]
    [layer] = [x for x in m["layers"] if x["id"] == area]
    assert layer["visible"] is False
    # with volumes the cut and fill heat map is the row's picture, whichever job ended first
    assert layer["src"] == {"path": "change/c1-c2-surface-area-pile/heat/tiles.json"}
    assert layer["derived"]["changeId"] == "c1-c2-surface-area-pile"
    assert set(layer["derived"]["source"]) == {"ortho-a", "ortho-b", "surf-a", "surf-b"}
    for sid in ("c1-c2-raster-area-pile", "c1-c2-surface-area-pile"):
        cs = json.loads((tmp_path / "change" / f"{sid}.json").read_text("utf-8"))
        assert cs["layers"] == [area]
        assert (tmp_path / "change" / sid / "heat" / "tiles.json").is_file()


def test_the_thresholds_are_honoured(tmp_path):
    surface_project(tmp_path)
    run_job(pipeline(), tmp_path, surface_params(minAreaM2=600))
    cs = read_set(tmp_path)
    assert by_verdict(cs, "cut") == []
    assert len(by_verdict(cs, "fill")) == 0  # 500 m2 pile below 600 m2
    run_job(pipeline(), tmp_path, surface_params(minDepthM=7), job_id="j2")
    assert read_set(tmp_path)["items"] == []


def test_a_raised_later_surface_is_refused(tmp_path):
    surface_project(tmp_path)
    import rasterio

    p = tmp_path / "rasters" / "surf-b.tif"
    with rasterio.open(p, "r+") as d:
        d.write(d.read(1) + np.float32(0.2), 1)
    with pytest.raises(JobError, match=r"0\.20 m higher"):
        run_job(pipeline(), tmp_path, surface_params())


def test_a_shifted_later_surface_is_refused(tmp_path):
    surface_project(tmp_path, pit=0)
    import rasterio
    from rasterio.transform import Affine

    p = tmp_path / "rasters" / "surf-b.tif"
    with rasterio.open(p, "r+") as d:
        t = d.transform
        d.transform = Affine(t.a, t.b, t.c + 1.5, t.d, t.e, t.f)
    with pytest.raises(JobError, match="apart"):
        run_job(pipeline(), tmp_path, surface_params())


def test_the_capture_pair_comes_from_the_layers_or_the_parameters(tmp_path):
    surface_project(tmp_path)
    m = json.loads((tmp_path / "manifest.json").read_text("utf-8"))
    for x in m["layers"]:
        x.pop("capture")
    (tmp_path / "manifest.json").write_text(json.dumps(m), "utf-8")
    with pytest.raises(JobError, match="Say which survey dates"):
        run_job(pipeline(), tmp_path, surface_params())
    run_job(pipeline(), tmp_path, surface_params(captures={"from": "c1", "to": "c2"}), job_id="j2")
    assert read_set(tmp_path)["to"] == "c2"


def test_resume_after_a_surface_changed_is_refused(tmp_path):
    surface_project(tmp_path)
    cancel = threading.Event()

    def emit(method, params):
        if method == "progress" and params.get("step") == "read" and params.get("state") == "done":
            cancel.set()

    with pytest.raises(Cancelled):
        Job("j1", pipeline(), tmp_path, surface_params(), emit, cancel).run()
    p = tmp_path / "rasters" / "surf-a.tif"
    p.write_bytes(p.read_bytes())  # same bytes, a new modification time
    import os

    os.utime(p, ns=(p.stat().st_atime_ns, p.stat().st_mtime_ns + 10_000_000))
    with pytest.raises(JobError, match="changed since this job started"):
        Job("j1", pipeline(), tmp_path, surface_params(), Recorder(), threading.Event()).run()


@pytest.mark.parametrize(
    ("params", "message"),
    [
        ({"from": {"layer": "surf-a", "kind": "mesh"}, "to": {"layer": "surf-b", "kind": "dsm"}}, "kind"),
        (surface_params(cellM=0), "cellM"),
        ({**surface_params(), "bogus": 1}, "does not take: bogus"),
        (surface_params(kinds=("cloud", "dsm")), "not a point cloud"),
        (surface_params(scope={"id": "p", "name": "P"}), "needs its mask"),
        (surface_params(mask=[[1, 2]]), "mask must be a polygon"),
    ],
)
def test_bad_parameters_are_refused(tmp_path, params, message):
    surface_project(tmp_path)
    with pytest.raises(JobError, match=message):
        run_job(pipeline(), tmp_path, params)


# ----------------------------------------------------------------------------- cloud height offset


def points_ctx(tmp_path):
    from types import SimpleNamespace

    def stage(rel):
        p = tmp_path / "stage" / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        return p

    (tmp_path / "stage").mkdir(exist_ok=True)
    return SimpleNamespace(
        job=SimpleNamespace(dir=tmp_path / "stage"),
        cancel_event=threading.Event(),
        check=lambda: None,
        stage=stage,
        log=lambda *a, **k: None,
        progress=lambda *a, **k: None,
    )


def surface_points(project, lid, ctx, offset=None):
    from aio_pipelines.change.surface import Surface

    m = json.loads((project / "manifest.json").read_text("utf-8"))
    for layer in m["layers"]:
        if layer["id"] == lid:
            if offset is None:
                layer.pop("heightOffsetM", None)
            else:
                layer["heightOffsetM"] = offset
    return Surface(project, m, {"layer": lid, "kind": "cloud"}).points(ctx)


def assert_lifted(plain, lifted):
    assert plain.shape == lifted.shape
    plain = plain[np.lexsort((plain[:, 2], plain[:, 0]))]
    lifted = lifted[np.lexsort((lifted[:, 2], lifted[:, 0]))]
    assert np.allclose(lifted[:, 0], plain[:, 0])
    assert np.allclose(lifted[:, 2], plain[:, 2])
    assert np.allclose(lifted[:, 1] - plain[:, 1], 5.0, atol=1e-6)


@pytest.mark.parametrize("kind", ["cloud", "las"])
def test_surface_points_carry_the_height_offset(tmp_path, kind):
    # kit-packed, and the LAS source of a png-packed viewing layer
    surface_project(tmp_path, kinds=(kind, kind))
    ctx = points_ctx(tmp_path)
    plain = surface_points(tmp_path, "surf-a", ctx)
    lifted = surface_points(tmp_path, "surf-a", ctx, 5.0)
    assert_lifted(plain, lifted)


def test_surface_points_carry_the_height_offset_for_a_copc(tmp_path):
    from aio_pipelines.pointcloud import find_pdal

    if find_pdal() is None:
        pytest.skip("PDAL is not installed (AIO_PDAL)")
    from pccleanup_synth import to_copc

    surface_project(tmp_path, kinds=("las", "las"))
    (tmp_path / "clouds").mkdir(exist_ok=True)
    to_copc(tmp_path / "sources" / "surf-a.las", tmp_path / "clouds" / "surf-a.copc.laz")
    m = json.loads((tmp_path / "manifest.json").read_text("utf-8"))
    for layer in m["layers"]:
        if layer["id"] == "surf-a":
            layer["format"] = "copc"
            layer["src"] = {"path": "clouds/surf-a.copc.laz"}
    (tmp_path / "manifest.json").write_text(json.dumps(m), "utf-8")
    ctx = points_ctx(tmp_path)
    plain = surface_points(tmp_path, "surf-a", ctx)
    lifted = surface_points(tmp_path, "surf-a", ctx, 5.0)
    assert_lifted(plain, lifted)


# ------------------------------------------------------------------------------ lined-up dates


def line_up(project, capture, east, north):
    path = project / "manifest.json"
    m = json.loads(path.read_text("utf-8"))
    for c in m["captures"]:
        if c["id"] == capture:
            c["lineUp"] = {"eastM": east, "northM": north, "with": "c1", "at": "2026-10-16T09:00:00Z"}
    path.write_text(json.dumps(m), "utf-8")


@pytest.mark.parametrize("kind", ["cloud", "las"])
def test_surface_points_carry_the_shift(tmp_path, kind):
    surface_project(tmp_path, kinds=(kind, kind))
    ctx = points_ctx(tmp_path)
    plain = surface_points(tmp_path, "surf-a", ctx)
    line_up(tmp_path, "c1", 2.0, -1.0)
    moved = surface_points(tmp_path, "surf-a", ctx)
    assert plain.shape == moved.shape
    assert np.allclose(moved[:, 0] - plain[:, 0], 2.0)
    assert np.allclose(moved[:, 1], plain[:, 1])
    assert np.allclose(moved[:, 2] - plain[:, 2], 1.0)  # 1 m south: z grows


def test_surface_fingerprint_changes_with_a_line_up(tmp_path):
    from aio_pipelines.change.surface import Surface, surface_fingerprint

    surface_project(tmp_path)

    def fingerprint():
        m = json.loads((tmp_path / "manifest.json").read_text("utf-8"))
        pair = [Surface(tmp_path, m, s) for s in (surface_params()["from"], surface_params()["to"])]
        return surface_fingerprint(tmp_path, pair)["hash"]

    plain = fingerprint()
    line_up(tmp_path, "c2", 0.0, 0.0)
    assert fingerprint() == plain  # a zero shift is no shift
    line_up(tmp_path, "c2", 0.5, 0.0)
    moved = fingerprint()
    assert moved != plain
    line_up(tmp_path, "c2", 0.0, 0.5)
    assert fingerprint() not in (plain, moved)


def shift_later_surface(project, kind, east):
    """Move the later surface's file ``east`` metres east."""
    if kind == "dsm":
        import rasterio
        from rasterio.transform import Affine

        with rasterio.open(project / "rasters" / "surf-b.tif", "r+") as d:
            t = d.transform
            d.transform = Affine(t.a, t.b, t.c + east, t.d, t.e, t.f)
    else:
        p = project / "sources" / "surf-b.json"
        g = json.loads(p.read_text("utf-8"))
        g["x0"] += east
        p.write_text(json.dumps(g), "utf-8")


@pytest.mark.parametrize("kind", ["dsm", "grid"])
def test_surface_refusal_has_the_misaligned_code(tmp_path, kind):
    surface_project(tmp_path, kinds=(kind, kind), pit=0)
    shift_later_surface(tmp_path, kind, 1.5)
    with pytest.raises(JobError, match=r"Line up the dates first\.$") as err:
        run_job(pipeline(), tmp_path, surface_params((kind, kind)))
    assert err.value.code == "misaligned"
    job = json.loads((tmp_path / "jobs" / "j1" / "job.json").read_text("utf-8"))
    data = job["failure"]["data"]
    assert job["failure"]["code"] == "misaligned"
    assert (data["from"], data["to"]) == ("c1", "c2")
    assert abs(data["eastM"] - 1.5) < 0.1
    assert abs(data["northM"]) < 0.1


@pytest.mark.parametrize("kind", ["dsm", "grid"])
def test_a_lined_up_surface_pair_runs(tmp_path, kind):
    surface_project(tmp_path, kinds=(kind, kind), pit=0)
    shift_later_surface(tmp_path, kind, 1.5)
    line_up(tmp_path, "c2", -1.5, 0.0)
    result, _ = run_job(pipeline(), tmp_path, surface_params((kind, kind)))
    assert result["status"] == "done"
    cs = read_set(tmp_path)
    assert cs["registration"]["shiftPx"] < 0.5
    assert cs["lineUp"]["to"] == {"eastM": -1.5, "northM": 0.0}
    [fill] = by_verdict(cs, "fill")
    assert fill["volume"]["fillM3"] == pytest.approx(1000, rel=0.02)
    assert fill["at"][0] == pytest.approx(-10, abs=0.5)


# ------------------------------------------------------------------------------ a turned line-up

#: A 0.5 degree turn about the yard's south-west corner, then 2 m east.
TURN = {"rotationDeg": 0.5, "scale": 1.0, "pivotE": 500000.0 - 30.0, "pivotN": 3200000.0 - 30.0}


def turn_up(project, capture, east, north, turn):
    line_up(project, capture, east, north)
    path = project / "manifest.json"
    m = json.loads(path.read_text("utf-8"))
    for c in m["captures"]:
        if c["id"] == capture:
            c["lineUpTurn"] = turn
    path.write_text(json.dumps(m), "utf-8")
    return m


@pytest.mark.parametrize("kind", ["dsm", "grid", "cloud", "las"])
def test_surface_follows_a_turned_line_up(tmp_path, kind):
    from aio_pipelines.change.imagery import Grid
    from aio_pipelines.change.surface import Surface, surface_fingerprint
    from aio_pipelines.similarity import Similarity

    surface_project(tmp_path, kinds=(kind, kind), noise=0.0)
    spec = surface_params((kind, kind))["from"]
    ctx = points_ctx(tmp_path)
    plain_m = json.loads((tmp_path / "manifest.json").read_text("utf-8"))
    origin = plain_m["origin"]
    sim = Similarity.from_line_up({"eastM": 2.0, "northM": 0.0}, TURN)
    plain = Surface(tmp_path, plain_m, spec)
    line_up(tmp_path, "c1", 2.0, 0.0)
    shifted = Surface(tmp_path, json.loads((tmp_path / "manifest.json").read_text("utf-8")), spec)
    turned = Surface(tmp_path, turn_up(tmp_path, "c1", 2.0, 0.0, TURN), spec)

    if kind in ("cloud", "las"):
        before, after = plain.points(ctx), turned.points(ctx)
        x, z = sim.apply_local(before[:, 0], before[:, 2], origin)
        assert np.allclose(after[:, 0], x, atol=1e-6) and np.allclose(after[:, 2], z, atol=1e-6)
        assert np.array_equal(after[:, 1], before[:, 1])  # heights never change
    else:
        # the box holds the turned corners
        x0, z0, x1, z1 = plain.box
        xs, zs = sim.apply_local(np.array([x0, x1, x0, x1]), np.array([z0, z0, z1, z1]), origin)
        assert turned.box == pytest.approx((xs.min(), zs.min(), xs.max(), zs.max()), abs=0.11)

    # the shed (local x 4..12, z -25..-15, 3 m tall) lands where the line-up puts it
    grid = Grid(-34.0, -34.0, 0.1, 680, 680)
    for s in (plain, turned):
        s.footprint(ctx)
    X, Z = np.meshgrid(grid.x0 + (np.arange(680) + 0.5) * 0.1, grid.z0 + (np.arange(680) + 0.5) * 0.1)

    def shed(s):
        h = s.heights(grid, ctx) - (1.0 + 0.01 * X - 0.004 * Z)
        on = np.nan_to_num(h) > 2.0
        return X[on].mean(), Z[on].mean(), X[on].max()

    here = shed(plain)
    assert here[:2] == pytest.approx((8.0, -20.0), abs=0.1)
    got = shed(turned)
    want = sim.apply_local(8.0, -20.0, origin)
    assert got[:2] == pytest.approx(want, abs=0.1)
    assert np.hypot(want[0] - 10.0, want[1] + 20.0) > 0.4  # more than the shift alone

    prints = {surface_fingerprint(tmp_path, [s, s])["hash"] for s in (plain, shifted, turned)}
    assert len(prints) == 3
