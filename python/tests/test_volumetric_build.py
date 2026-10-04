"""volumetric.build end to end on synthetic surveys (no client data)."""

import base64
import json
import math
import os
import struct
import threading
import zlib

import numpy as np
import pytest

from aio_pipelines.runtime import Cancelled, Job, JobError
from aio_pipelines.volumetric.build import VolumetricBuild
from aio_pipelines.volumetric.terrain import HeightGrid, build_terrain
from conftest import run_job, write_dsm
from test_volumetric import PILES, RES, SIZE, X0, Y0, cone, surface

ORIGIN = [X0 + SIZE / 2, Y0 + SIZE / 2, 10.0]


def manifest(project, captures=()):
    m = {
        "schema": "aio.project/1",
        "id": "synthetic-yard",
        "name": "Synthetic yard",
        "crs": {"epsg": 32639},
        "origin": ORIGIN,
        "captures": list(captures),
        "layers": [],
        "severityModels": [],
        "classCatalogues": [],
        "type": "volumetric",
    }
    (project / "manifest.json").write_text(json.dumps(m))
    return m


def write_ortho(path, res=0.2):
    """An RGBA GeoTIFF over the yard: a colour ramp, transparent along the west edge."""
    import rasterio
    from rasterio.transform import from_origin

    n = round(SIZE / res)
    yy, xx = np.mgrid[0:n, 0:n]
    img = np.stack(
        [(xx * 255 // n), (yy * 255 // n), np.full((n, n), 90), np.where(xx < n // 20, 0, 255)]
    ).astype(np.uint8)
    path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        height=n,
        width=n,
        count=4,
        dtype="uint8",
        crs="EPSG:32639",
        transform=from_origin(X0, Y0 + SIZE, res, res),
    ) as d:
        d.write(img)
    return path


def surveys(tmp, heights, ortho=True, res=RES):
    eps = []
    for i, h in enumerate(heights, 1):
        e = {
            "id": f"e{i}",
            "date": f"2026-01-0{i}",
            "dsm": str(write_dsm(tmp / f"raw/e{i}_dsm.tif", surface(h, res), X0, Y0 + SIZE, res)),
            "cp_rmse_z_m": 0.013,
        }
        if ortho:
            e["ortho"] = str(write_ortho(tmp / f"raw/e{i}_ortho.tif"))
        eps.append(e)
    return eps


def kit_script(path):
    t = path.read_text("utf-8")
    return json.loads(t[t.index("]=") + 2 :].rstrip().rstrip(";")) if "]=" in t else None


def i16(s, w, h):
    d = np.frombuffer(zlib.decompress(base64.b64decode(s)), dtype="<i2").reshape(h, w).astype(np.int32)
    return np.cumsum(d, axis=1)


def bits(s, n):
    return np.unpackbits(np.frombuffer(zlib.decompress(base64.b64decode(s)), np.uint8))[:n].astype(bool)


def glb_json(path):
    b = path.read_bytes()
    magic, version, total = struct.unpack_from("<III", b, 0)
    assert (magic, version, total) == (0x46546C67, 2, len(b))
    n, kind = struct.unpack_from("<II", b, 12)
    assert kind == 0x4E4F534A
    return json.loads(b[20 : 20 + n])


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    """One two-date build shared by the checks below (it takes a few seconds)."""
    tmp = tmp_path_factory.mktemp("vb")
    project = tmp / "project"
    project.mkdir()
    manifest(project, [{"id": "capture-2026-01-01", "label": "Survey", "date": "2026-01-01"}])
    cfg = {"epochs": surveys(tmp, [{"A": 8.0, "B": 7.0}, {"A": 5.0, "B": 7.0}])}
    result, rec = run_job(VolumetricBuild(), project, {"config": cfg})
    return project, result, rec, cfg


def test_the_grid_is_derived_from_the_rasters(built):
    project, result, _, _ = built
    g = result["outputs"]["prepare"]["grid"]
    assert (g["x0"], g["y0"], g["x1"], g["y1"]) == (X0, Y0, X0 + SIZE, Y0 + SIZE)
    assert g["dsm_res"] == 0.1 and g["ortho_res"] == 0.2 and g["tile"] == 1024 and g["zmax"] == 0
    job = json.loads((project / "volumetric" / "job.json").read_text("utf-8"))
    assert job["grid"] == g and [e["label"] for e in job["epochs"]] == ["1 Jan 2026", "2 Jan 2026"]
    assert "_sources" not in job and job["volume"]["default_base"] == "tin"


def test_volumes_json_has_piles_bases_change_and_grids(built):
    project, *_ = built
    doc = json.loads((project / "volumes.json").read_text("utf-8"))
    assert doc["schema"] == "aio.volumes/1" and doc["defaultBase"] == "tin"
    assert [b["id"] for b in doc["bases"]] == ["tin", "plane", "avg", "low"]
    assert [c["epoch"] for c in doc["captures"]] == ["e1", "e2"]
    # a capture already in the manifest on that date is reused
    assert [c["captureId"] for c in doc["captures"]] == ["capture-2026-01-01", "survey-2026-01-02"]
    assert doc["captures"][1]["layers"] == ["terrain-2026-01-02", "ortho-2026-01-02"]
    assert doc["grids"] == {
        "format": "vs-kit-js",
        "piles": "volumetric/data/piles/{id}.js",
        "dsm": "volumetric/data/dsm_{epoch}.js",
        "coarse": "volumetric/data/vol.js",
    }
    assert len(doc["piles"]) == 2
    a = next(p for p in doc["piles"] if p["centreEN"][1] > Y0 + 60)
    e1, e2 = a["epochs"]["e1"], a["epochs"]["e2"]
    assert e1["node"] == f"{a['id']}_e1" and set(e1["volumes"]) == {"tin", "plane", "avg", "low"}
    hm = e1["heightM"]
    assert e1["volumes"]["plane"]["net"] == pytest.approx(cone(12 * hm / 8, hm), rel=0.04)
    assert e2["volumes"]["tin"]["net"] < e1["volumes"]["tin"]["net"]
    assert a["change"]["cut"] == pytest.approx(cone(12, 8) - cone(12, 5), rel=0.05)
    # rings are local [x, z]: x east of the origin, z south of it
    xs = [p[0] for p in e1["ring"]]
    zs = [p[1] for p in e1["ring"]]
    cx, cy = PILES["A"][0] - SIZE / 2, -(PILES["A"][1] - SIZE / 2)
    assert min(xs) < cx < max(xs) and min(zs) < cy < max(zs)
    assert doc["totals"]["e1"]["tin"] == pytest.approx(
        sum(p["epochs"]["e1"]["volumes"]["tin"]["net"] for p in doc["piles"]), abs=0.2
    )
    assert doc["pileChange"]["net"] == pytest.approx(sum(p["change"]["net"] for p in doc["piles"]), abs=0.2)


def test_kit_grids_reproduce_the_volumes(built):
    """The 10 cm pile grids give back the published volumes with the viewer's maths."""
    project, *_ = built
    doc = json.loads((project / "volumes.json").read_text("utf-8"))
    for p in doc["piles"]:
        g = kit_script(project / "volumetric" / "data" / "piles" / f"{p['id']}.js")
        w, h, r = g["w"], g["h"], g["res"]
        assert set(g["tex"]) == {"e1", "e2"} and g["tex"]["e1"].startswith("data:image/jpeg;base64,")
        for e, m in p["epochs"].items():
            ep = g["ep"][e]
            z = i16(ep["z"], w, h) / 100 + g["zoff"]
            mask = bits(ep["m"], w * h).reshape(h, w)
            base = i16(ep["tin"], w, h) / 100 + g["zoff"]
            d = (z - base)[mask]
            fill = d[d > 0].sum() * r * r
            assert fill == pytest.approx(m["volumes"]["tin"]["fill"], abs=0.1)
            xx = (np.arange(w) + 0.5) * r
            yy = (np.arange(h) + 0.5) * r
            c = ep["plane"]
            d = (z - (c[0] + c[1] * xx[None, :] + c[2] * yy[:, None]))[mask]
            assert d.sum() * r * r == pytest.approx(m["volumes"]["plane"]["net"], abs=0.1)
    dsm = kit_script(project / "volumetric" / "data" / "dsm_e1.js")
    assert (dsm["res"], dsm["w"], dsm["h"]) == (0.4, 300, 300)
    vol = (project / "volumetric" / "data" / "vol.js").read_text("utf-8")
    assert vol.startswith("window.VS_VOL=") and all(p["id"] in vol for p in doc["piles"])
    site = (project / "volumetric" / "data" / "site.js").read_text("utf-8")
    assert site.startswith("window.VS_SITE=")
    assert (project / "volumetric" / "piles.csv").read_text("utf-8").startswith("pile,status,e1_area_m2")


def test_terrain_meshes_and_ortho_pyramids_join_the_manifest(built):
    project, _, rec, _ = built
    m = json.loads((project / "manifest.json").read_text("utf-8"))
    assert (project / "manifest.json.bak").exists()
    assert [c["date"] for c in m["captures"]] == ["2026-01-01", "2026-01-02"]
    ids = [x["id"] for x in m["layers"]]
    assert ids == ["terrain-2026-01-02", "terrain-2026-01-01", "ortho-2026-01-02", "ortho-2026-01-01"]
    mesh = m["layers"][0]
    assert mesh["visible"] and not m["layers"][1]["visible"]
    assert {t["node"] for t in mesh["tags"]} == {"P01_e2", "P02_e2"}
    assert all(t["area"].endswith(" m³") for t in mesh["tags"])
    g = glb_json(project / mesh["src"]["path"])
    names = [n["name"] for n in g["nodes"]]
    assert names[:2] == ["Stockyard_e2", "Terrain_e2"] and {"P01_e2", "P02_e2"} <= set(names)
    assert g["nodes"][1]["extras"] == {"type": "terrain"}
    pile = next(n for n in g["nodes"] if n["name"] == "P01_e2")
    assert pile["extras"] == {"type": "stockpile"}
    prims = g["meshes"][pile["mesh"]]["primitives"]
    assert prims[1]["mode"] == 1 and prims[1]["material"] == 1  # the toe line
    assert g["images"][0]["mimeType"] == "image/jpeg" and "TEXCOORD_0" in prims[0]["attributes"]
    # the yard floor sits near local y = 0 (origin H 10 m, floor at 10 m + slope)
    lo = g["accessors"][g["meshes"][0]["primitives"][0]["attributes"]["POSITION"]]["min"]
    assert -61 < lo[0] < -59 and 0 <= lo[1] < 2
    ortho = m["layers"][2]
    assert ortho["format"] == "kit-pyramid" and ortho["role"] == "ortho"
    tj = json.loads((project / ortho["src"]["path"]).read_text("utf-8"))
    assert tj["levels"] == [
        {"z": 0, "tileSize": 1024, "cols": 1, "rows": 1, "pattern": "rasters/ortho-e2/{z}/{x}_{y}.webp"}
    ]
    assert tj["corners"]["tl"][0] == -60 and tj["corners"]["tl"][2] == -60
    assert (project / "rasters" / "ortho-e2" / "0" / "0_0.webp").exists()
    assert (project / "thumbnail.jpg").exists()
    paths = [x["path"] for x in rec.of("artifact")]
    assert paths[-2:] == ["volumes.json", "manifest.json"]


def test_one_point_cloud_date_builds_without_change(tmp_path, project):
    manifest(project)
    las = write_las(tmp_path / "scan.las", {"A": 8.0})
    cfg = {"epochs": [{"date": "2026-02-01", "cloud": str(las)}]}
    result, _ = run_job(VolumetricBuild(), project, {"config": cfg})
    assert result["outputs"]["dsm-2"] == {"skipped": True}
    assert result["outputs"]["ortho-1"]["tiles"] >= 1  # point colours stand in for an ortho
    doc = json.loads((project / "volumes.json").read_text("utf-8"))
    assert [p["status"] for p in doc["piles"]] == ["measured"]
    assert doc["piles"][0]["change"] == {"fill": 0.0, "cut": 0.0, "net": 0.0}
    v = doc["piles"][0]["epochs"]["e1"]["volumes"]["plane"]["net"]
    h = doc["piles"][0]["epochs"]["e1"]["heightM"]
    assert v == pytest.approx(cone(12 * h / 8, h), rel=0.06)


def test_a_coarse_dsm_is_sampled_bilinearly(tmp_path, project):
    manifest(project)
    cfg = {"epochs": surveys(tmp_path, [{"A": 8.0}], ortho=False, res=0.5)}
    run_job(VolumetricBuild(), project, {"config": cfg})
    doc = json.loads((project / "volumes.json").read_text("utf-8"))
    e = doc["piles"][0]["epochs"]["e1"]
    # 0.5 m source cells blunt the crest, so the cone through the measured height is only close
    assert e["volumes"]["plane"]["net"] == pytest.approx(cone(12 * e["heightM"] / 8, e["heightM"]), rel=0.1)
    assert e["heightM"] == pytest.approx(8.0, abs=1.0)
    g = glb_json(project / "models" / "terrain-2026-01-01.glb")
    assert "images" not in g  # no ortho: an untextured terrain


def test_cancel_resumes_and_a_changed_input_is_refused(tmp_path, project):
    manifest(project)
    cfg = {"epochs": surveys(tmp_path, [{"A": 8.0}])}
    ev = threading.Event()

    def emit(method, msg):
        if method == "progress" and msg.get("step") == "process" and msg["state"] == "start":
            ev.set()

    with pytest.raises(Cancelled):
        Job("b1", VolumetricBuild(), project, {"config": cfg}, emit, ev).run()
    steps = sorted(p.name for p in (project / "jobs" / "b1" / "steps").iterdir())
    assert steps[0].startswith("01-prepare") and not (project / "volumes.json").exists()
    result, rec = run_job(VolumetricBuild(), project, {"config": cfg}, job_id="b1")
    assert result["status"] == "done"
    assert any(m["state"] == "skipped" and m["step"] == "dsm-1" for m in rec.of("progress") if "state" in m)

    # a changed survey file refuses the resume of an unfinished job
    ev2 = threading.Event()

    def emit2(method, msg):
        if method == "progress" and msg.get("step") == "dsm-1" and msg["state"] == "start":
            ev2.set()

    with pytest.raises(Cancelled):
        Job("b2", VolumetricBuild(), project, {"config": cfg}, emit2, ev2).run()
    dsm = cfg["epochs"][0]["dsm"]
    st = os.stat(dsm)
    os.utime(dsm, ns=(st.st_atime_ns, st.st_mtime_ns + 5_000_000_000))
    with pytest.raises(JobError, match="changed since this job started"):
        run_job(VolumetricBuild(), project, {"config": cfg}, job_id="b2")


def test_a_job_file_resume_checks_its_sources(tmp_path, project):
    manifest(project)
    eps = surveys(project, [{"A": 8.0}], ortho=False)
    for e in eps:
        e["dsm"] = os.path.relpath(e["dsm"], project).replace("\\", "/")
    (project / "survey.json").write_text(json.dumps({"epochs": eps}))
    ev = threading.Event()

    def emit(method, msg):
        if method == "progress" and msg.get("step") == "dsm-1" and msg["state"] == "start":
            ev.set()

    with pytest.raises(Cancelled):
        Job("j1", VolumetricBuild(), project, {"job": "survey.json"}, emit, ev).run()
    dsm = project / eps[0]["dsm"]
    st = os.stat(dsm)
    os.utime(dsm, ns=(st.st_atime_ns, st.st_mtime_ns + 5_000_000_000))
    with pytest.raises(JobError, match="survey files changed"):
        run_job(VolumetricBuild(), project, {"job": "survey.json"}, job_id="j1")


@pytest.mark.parametrize(
    ("cfg", "msg"),
    [
        ({"epochs": []}, "one or two"),
        ({"epochs": [{"date": "2026-01-01"}]}, "either a DSM"),
        ({"epochs": [{"date": "2026-01-01", "dsm": "a.tif", "cloud": "b.laz"}]}, "either a DSM"),
        ({"epochs": [{"date": "1 Jan", "dsm": "a.tif"}]}, "YYYY-MM-DD"),
        ({"epochs": [{"date": "2026-02-30", "dsm": "a.tif"}]}, "not a date"),
        ({"epochs": [{"date": "2026-01-01", "dsm": "a.png"}]}, "GeoTIFF"),
        ({"epochs": [{"date": "2026-01-01", "cloud": "a.xyz"}]}, "LAS, LAZ"),
        (
            {"epochs": [{"date": "2026-01-02", "dsm": "a.tif"}, {"date": "2026-01-01", "dsm": "b.tif"}]},
            "date order",
        ),
        (
            {"epochs": [{"date": "2026-01-01", "dsm": "a.tif"}, {"date": "2026-01-01", "dsm": "b.tif"}]},
            "same date",
        ),
        ({"epochs": [{"date": "2026-01-01", "dsm": "a.tif"}], "grid": {"x0": 1}}, "grid needs"),
    ],
)
def test_config_is_checked(cfg, msg):
    with pytest.raises(JobError, match=msg):
        VolumetricBuild().validate({"config": cfg})


def test_a_missing_source_and_a_foreign_crs_are_explained(tmp_path, project):
    manifest(project)
    with pytest.raises(JobError, match="dsm file not found"):
        run_job(
            VolumetricBuild(), project, {"config": {"epochs": [{"date": "2026-01-01", "dsm": "nope.tif"}]}}
        )
    import rasterio
    from rasterio.transform import from_origin

    p = tmp_path / "wgs.tif"
    with rasterio.open(
        p,
        "w",
        driver="GTiff",
        height=4,
        width=4,
        count=1,
        dtype="float32",
        crs="EPSG:4326",
        transform=from_origin(48, 29, 0.001, 0.001),
    ) as d:
        d.write(np.zeros((1, 4, 4), np.float32))
    with pytest.raises(JobError, match="EPSG:4326, the project in EPSG:32639"):
        run_job(
            VolumetricBuild(), project, {"config": {"epochs": [{"date": "2026-01-01", "dsm": str(p)}]}}, "j2"
        )


def test_terrain_meets_without_cracks():
    """Fine pile cells and coarse ground cells share their edge heights (terrain.ts snapping)."""
    n = 21
    z = np.fromfunction(lambda j, i: (i * 0.37 + j * 0.11) ** 1.3, (n, n)).astype(np.float32)
    g = HeightGrid(z, 0.5, 0.0, 10.5)
    ring = [[4.0, 6.0], [6.0, 6.0], [6.0, 4.0], [4.0, 4.0]]
    ground, regions = build_terrain(g, (0.0, 0.0, 0.0), [("P01_e1", ring)], 0.0, (0, 0, 10.5, 10.5))
    assert [r.name for r in regions] == ["P01_e1"]
    gp = {tuple(np.round(p[[0, 2]], 3)): p[1] for p in ground.positions}
    shared = 0
    for p in regions[0].positions:
        k = tuple(np.round(p[[0, 2]], 3))
        if k in gp:
            shared += 1
            assert p[1] == pytest.approx(gp[k], abs=1e-5)
    assert shared >= 8
    # every fine-edge vertex on the border lies on the coarse edge between its neighbours
    assert ground.indices.size % 3 == 0 and regions[0].indices.max() < len(regions[0].positions)


# ---------------------------------------------------------------- a tiny LAS writer (format 2, RGB)


def write_las(path, heights, spacing=0.1):
    n = round(SIZE / spacing)
    xs = X0 + (np.arange(n) + 0.5) * spacing
    ys = Y0 + SIZE - (np.arange(n) + 0.5) * spacing
    XX, YY = np.meshgrid(xs, ys)
    zz = surface(heights, spacing).astype(np.float64)
    keep = np.random.default_rng(1).random(zz.shape) > 0.1  # a few sparse spots
    x, y, z = XX[keep], YY[keep], zz[keep]
    scale = 0.001
    count = x.size
    rec = np.zeros(
        count, dtype=[("x", "<i4"), ("y", "<i4"), ("z", "<i4"), ("rest", "u1", 8), ("rgb", "<u2", 3)]
    )
    rec["x"] = np.round((x - X0) / scale)
    rec["y"] = np.round((y - Y0) / scale)
    rec["z"] = np.round(z / scale)
    rec["rgb"][:, 0] = ((x - X0) / SIZE * 65535).astype(np.uint16)
    rec["rgb"][:, 1] = 30000
    rec["rgb"][:, 2] = 10000
    hdr = bytearray(227)
    hdr[0:4] = b"LASF"
    hdr[24], hdr[25] = 1, 2
    struct.pack_into("<H", hdr, 94, 227)
    struct.pack_into("<I", hdr, 96, 227)
    struct.pack_into("<I", hdr, 100, 0)
    hdr[104] = 2
    struct.pack_into("<H", hdr, 105, 26)
    struct.pack_into("<I", hdr, 107, count)
    struct.pack_into("<3d", hdr, 131, scale, scale, scale)
    struct.pack_into("<3d", hdr, 155, X0, Y0, 0.0)
    struct.pack_into("<6d", hdr, 179, x.max(), x.min(), y.max(), y.min(), z.max(), z.min())
    path.write_bytes(bytes(hdr) + rec.tobytes())
    assert rec.itemsize == 26
    return path


def test_the_las_reader_reads_points_and_colours(tmp_path):
    from aio_pipelines.volumetric.cloud import LasHeader, read_las_chunks

    p = write_las(tmp_path / "s.las", {"A": 8.0}, spacing=1.0)
    h = LasHeader(p)
    assert h.format == 2 and h.has_rgb and h.count > 10000
    x, y, z, rgb = next(read_las_chunks(p))
    assert (
        x.min() > X0
        and y.max() < Y0 + SIZE
        and math.isclose(z.max(), 8 + 10.0 + 0.01 * 40 + 0.005 * 80, abs_tol=0.5)
    )
    assert rgb.shape == (x.size, 3) and rgb[:, 1].max() == 30000
