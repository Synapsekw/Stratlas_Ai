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


def test_areas_report_their_own_volumes(tmp_path):
    from rasterio.warp import transform

    surface_project(tmp_path)

    def ring(cx, cz, r):
        xs = [cx - r, cx + r, cx + r, cx - r, cx - r]
        zs = [cz - r, cz - r, cz + r, cz + r, cz - r]
        lon, lat = transform(
            "EPSG:32639", "EPSG:4326", [ORIGIN[0] + x for x in xs], [ORIGIN[1] - z for z in zs]
        )
        return [[a, b] for a, b in zip(lon, lat, strict=True)]

    areas = [{"id": "yard-west", "name": "West bay", "ring": ring(-10, -8, 15)}]
    run_job(pipeline(), tmp_path, surface_params(areas=areas))
    cs = read_set(tmp_path)
    [area] = [it for it in cs["items"] if it["id"] == "area:yard-west"]
    assert area["label"].startswith("West bay")
    assert area["volume"]["fillM3"] == pytest.approx(1000, rel=0.02)
    assert area["volume"]["cutM3"] < 5


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
    ],
)
def test_bad_parameters_are_refused(tmp_path, params, message):
    surface_project(tmp_path)
    with pytest.raises(JobError, match=message):
        run_job(pipeline(), tmp_path, params)
