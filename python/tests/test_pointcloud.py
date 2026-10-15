import json
import re
import subprocess
import sys
import threading
import time

import pytest

from aio_pipelines.pointcloud import (
    PDAL_MISSING,
    PointcloudToCopc,
    find_pdal,
    las_record_length,
    pdal_env,
    source_epsg,
    written_share,
)
from aio_pipelines.pointcloud import _run as pc_run
from aio_pipelines.runtime import Cancelled, JobError
from conftest import run_job

PDAL = find_pdal()
needs_pdal = pytest.mark.skipif(PDAL is None, reason="PDAL not found (set AIO_PDAL)")


def small_laz(path, epsg=32639):
    """A 200-point LAZ in UTM 39N, written by PDAL from a text file (synthetic)."""
    txt = path.with_suffix(".txt")
    rows = ["X,Y,Z,Intensity"] + [
        f"{245700 + (i % 20) * 0.5},{3179600 + (i // 20) * 0.5},{10 + (i % 7) * 0.1},{i % 255}"
        for i in range(200)
    ]
    txt.write_text("\n".join(rows) + "\n")
    pipe = path.with_suffix(".json")
    pipe.write_text(
        json.dumps(
            {
                "pipeline": [
                    {"type": "readers.text", "filename": str(txt)},
                    {
                        "type": "writers.las",
                        "filename": str(path),
                        "compression": "laszip",
                        "a_srs": f"EPSG:{epsg}",
                    },
                ]
            }
        )
    )
    subprocess.run([PDAL, "pipeline", str(pipe)], check=True, capture_output=True)
    return path


def project(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    (root / "manifest.json").write_text(json.dumps({"schema": "aio.project/1", "id": "p", "layers": []}))
    return root


def test_validate_names_the_output_and_refuses_other_files():
    p = PointcloudToCopc()
    assert p.validate({"src": "D:/scans/Site A.laz", "epsg": 32639}) == {
        "src": "D:/scans/Site A.laz",
        "out": "clouds/site-a.copc.laz",
        "epsg": 32639,
    }
    with pytest.raises(JobError, match="LAS, LAZ"):
        p.validate({"src": "D:/scans/site.txt"})
    with pytest.raises(JobError, match=r"copc.laz"):
        p.validate({"src": "a.laz", "out": "clouds/a.las"})


def test_without_pdal_the_job_says_what_is_missing(tmp_path, monkeypatch):
    import aio_pipelines.pointcloud as pc

    monkeypatch.setattr(pc, "find_pdal", lambda: None)
    root = project(tmp_path)
    (tmp_path / "a.laz").write_bytes(b"x")
    with pytest.raises(JobError) as e:
        run_job(PointcloudToCopc(), root, {"src": str(tmp_path / "a.laz")})
    assert str(e.value) == PDAL_MISSING


@needs_pdal
def test_converts_a_laz_to_copc_and_adds_the_layer(tmp_path):
    laz = small_laz(tmp_path / "site.laz")
    root = project(tmp_path)
    result, rec = run_job(PointcloudToCopc(), root, {"src": str(laz), "epsg": 32639})
    assert result["status"] == "done"
    out = root / "clouds" / "site.copc.laz"
    assert out.is_file() and out.stat().st_size > 0
    info = json.loads(
        subprocess.run([PDAL, "info", "--summary", str(out)], capture_output=True, check=True).stdout
    )
    assert info["summary"]["num_points"] == 200
    manifest = json.loads((root / "manifest.json").read_text())
    assert manifest["layers"] == [
        {
            "kind": "pointcloud",
            "id": "cloud-site",
            "name": "site.laz",
            "visible": True,
            "src": {"path": "clouds/site.copc.laz"},
            "format": "copc",
            "pointCount": 200,
        }
    ]
    assert (root / "manifest.json.bak").is_file()
    assert {"jobId": "j1", "path": "clouds/site.copc.laz", "kind": "file"} in rec.of("artifact")

    # a second run with another id adds no duplicate layer
    run_job(PointcloudToCopc(), root, {"src": str(laz), "epsg": 32639}, job_id="j2")
    assert len(json.loads((root / "manifest.json").read_text())["layers"]) == 1


def test_a_conda_style_pdal_runs_with_its_own_proj_and_gdal_data(tmp_path, monkeypatch):
    monkeypatch.delenv("PROJ_DATA", raising=False)
    monkeypatch.delenv("GDAL_DATA", raising=False)
    exe = tmp_path / "pdal" / "Library" / "bin" / "pdal.exe"
    exe.parent.mkdir(parents=True)
    exe.write_bytes(b"")
    plain = pdal_env(str(exe))
    assert "PROJ_DATA" not in plain and "GDAL_DATA" not in plain
    share = tmp_path / "pdal" / "Library" / "share"
    (share / "proj").mkdir(parents=True)
    (share / "proj" / "proj.db").write_bytes(b"")
    (share / "gdal").mkdir()
    env = pdal_env(str(exe))
    assert env["PROJ_DATA"] == str((share / "proj").resolve())
    assert env["GDAL_DATA"] == str((share / "gdal").resolve())
    assert env["PROJ_NETWORK"] == "OFF"


# ---------------------------------------------------------------- the shared COPC writer (untwine)

UTM39 = {
    "wkt": 'PROJCS["WGS 84 / UTM zone 39N",AUTHORITY["EPSG","32639"]]',
    "horizontal": 'PROJCS["WGS 84 / UTM zone 39N",AUTHORITY["EPSG","32639"]]',
    "json": {"type": "ProjectedCRS", "id": {"authority": "EPSG", "code": 32639}},
}
WGS84 = {
    "wkt": 'GEOGCS["WGS 84",AUTHORITY["EPSG","4326"]]',
    "json": {"id": {"authority": "EPSG", "code": 4326}},
}


def test_the_source_epsg_comes_from_the_header_crs():
    assert source_epsg(UTM39) == 32639
    compound = {
        "wkt": "COMPD_CS[...]",
        "json": {
            "type": "CompoundCRS",
            "components": [
                {"type": "ProjectedCRS", "id": {"authority": "EPSG", "code": 32640}},
                {"type": "VerticalCRS", "id": {"authority": "EPSG", "code": 5773}},
            ],
        },
    }
    assert source_epsg(compound) == 32640
    # without PROJJSON the horizontal WKT's own authority counts, not an inner one
    wkt1 = 'PROJCS["x",GEOGCS["y",AUTHORITY["EPSG","4326"]],AUTHORITY["EPSG","2056"]]'
    assert source_epsg({"horizontal": wkt1}) == 2056
    assert source_epsg({"wkt": 'PROJCRS["x",ID["EPSG",3857]]'}) == 3857
    assert source_epsg({"wkt": 'LOCAL_CS["arbitrary"]'}) is None
    assert source_epsg({}) is None


class FakeWriter:
    """Stands in for photo.cloud_out.write_copc: records its call, reports progress, writes out."""

    def __init__(self, fractions=(0.5,), printed=True):
        self.calls = []
        self.fractions = fractions
        self.printed = printed  # untwine prints its percentage to tool.out; PDAL prints none

    def __call__(self, ctx, las, out, points, epsg, temp, budget, progress=(0.3, 0.95)):
        self.calls.append(
            {"las": las, "out": out, "points": points, "epsg": epsg, "budget": budget, "progress": progress}
        )
        lo, hi = progress
        temp.mkdir(parents=True, exist_ok=True)
        for f in self.fractions:
            if self.printed:
                with open(temp / "tool.out", "a") as log:
                    log.write(f"Untwine progress ({round(f * 100)}% done)\n")
            ctx.progress(lo + (hi - lo) * f, "Building the COPC (untwine)")
            time.sleep(0.25)  # past the progress throttle and a watcher sample
        out.write_bytes(b"copc")
        return "untwine"


def fake_cloud(tmp_path, monkeypatch, srs, points=1000, untwine=True, writer=None, name="site.laz"):
    """A cloud file with PDAL's summary, the COPC writer and untwine stubbed.
    Gives (src, writer, prepared): ``prepared`` records each reprojection or copy to LAS."""
    import aio_pipelines.pointcloud as pc
    from aio_pipelines.photo import cloud_out, native

    src = tmp_path / name
    src.write_bytes(b"LASF")
    monkeypatch.setattr(pc, "find_pdal", lambda: "pdal")
    monkeypatch.setattr(pc, "read_summary", lambda ctx, pdal, path: {"num_points": points, "srs": srs})
    prepared = []

    def prepare(ctx, pdal, s, dst, epsg, n, band):
        prepared.append({"src": s, "dst": dst, "epsg": epsg, "points": n})
        dst.write_bytes(b"LASF")

    monkeypatch.setattr(pc, "prepare_las", prepare)
    writer = writer or FakeWriter()
    monkeypatch.setattr(cloud_out, "write_copc", writer)
    monkeypatch.setattr(native, "find_tool", lambda tool: "untwine" if untwine else None)
    monkeypatch.setattr(native, "memory_budget", lambda: 8 * 1024**3)
    return src, writer, prepared


def test_a_cloud_already_in_the_project_crs_goes_straight_to_the_copc_writer(tmp_path, monkeypatch):
    src, writer, prepared = fake_cloud(tmp_path, monkeypatch, UTM39)
    root = project(tmp_path)
    result, _ = run_job(PointcloudToCopc(), root, {"src": str(src), "epsg": 32639})
    assert result["status"] == "done"
    assert prepared == []  # no reprojection, no copy
    (call,) = writer.calls
    assert call["las"] == src
    assert call["out"].name == "cloud.copc.laz" and call["out"].parent.name == "staging"
    assert call["points"] == 1000 and call["epsg"] == 32639 and call["budget"] == 8 * 1024**3
    assert (root / "clouds" / "site.copc.laz").read_bytes() == b"copc"
    assert json.loads((root / "manifest.json").read_text())["layers"][0]["pointCount"] == 1000


def test_a_cloud_in_another_crs_is_reprojected_first_then_written(tmp_path, monkeypatch):
    src, writer, prepared = fake_cloud(tmp_path, monkeypatch, WGS84)
    root = project(tmp_path)
    result, _ = run_job(PointcloudToCopc(), root, {"src": str(src), "epsg": 32639})
    assert result["status"] == "done"
    (prep,) = prepared
    assert prep["src"] == src and prep["epsg"] == 32639 and prep["points"] == 1000
    (call,) = writer.calls
    assert call["las"] == prep["dst"] and call["epsg"] == 32639
    assert not prep["dst"].exists()  # the reprojected copy goes once the COPC is written


def test_a_cloud_without_a_crs_or_without_a_target_is_not_reprojected(tmp_path, monkeypatch):
    src, writer, prepared = fake_cloud(tmp_path, monkeypatch, {})
    root = project(tmp_path)
    run_job(PointcloudToCopc(), root, {"src": str(src), "epsg": 32639})
    assert prepared == [] and writer.calls[0]["las"] == src and writer.calls[0]["epsg"] == 32639
    src2, writer2, prepared2 = fake_cloud(tmp_path, monkeypatch, WGS84)
    run_job(PointcloudToCopc(), root, {"src": str(src2)}, job_id="j2")
    assert prepared2 == [] and writer2.calls[0]["epsg"] is None


def test_an_e57_is_copied_to_las_first_without_reprojection(tmp_path, monkeypatch):
    src, writer, prepared = fake_cloud(tmp_path, monkeypatch, UTM39, name="scan.e57")
    root = project(tmp_path)
    run_job(PointcloudToCopc(), root, {"src": str(src), "epsg": 32639})
    (prep,) = prepared
    assert prep["src"] == src and prep["epsg"] is None
    assert writer.calls[0]["las"] == prep["dst"]


@pytest.mark.parametrize("error", [JobError("untwine failed: disk error"), Cancelled()])
def test_the_intermediate_las_goes_when_the_build_fails_or_is_cancelled(tmp_path, monkeypatch, error):
    def failing_writer(ctx, las, out, points, epsg, temp, budget, progress=(0.3, 0.95)):
        assert las.is_file()
        raise error

    src, _, prepared = fake_cloud(tmp_path, monkeypatch, WGS84, writer=failing_writer)
    root = project(tmp_path)
    with pytest.raises(type(error)):
        run_job(PointcloudToCopc(), root, {"src": str(src), "epsg": 32639})
    (prep,) = prepared
    assert not prep["dst"].exists()


def test_disk_needed_counts_the_las_untwine_and_the_copc():
    from aio_pipelines.pointcloud import COPC_BYTES_PER_POINT, UNTWINE_TEMP_BYTES_PER_POINT, disk_needed

    per = UNTWINE_TEMP_BYTES_PER_POINT + COPC_BYTES_PER_POINT
    assert disk_needed(1000, 36) == 1000 * (36 + per)
    assert disk_needed(1000, None) == 1000 * per
    # the 243 M point case reprojected: well over 30 GB
    assert disk_needed(243_537_742, 36) > 30 * 1024**3


def test_a_full_drive_is_refused_before_any_work_with_both_numbers(tmp_path, monkeypatch):
    import shutil
    from collections import namedtuple

    usage = namedtuple("usage", "total used free")
    monkeypatch.setattr(shutil, "disk_usage", lambda p: usage(100 * 1024**3, 99 * 1024**3, 1024**3))
    src, writer, prepared = fake_cloud(tmp_path, monkeypatch, WGS84, points=243_537_742)
    root = project(tmp_path)
    with pytest.raises(JobError) as e:
        run_job(PointcloudToCopc(), root, {"src": str(src), "epsg": 32639})
    msg = str(e.value)
    assert msg.startswith("Importing this point cloud needs about ")
    assert "which has 1.0 GB" in msg and "Creating these products" not in msg
    assert prepared == [] and writer.calls == []


def test_without_untwine_a_too_large_cloud_is_refused_in_import_words(tmp_path, monkeypatch):
    import shutil
    from collections import namedtuple

    from aio_pipelines.photo.cloud_out import write_copc
    from aio_pipelines.pointcloud import TOO_BIG_WITHOUT_UNTWINE

    usage = namedtuple("usage", "total used free")
    monkeypatch.setattr(shutil, "disk_usage", lambda p: usage(10 * 1024**4, 0, 10 * 1024**4))
    src, _, _ = fake_cloud(
        tmp_path, monkeypatch, UTM39, points=1_000_000_000, untwine=False, writer=write_copc
    )
    root = project(tmp_path)
    with pytest.raises(JobError) as e:
        run_job(PointcloudToCopc(), root, {"src": str(src), "epsg": 32639})
    assert str(e.value) == TOO_BIG_WITHOUT_UNTWINE


def running(rec):
    return [p for p in rec.of("progress") if p.get("step") == "convert" and p.get("state") == "running"]


def test_the_writers_own_progress_reaches_the_job(tmp_path, monkeypatch):
    import aio_pipelines.pointcloud as pc

    monkeypatch.setattr(pc, "WATCH_EVERY_S", 0.05)
    src, writer, _ = fake_cloud(tmp_path, monkeypatch, UTM39, writer=FakeWriter(fractions=(0.42,)))
    root = project(tmp_path)
    _, rec = run_job(PointcloudToCopc(), root, {"src": str(src), "epsg": 32639})
    lo, hi = writer.calls[0]["progress"]
    hit = [p for p in running(rec) if p["stepFraction"] == round(lo + (hi - lo) * 0.42, 4)]
    assert hit, running(rec)
    assert hit[0]["message"].startswith("Building the viewable cloud: ")
    for p in running(rec):
        assert "–" not in p.get("message", "") and "—" not in p.get("message", "")


def test_without_untwine_the_bar_holds_and_the_text_counts_the_time(tmp_path, monkeypatch):
    import aio_pipelines.pointcloud as pc

    monkeypatch.setattr(pc, "WATCH_EVERY_S", 0.05)
    src, writer, _ = fake_cloud(
        tmp_path,
        monkeypatch,
        UTM39,
        untwine=False,
        writer=FakeWriter(fractions=(0.3, 0.6, 0.9), printed=False),
    )
    root = project(tmp_path)
    _, rec = run_job(PointcloudToCopc(), root, {"src": str(src), "epsg": 32639})
    lo, _ = writer.calls[0]["progress"]
    building = [p for p in running(rec) if p.get("message", "").startswith("Building the viewable cloud")]
    # the writer's own (timer) fractions never move the bar: only real knowledge does
    assert len(building) >= 2 and all(p["stepFraction"] == round(lo, 4) for p in building)
    assert re.fullmatch(r"Building the viewable cloud: \d+ s, still working", building[-1]["message"])


def test_cancel_stops_the_copc_tool(tmp_path, monkeypatch):
    """The job's cancel event still reaches the tool write_copc runs, and kills it."""
    from aio_pipelines.photo import native

    cancel = threading.Event()

    def sleeping_writer(ctx, las, out, points, epsg, temp, budget, progress=(0.3, 0.95)):
        threading.Timer(0.5, cancel.set).start()
        native.run_tool(ctx, [sys.executable, "-c", "import time; time.sleep(60)"], "Building", temp)
        return "untwine"

    src, _, _ = fake_cloud(tmp_path, monkeypatch, UTM39, writer=sleeping_writer)
    root = project(tmp_path)
    t0 = time.monotonic()
    with pytest.raises(Cancelled):
        run_job(PointcloudToCopc(), root, {"src": str(src), "epsg": 32639}, cancel=cancel)
    assert time.monotonic() - t0 < 20


class BareCtx:
    def __init__(self, folder):
        self.job = type("J", (), {"dir": folder})()
        self.cancel_event = threading.Event()
        self.seen = []

    def progress(self, f, m=None):
        self.seen.append((f, m))

    def check(self):
        if self.cancel_event.is_set():
            raise Cancelled()


def test_pdal_runs_cancellably_and_reports_the_time_not_a_made_up_percentage(tmp_path):
    ctx = BareCtx(tmp_path)
    threading.Timer(1.5, ctx.cancel_event.set).start()
    t0 = time.monotonic()
    with pytest.raises(Cancelled):
        pc_run(
            ctx, [sys.executable, "-c", "import time; time.sleep(60)"], "Reprojecting the cloud", (0.1, 0.4)
        )
    assert time.monotonic() - t0 < 20
    assert ctx.seen and all(f == 0.1 for f, _ in ctx.seen)
    assert ctx.seen[-1][1].startswith("Reprojecting the cloud, ") and ctx.seen[-1][1].endswith("so far")


def test_a_measured_pdal_run_reports_the_measure(tmp_path):
    ctx = BareCtx(tmp_path)
    shares = iter([0.2, 0.5] + [0.6] * 1000)
    pc_run(ctx, [sys.executable, "-c", "import time; time.sleep(0.6)"], "Reprojecting the cloud", (0.1, 0.5),
           measure=lambda: next(shares))  # fmt: skip
    fractions = [f for f, _ in ctx.seen]
    assert fractions[0] == pytest.approx(0.1 + 0.4 * 0.2)
    assert max(fractions) == pytest.approx(0.1 + 0.4 * 0.6)


def test_the_reprojection_progress_is_the_share_of_points_written(tmp_path):
    header = bytearray(375)
    header[0:4] = b"LASF"
    header[104] = 0x80 | 7  # a compressed point format 7
    header[105:107] = (36).to_bytes(2, "little")
    src = tmp_path / "a.laz"
    src.write_bytes(bytes(header))
    assert las_record_length(src) == 36
    assert las_record_length(tmp_path / "missing.laz") is None
    (tmp_path / "x.e57").write_bytes(b"ASTM-E57")
    assert las_record_length(tmp_path / "x.e57") is None
    dst = tmp_path / "b.las"
    measure = written_share(dst, 1000, 36)
    assert measure() == 0.0
    dst.write_bytes(b"\0" * (375 + 18000))
    assert measure() == pytest.approx(0.5, abs=0.02)
    dst.write_bytes(b"\0" * (375 + 72000))
    assert measure() == 0.99


@needs_pdal
def test_a_cloud_in_another_crs_lands_in_the_project_crs(tmp_path):
    laz = small_laz(tmp_path / "site.laz", epsg=32639)
    root = project(tmp_path)
    result, _ = run_job(PointcloudToCopc(), root, {"src": str(laz), "epsg": 32640})
    assert result["status"] == "done"
    out = root / "clouds" / "site.copc.laz"
    info = json.loads(
        subprocess.run([PDAL, "info", "--summary", str(out)], capture_output=True, check=True).stdout
    )["summary"]
    assert info["num_points"] == 200
    assert info["srs"]["json"]["id"]["code"] == 32640
    # UTM 39N easting 245700 lies far west of zone 40's central meridian
    assert info["bounds"]["maxx"] < 0
    assert not list((root / "jobs").rglob("source.las"))


# ------------------------------------------------------------ the build's honest "still working"


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def watch(tmp_path, monkeypatch, stall=None, cpu=None):
    """A build watch over ``tmp_path/staging`` on a fake clock, no thread (``tick`` by hand)."""
    import aio_pipelines.pointcloud as pc

    if stall is not None:
        monkeypatch.setattr(pc, "STALL_S", stall)
    staging = tmp_path / "staging"
    (staging / "copc-work").mkdir(parents=True, exist_ok=True)
    ctx, clock = BareCtx(tmp_path), Clock()
    w = pc.BuildWatch(
        ctx, (0.35, 0.99), staging, staging / "copc-work" / "tool.out", clock=clock, cpu=cpu or (lambda: None)
    )
    return w, ctx, clock, staging


def test_the_build_text_counts_the_time_and_says_still_working_while_files_grow(tmp_path, monkeypatch):
    w, ctx, clock, staging = watch(tmp_path, monkeypatch)
    w.tick()
    assert ctx.seen[-1] == (0.35, "Building the viewable cloud: 0 s, still working")
    for minute in range(1, 7):
        clock.now += 60
        (staging / "copc-work" / f"bucket{minute}").write_bytes(b"x" * minute)
        w.tick()
    assert ctx.seen[-1] == (0.35, "Building the viewable cloud: 6 min, still working")
    clock.now += 3600
    (staging / "copc-work" / "bucket1").write_bytes(b"y" * 100)
    w.tick()
    assert ctx.seen[-1][1] == "Building the viewable cloud: 1 h 06 min, still working"
    for _, m in ctx.seen:
        assert "–" not in m and "—" not in m


def test_the_build_text_says_no_activity_when_nothing_moves(tmp_path, monkeypatch):
    w, ctx, clock, staging = watch(tmp_path, monkeypatch, stall=120)
    w.tick()
    clock.now += 100
    w.tick()
    assert ctx.seen[-1][1] == "Building the viewable cloud: 1 min, still working"
    clock.now += 740  # 14 min in, nothing written since the start
    w.tick()
    assert ctx.seen[-1][1] == "Building the viewable cloud: 14 min, no activity for 14 min"
    (staging / "cloud.copc.laz").write_bytes(b"copc")  # the writer moves again
    clock.now += 5
    w.tick()
    assert ctx.seen[-1][1] == "Building the viewable cloud: 14 min, still working"


def test_child_cpu_time_counts_as_activity(tmp_path, monkeypatch):
    cpu = iter([1.0, 2.5, 4.0, 4.0, 4.0, 4.0])
    w, ctx, clock, _ = watch(tmp_path, monkeypatch, stall=60, cpu=lambda: next(cpu))
    w.tick()
    for _ in range(3):
        clock.now += 50
        w.tick()
    assert ctx.seen[-1][1].endswith("still working")  # the CPU time kept rising
    clock.now += 70
    w.tick()
    assert ctx.seen[-1][1].endswith("no activity for 2 min")


def test_the_bar_follows_only_the_writers_real_percentage_and_never_steps_back(tmp_path, monkeypatch):
    w, ctx, clock, staging = watch(tmp_path, monkeypatch)
    for _ in range(5):  # time alone moves nothing
        clock.now += 600
        w.tick()
    assert {f for f, _ in ctx.seen} == {0.35}
    log = staging / "copc-work" / "tool.out"
    log.write_text("Untwine progress (41% done)\nUntwine progress (50% done)\n")
    w.tick()
    assert ctx.seen[-1][0] == pytest.approx(0.35 + 0.64 * 0.5)
    log.write_text("Untwine progress (10% done)\n")  # a fresh run's file never pulls the bar back
    w.tick()
    assert ctx.seen[-1][0] == pytest.approx(0.35 + 0.64 * 0.5)
    fractions = [f for f, _ in ctx.seen]
    assert fractions == sorted(fractions)


def watch_threads():
    from aio_pipelines.pointcloud import WATCH_THREAD

    return [t for t in threading.enumerate() if t.name == WATCH_THREAD and t.is_alive()]


@pytest.mark.parametrize("outcome", ["done", "failed", "cancelled"])
def test_the_watch_runs_during_the_build_and_is_gone_after_it(tmp_path, monkeypatch, outcome):
    import aio_pipelines.pointcloud as pc

    monkeypatch.setattr(pc, "WATCH_EVERY_S", 0.02)
    seen = []

    def writer(ctx, las, out, points, epsg, temp, budget, progress=(0.3, 0.95)):
        temp.mkdir(parents=True, exist_ok=True)
        for i in range(5):
            (temp / f"part{i}").write_bytes(b"x" * (i + 1))
            time.sleep(0.05)
        seen.append(len(watch_threads()))
        if outcome == "failed":
            raise JobError("untwine failed: disk error")
        if outcome == "cancelled":
            raise Cancelled()
        out.write_bytes(b"copc")
        return "untwine"

    src, _, _ = fake_cloud(tmp_path, monkeypatch, UTM39, writer=writer)
    root = project(tmp_path)
    if outcome == "done":
        _, rec = run_job(PointcloudToCopc(), root, {"src": str(src), "epsg": 32639})
        texts = [p.get("message", "") for p in running(rec)]
        assert any(re.fullmatch(r"Building the viewable cloud: \d+ s, still working", t) for t in texts)
    else:
        with pytest.raises(JobError if outcome == "failed" else Cancelled):
            run_job(PointcloudToCopc(), root, {"src": str(src), "epsg": 32639})
    assert seen == [1]
    assert watch_threads() == []


def test_pointcloud_imports_nothing_from_colmap_io():
    import ast
    from pathlib import Path

    import aio_pipelines.pointcloud as pc

    source = Path(pc.__file__).read_text("utf-8")
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            names = [node.module or ""] + [f"{node.module or ''}.{a.name}" for a in node.names]
            assert not any("colmap_io" in n for n in names), ast.dump(node)
        elif isinstance(node, ast.Import):
            assert not any("colmap_io" in a.name for a in node.names)
    assert "colmap_io" not in source


def test_without_the_cpu_read_the_watch_falls_back_to_file_activity(tmp_path, monkeypatch):
    import aio_pipelines.pointcloud as pc

    def broken():
        raise OSError("no kernel32 here")

    monkeypatch.setattr(pc, "_kernel32", broken)
    assert pc.children_cpu_seconds() is None
    w, ctx, clock, staging = watch(tmp_path, monkeypatch, stall=60, cpu=pc.children_cpu_seconds)
    w.tick()
    clock.now += 50
    (staging / "copc-work" / "part").write_bytes(b"x")
    w.tick()
    clock.now += 50
    w.tick()
    assert ctx.seen[-1][1].endswith("still working")
    clock.now += 20
    w.tick()
    assert ctx.seen[-1][1].endswith("no activity for 1 min")


@pytest.mark.skipif(sys.platform != "win32", reason="the CPU read is Windows only")
def test_a_busy_child_raises_the_cpu_time():
    from aio_pipelines.pointcloud import children_cpu_seconds

    # the child spins far longer than the test needs (it is killed at the end), and the second
    # reading is retried for a few seconds, so a slow or loaded machine still sees it rise
    child = subprocess.Popen(
        [sys.executable, "-c", "import time\nt = time.time()\nwhile time.time() - t < 30: pass"],
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    try:
        time.sleep(0.4)
        a = children_cpu_seconds()
        assert a is not None
        b = a
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            time.sleep(0.2)
            b = children_cpu_seconds()
            if b is not None and b > a:
                break
    finally:
        child.kill()
        child.wait(timeout=10)
    assert b is not None and b > a


def test_leaving_the_watch_does_not_wait_forever_for_a_stuck_sample(tmp_path, monkeypatch):
    import aio_pipelines.pointcloud as pc

    monkeypatch.setattr(pc, "WATCH_JOIN_S", 0.2)
    release = threading.Event()
    w, _, _, _ = watch(tmp_path, monkeypatch, cpu=lambda: release.wait(20) and None)
    left = threading.Event()

    def build():
        with w:
            time.sleep(0.2)  # the watch's first sample is stuck by now
        left.set()

    t = threading.Thread(target=build, daemon=True)
    t.start()
    try:
        assert left.wait(5), "leaving the watch waited for its stuck thread"
    finally:
        release.set()
        t.join(25)
