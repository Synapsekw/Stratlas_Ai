"""pointcloud.to_copc on a Bentley .zpc (a ZIP of LAS/LAZ tiles), synthetic."""

import json
import struct
import subprocess
import threading
import zipfile

import pytest

import bentley_synth as bs
from aio_pipelines import zpc
from aio_pipelines.pointcloud import PointcloudToCopc, find_pdal, pdal_env
from aio_pipelines.runtime import Cancelled, Job, JobError
from conftest import Recorder, run_job

PDAL = find_pdal()


def project(tmp_path):
    return bs.make_project(tmp_path / "proj")


def test_validate_takes_a_zpc_and_names_the_cloud_after_it(tmp_path):
    p = PointcloudToCopc().validate({"src": str(tmp_path / "Mast cloud.zpc")})
    assert p["out"] == "clouds/mast-cloud.copc.laz"


def test_validate_takes_a_survey_day_and_refuses_another_form(tmp_path):
    src = str(tmp_path / "c.zpc")
    p = PointcloudToCopc().validate({"src": src, "surveyDate": "2026-03-04"})
    assert p["surveyDate"] == "2026-03-04"
    assert "surveyDate" not in PointcloudToCopc().validate({"src": src})
    for bad in ("4 March", "2026-3-4", "2026-02-30", 20260304):
        with pytest.raises(JobError, match="surveyDate must be a day as YYYY-MM-DD"):
            PointcloudToCopc().validate({"src": src, "surveyDate": bad})


def test_register_files_the_cloud_under_the_day_once(tmp_path, monkeypatch):
    from aio_pipelines import pointcloud as pc

    z = bs.make_zpc(tmp_path / "c.zpc", tiles=1)
    monkeypatch.setattr(pc, "find_pdal", lambda: "pdal")

    def convert(ctx, pdal, src, epsg):
        ctx.stage("cloud.copc.laz").write_bytes(b"copc")
        return {"points": 500, "bytes": 4, "tiles": 1}

    monkeypatch.setattr(pc, "convert_zpc", convert)
    root = project(tmp_path)
    params = {"src": z["zpc"], "epsg": bs.EPSG, "surveyDate": "2026-03-04"}
    first, _ = run_job(PointcloudToCopc(), root, params, job_id="j1")
    second, _ = run_job(PointcloudToCopc(), root, params, job_id="j2")
    assert first["status"] == "done" and second["status"] == "done", (first, second)
    m = json.loads((root / "manifest.json").read_text())
    (layer,) = m["layers"]
    assert m["captures"] == [{"id": "capture-2026-03-04", "label": "Survey", "date": "2026-03-04"}]
    assert layer["capture"] == "capture-2026-03-04"

    # an existing capture of that day is reused, not duplicated
    other = bs.make_project(tmp_path / "other")
    m = json.loads((other / "manifest.json").read_text())
    m["captures"] = [{"id": "flight", "label": "Flight", "date": "2026-03-04"}]
    (other / "manifest.json").write_text(json.dumps(m), "utf-8")
    result, _ = run_job(PointcloudToCopc(), other, params)
    assert result["status"] == "done", result
    m = json.loads((other / "manifest.json").read_text())
    assert [c["id"] for c in m["captures"]] == ["flight"]
    assert m["layers"][0]["capture"] == "flight"


def test_only_las_and_laz_members_are_tiles(tmp_path):
    z = bs.make_zpc(tmp_path / "c.zpc", extra={"metadata.xml": b"<x/>", "Tile_3.LAZ": b"LASF"})
    ignored: list[str] = []
    names = [t.name for t in zpc.list_tiles(tmp_path / "c.zpc", ignored)]
    assert names == ["Tile_1.las", "Tile_2.las", "Tile_3.LAZ"] and z["points"] == 1000
    assert ignored == ["metadata.xml"]


def test_the_job_logs_the_files_it_ignores(tmp_path, monkeypatch):
    from aio_pipelines import pointcloud as pc

    extra = {f"report-{i}.txt": b"x" for i in range(7)}
    bs.make_zpc(tmp_path / "c.zpc", tiles=1, extra=extra)
    monkeypatch.setattr(pc, "find_pdal", lambda: "pdal")

    def stop(ctx, pdal, path):
        raise JobError("stop here")

    monkeypatch.setattr(pc, "read_summary", stop)
    rec = Recorder()
    job = Job(
        "j1", PointcloudToCopc(), project(tmp_path), {"src": str(tmp_path / "c.zpc")}, rec, threading.Event()
    )
    with pytest.raises(JobError):
        job.run()
    logs = [p["message"] for p in rec.of("log")]
    shown = ", ".join(f"report-{i}.txt" for i in range(5))
    assert f"Ignored 7 other file(s) in c.zpc: {shown} and 2 more" in logs


def test_a_tile_in_an_unknown_compression_fails_with_its_name(tmp_path):
    bs.make_zpc(tmp_path / "c.zpc", tiles=1)
    data = bytearray((tmp_path / "c.zpc").read_bytes())
    # the compression method of the local header (offset 8) and the central directory entry (10)
    struct.pack_into("<H", data, 8, 99)
    struct.pack_into("<H", data, data.find(b"PK\x01\x02") + 10, 99)
    (tmp_path / "c.zpc").write_bytes(bytes(data))
    tiles = zpc.list_tiles(tmp_path / "c.zpc")
    with pytest.raises(JobError, match=r"Tile_1\.las of c\.zpc could not be unpacked"):
        zpc.extract_tiles(FakeCtx(), tmp_path / "c.zpc", tiles, tmp_path / "out", (0.0, 1.0))


class FakeCtx:
    def check(self):
        pass

    def progress(self, fraction, message=None):
        pass


@pytest.mark.parametrize("bad", ["../evil.las", "/abs/evil.las", "C:/evil.las", "a/../../evil.laz"])
def test_an_unsafe_member_name_refuses_the_whole_file(tmp_path, bad):
    bs.make_zpc(tmp_path / "c.zpc", extra={bad: b"LASF"})
    with pytest.raises(JobError, match="unsafe name"):
        zpc.list_tiles(tmp_path / "c.zpc")


def test_not_a_zip_and_no_tiles_are_refused_in_words(tmp_path):
    (tmp_path / "x.zpc").write_bytes(b"not a zip")
    with pytest.raises(JobError, match="not a ZIP"):
        zpc.list_tiles(tmp_path / "x.zpc")
    with zipfile.ZipFile(tmp_path / "y.zpc", "w") as f:
        f.writestr("readme.txt", "x")
    with pytest.raises(JobError, match="no LAS or LAZ tiles"):
        zpc.list_tiles(tmp_path / "y.zpc")


def test_a_cancel_while_unpacking_leaves_no_tiles(tmp_path, monkeypatch):
    from aio_pipelines import pointcloud as pc

    bs.make_zpc(tmp_path / "c.zpc", tiles=2, points=20_000)
    monkeypatch.setattr(pc, "find_pdal", lambda: "pdal")
    cancel = threading.Event()
    real = zpc.extract_tiles

    def cancelling(ctx, *a, **k):
        cancel.set()
        return real(ctx, *a, **k)

    monkeypatch.setattr(zpc, "extract_tiles", cancelling)
    root = project(tmp_path)
    with pytest.raises(Cancelled):
        run_job(PointcloudToCopc(), root, {"src": str(tmp_path / "c.zpc"), "epsg": bs.EPSG}, cancel=cancel)
    staging = next((root / "jobs").glob("*/staging"))
    assert not list(staging.rglob("tile-*"))


def test_a_corrupt_tile_fails_with_its_name_and_adds_no_layer(tmp_path, monkeypatch):
    from aio_pipelines import pointcloud as pc

    bs.make_zpc(tmp_path / "c.zpc", tiles=2)
    monkeypatch.setattr(pc, "find_pdal", lambda: "pdal")

    def summary(ctx, pdal, path):
        if path.name == "tile-002.las":
            raise JobError("PDAL could not finish reading the cloud: bad header")
        return {"num_points": 500, "srs": {}}

    monkeypatch.setattr(pc, "read_summary", summary)
    root = project(tmp_path)
    with pytest.raises(JobError, match=r"Tile_2\.las"):
        run_job(PointcloudToCopc(), root, {"src": str(tmp_path / "c.zpc"), "epsg": bs.EPSG})
    assert json.loads((root / "manifest.json").read_text())["layers"] == []
    assert not list((root / "jobs").rglob("tile-*"))


def test_tiles_in_different_crss_are_refused(tmp_path, monkeypatch):
    from aio_pipelines import pointcloud as pc

    bs.make_zpc(tmp_path / "c.zpc", tiles=2)
    monkeypatch.setattr(pc, "find_pdal", lambda: "pdal")
    srs = {"tile-001.las": {"json": {"id": {"authority": "EPSG", "code": 32639}}},
           "tile-002.las": {"json": {"id": {"authority": "EPSG", "code": 32640}}}}  # fmt: skip
    monkeypatch.setattr(pc, "read_summary", lambda ctx, pdal, p: {"num_points": 500, "srs": srs[p.name]})
    root = project(tmp_path)
    with pytest.raises(JobError, match="different CRSs"):
        run_job(PointcloudToCopc(), root, {"src": str(tmp_path / "c.zpc"), "epsg": bs.EPSG})
    assert not list((root / "jobs").rglob("tile-*"))


@pytest.mark.skipif(PDAL is None, reason="PDAL not found (set AIO_PDAL)")
def test_a_two_tile_zpc_becomes_one_cloud_with_every_point(tmp_path):
    z = bs.make_zpc(tmp_path / "Mast cloud.zpc", tiles=2, points=4000)
    root = project(tmp_path)
    result, _ = run_job(PointcloudToCopc(), root, {"src": z["zpc"], "epsg": bs.EPSG})
    assert result["status"] == "done", result
    out = root / "clouds" / "mast-cloud.copc.laz"
    info = json.loads(
        subprocess.run(
            [PDAL, "info", "--summary", str(out)], capture_output=True, check=True, env=pdal_env(PDAL)
        ).stdout
    )["summary"]
    assert info["num_points"] == z["points"]
    xmin, ymin, xmax, ymax = z["bounds"]
    assert info["bounds"]["minx"] >= xmin - 0.01 and info["bounds"]["maxx"] <= xmax + 0.01
    assert info["bounds"]["maxx"] - info["bounds"]["minx"] > 15  # both tiles
    (layer,) = json.loads((root / "manifest.json").read_text())["layers"]
    assert layer["name"] == "Mast cloud.zpc" and layer["pointCount"] == z["points"] and "capture" not in layer
    assert not list((root / "jobs").rglob("tile-*"))
