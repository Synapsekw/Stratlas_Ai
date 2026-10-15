"""photo/cloud_out.py: a LAS as a COPC through untwine or PDAL; and native.run_tool's progress
hook."""

from __future__ import annotations

import os
import sys
import threading
import time
from pathlib import Path

import numpy as np
import pytest

import products_synth as ps
from aio_pipelines.photo import cloud_out as C
from aio_pipelines.photo import native
from aio_pipelines.runtime import Job, JobError, Step, StepContext
from conftest import Recorder


def _ctx(tmp_path):
    rec = Recorder()
    job = Job("t1", None, tmp_path, {}, rec, threading.Event())  # type: ignore[arg-type]
    job.steps, job.weights = [Step("cloud", "Cloud", lambda c: None)], [1.0]
    return StepContext(job, 0, job.steps[0]), rec


def test_the_copc_command_lines():
    args = C.untwine_args("untwine", Path("a.las"), Path("b.copc.laz"), Path("t"), 32639)
    assert args == ["untwine", "-i", "a.las", "-o", "b.copc.laz", "--temp_dir", "t", "--progress_debug",
                    "--a_srs", "EPSG:32639"]  # fmt: skip
    assert "--a_srs" not in C.untwine_args("untwine", Path("a"), Path("b"), Path("t"), None)
    p = C.pdal_copc_pipeline(Path("a.las"), Path("b.copc.laz"), 32639)["pipeline"]
    assert [s["type"] for s in p] == ["readers.las", "writers.copc"]
    assert p[0]["override_srs"] == p[1]["a_srs"] == "EPSG:32639"


def test_untwine_progress_lines_are_read():
    assert C.untwine_progress("Untwine progress (45% done): Bulk processing") == pytest.approx(0.45)
    assert C.untwine_progress("Untwine progress (100% done): Done") == 1.0
    assert C.untwine_progress("Reading files") is None


FAKE_PROGRESS = r"""
import time
for p in (10, 50, 90):
    print(f"Untwine progress ({p}% done): Processing", flush=True)
    time.sleep(0.6)
"""


def test_a_tools_own_progress_lines_drive_the_bar(tmp_path):
    exe = ps.fake_tool(tmp_path, "untwine", FAKE_PROGRESS)
    ctx, rec = _ctx(tmp_path)
    native.run_tool(ctx, [str(exe)], "Building the COPC", tmp_path / "w", expected_s=3600,
                    progress=(0.3, 0.95), on_output=C.untwine_progress)  # fmt: skip
    got = [p["stepFraction"] for p in rec.of("progress") if p.get("message") == "Building the COPC"]
    assert any(abs(f - (0.3 + 0.65 * 0.5)) < 0.01 for f in got)
    assert max(got) == pytest.approx(0.3 + 0.65 * 0.9, abs=0.01)


LATE_PROGRESS = r"""
import time
time.sleep(1.5)
print("Untwine progress (10% done): Processing", flush=True)
time.sleep(0.6)
"""


def test_the_bar_never_steps_back_when_the_tool_reports_late(tmp_path):
    exe = ps.fake_tool(tmp_path, "untwine", LATE_PROGRESS)
    ctx, rec = _ctx(tmp_path)
    native.run_tool(ctx, [str(exe)], "Building the COPC", tmp_path / "w", expected_s=1,
                    progress=(0.3, 0.95), on_output=C.untwine_progress)  # fmt: skip
    got = [p["stepFraction"] for p in rec.of("progress") if p.get("message") == "Building the COPC"]
    assert got == sorted(got) and max(got) > 0.3 + 0.65 * 0.5  # the ramp passed 10 % and held


SURVIVOR = r"""
import sys, time
print("Untwine progress (10% done): Processing", flush=True)
time.sleep(2.5)
open(sys.argv[1], "w").write("still running")
"""


def test_a_hook_that_raises_stops_the_tool(tmp_path):
    exe = ps.fake_tool(tmp_path, "untwine", SURVIVOR)
    ctx, _ = _ctx(tmp_path)

    def broken(line: str) -> float | None:
        raise ValueError("bad line")

    with pytest.raises(ValueError, match="bad line"):
        native.run_tool(ctx, [str(exe), str(tmp_path / "alive")], "Building the COPC", tmp_path / "w",
                        on_output=broken)  # fmt: skip
    time.sleep(3.5)
    assert not (tmp_path / "alive").exists()


def test_untwine_is_found_by_its_variable_and_in_the_pack(tmp_path, monkeypatch):
    monkeypatch.delenv("AIO_UNTWINE", raising=False)
    sub = ("Library", "bin") if os.name == "nt" else ("bin",)
    exe = tmp_path / "tools" / "pdal" / Path(*sub) / ("untwine.exe" if os.name == "nt" else "untwine")
    exe.parent.mkdir(parents=True)
    exe.write_bytes(b"")
    monkeypatch.setattr(native.sys, "prefix", str(tmp_path / "python"))
    assert native.find_tool("untwine") == str(exe)
    monkeypatch.setenv("AIO_UNTWINE", str(tmp_path / "missing.exe"))
    assert native.find_tool("untwine") is None


FAKE_UNTWINE = r"""
import os, shutil, sys
args = sys.argv[1:]
open(os.environ["FAKE_UNTWINE_ARGS"], "w").write(" ".join(args))
print("Untwine progress (50% done): Bulk", flush=True)
shutil.copyfile(args[args.index("-i") + 1], args[args.index("-o") + 1])
"""

FAKE_PDAL = r"""
import json, shutil, sys
args = sys.argv[1:]
assert args[0] == "pipeline", args
stages = json.load(open(args[1]))["pipeline"]
assert [s["type"] for s in stages] == ["readers.las", "writers.copc"], stages
shutil.copyfile(stages[0]["filename"], stages[-1]["filename"])
"""


def _las(tmp_path) -> Path:
    las = tmp_path / "c.las"
    las.write_bytes(b"LASF" + b"\0" * 400)
    return las


def test_untwine_writes_the_copc_when_it_is_there(tmp_path, monkeypatch):
    monkeypatch.setenv("AIO_UNTWINE", str(ps.fake_tool(tmp_path / "tools", "untwine", FAKE_UNTWINE)))
    monkeypatch.setenv("FAKE_UNTWINE_ARGS", str(tmp_path / "untwine.args"))
    ctx, _ = _ctx(tmp_path)
    out = tmp_path / "out.copc.laz"
    writer = C.write_copc(ctx, _las(tmp_path), out, 1000, 32639, tmp_path / ".tmp", 2**30)
    assert writer == "untwine" and out.read_bytes()[:4] == b"LASF"
    args = (tmp_path / "untwine.args").read_text().split()
    assert args[args.index("--temp_dir") + 1] == str(tmp_path / ".tmp" / "untwine")
    assert "--progress_debug" in args and args[-2:] == ["--a_srs", "EPSG:32639"]


LEAVES_TEMP = r"""
import os, shutil, sys
args = sys.argv[1:]
temp = args[args.index("--temp_dir") + 1]
open(os.environ["FAKE_UNTWINE_ARGS"], "w").write(" ".join(sorted(os.listdir(temp))))
open(os.path.join(temp, "1-1-0-0.bin"), "wb").write(b"0" * 1000)
if os.environ.get("FAKE_UNTWINE_FAIL"):
    open(args[args.index("-o") + 1], "wb").write(b"LASF partial")
    sys.exit("untwine: out of disk")
shutil.copyfile(args[args.index("-i") + 1], args[args.index("-o") + 1])
"""


def test_untwines_temporary_files_go_after_a_run_and_after_a_failure(tmp_path, monkeypatch):
    monkeypatch.setenv("AIO_UNTWINE", str(ps.fake_tool(tmp_path / "tools", "untwine", LEAVES_TEMP)))
    monkeypatch.setenv("FAKE_UNTWINE_ARGS", str(tmp_path / "seen"))
    ctx, _ = _ctx(tmp_path)
    temp, out = tmp_path / ".tmp", tmp_path / "out" / "c.copc.laz"
    out.parent.mkdir()
    (temp / "untwine").mkdir(parents=True)
    (temp / "untwine" / "stale.bin").write_bytes(b"from a cancelled run")
    assert C.write_copc(ctx, _las(tmp_path), out, 1000, None, temp, 2**30) == "untwine"
    assert (tmp_path / "seen").read_text() == ""  # the stale file was gone before untwine ran
    assert not (temp / "untwine").exists() and os.listdir(out.parent) == ["c.copc.laz"]
    out.unlink()
    monkeypatch.setenv("FAKE_UNTWINE_FAIL", "1")
    with pytest.raises(JobError, match="out of disk"):
        C.write_copc(ctx, _las(tmp_path), out, 1000, None, temp, 2**30)
    assert not (temp / "untwine").exists() and os.listdir(out.parent) == []  # no partial COPC


def test_without_untwine_pdal_writes_the_copc(tmp_path, monkeypatch):
    monkeypatch.setenv("AIO_UNTWINE", str(tmp_path / "no-untwine.exe"))
    monkeypatch.setenv("AIO_PDAL", str(ps.fake_tool(tmp_path / "tools", "pdal", FAKE_PDAL)))
    ctx, _ = _ctx(tmp_path)
    out = tmp_path / "out.copc.laz"
    assert C.write_copc(ctx, _las(tmp_path), out, 1000, 32639, tmp_path / ".tmp", 2**30) == "pdal"
    assert out.is_file() and not (tmp_path / ".tmp" / "copc-pipeline.json").exists()


def test_the_pdal_fallback_refuses_a_cloud_too_big_for_the_memory(tmp_path, monkeypatch):
    monkeypatch.setenv("AIO_UNTWINE", str(tmp_path / "no-untwine.exe"))
    monkeypatch.setenv("AIO_PDAL", str(ps.fake_tool(tmp_path / "tools", "pdal", FAKE_PDAL)))
    ctx, _ = _ctx(tmp_path)
    with pytest.raises(JobError, match=r"10,000,000 points.*untwine"):
        C.write_copc(
            ctx, _las(tmp_path), tmp_path / "o.copc.laz", 10_000_000, None, tmp_path / ".t", 100 * 2**20
        )
    assert not (tmp_path / "o.copc.laz").exists()


def test_without_untwine_or_pdal_the_cloud_is_refused(tmp_path, monkeypatch):
    monkeypatch.setenv("AIO_UNTWINE", str(tmp_path / "no-untwine.exe"))
    monkeypatch.setenv("AIO_PDAL", str(tmp_path / "no-pdal.exe"))
    monkeypatch.setattr("aio_pipelines.pointcloud.shutil.which", lambda name: None)
    monkeypatch.setattr("aio_pipelines.pointcloud.sys.prefix", str(tmp_path / "venv"))
    ctx, _ = _ctx(tmp_path)
    with pytest.raises(JobError, match="needs untwine or PDAL"):
        C.write_copc(ctx, _las(tmp_path), tmp_path / "o.copc.laz", 10, None, tmp_path / ".t", 2**30)


def _real_tools():
    from aio_pipelines.pointcloud import find_pdal

    return native.find_tool("untwine"), find_pdal()


@pytest.mark.skipif(not all(_real_tools()), reason="needs untwine and PDAL (AIO_UNTWINE, AIO_PDAL)")
def test_real_untwine_keeps_the_classes(tmp_path):
    from aio_pipelines.change.las import read_las, write_las
    from aio_pipelines.pointcloud import find_pdal, pdal_env

    rng = np.random.default_rng(5)
    pts = np.column_stack(
        [rng.uniform(0, 20, 20_000), rng.uniform(0, 20, 20_000), rng.normal(10, 0.02, 20_000)]
    )
    pts[:5000, 2] = 14.0
    cls = np.where(pts[:, 2] < 12.0, 2, 1).astype(np.uint8)
    write_las(tmp_path / "c.las", pts + np.array([412000.0, 3245000.0, 0.0]), classification=cls)
    ctx, _ = _ctx(tmp_path)
    out = tmp_path / "c.copc.laz"
    assert C.write_copc(ctx, tmp_path / "c.las", out, len(pts), ps.EPSG, tmp_path / ".t", 2**31) == "untwine"
    pdal = find_pdal()
    native.run_tool(ctx, [pdal, "translate", str(out), str(tmp_path / "back.las")], "Read the COPC back",
                    tmp_path / "w", env=pdal_env(pdal))  # fmt: skip
    back = read_las(tmp_path / "back.las")
    assert back.count == 20_000 and int((back.field("Classification") == 2).sum()) == 15_000


@pytest.mark.skipif(_real_tools()[1] is None, reason="needs PDAL (AIO_PDAL)")
def test_real_pdal_writes_the_copc_and_its_rate_is_printed(tmp_path, monkeypatch):
    from aio_pipelines.change.las import write_las

    monkeypatch.setenv("AIO_UNTWINE", str(tmp_path / "no-untwine.exe"))
    rng = np.random.default_rng(6)
    n = 2_000_000
    pts = np.column_stack([rng.uniform(0, 20, n), rng.uniform(0, 20, n), rng.normal(10, 0.05, n)])
    write_las(tmp_path / "c.las", pts + np.array([412000.0, 3245000.0, 0.0]))
    ctx, _ = _ctx(tmp_path)
    t0 = time.monotonic()
    assert C.write_copc(ctx, tmp_path / "c.las", tmp_path / "c.copc.laz", n, ps.EPSG,
                        tmp_path / ".t", 2**33) == "pdal"  # fmt: skip
    rate = n / (time.monotonic() - t0)
    print(f"\nPDAL writers.copc: {rate:,.0f} points a second", file=sys.stderr)


def _tiles(tmp_path, n=2, points=1000, junk=True):
    from aio_pipelines.change.las import write_las

    folder = tmp_path / "tiles"
    folder.mkdir()
    rng = np.random.default_rng(3)
    for i in range(n):
        xyz = np.column_stack(
            [rng.uniform(0, 10, points) + 10 * i, rng.uniform(0, 10, points), rng.uniform(0, 5, points)]
        )
        write_las(folder / f"tile-{i + 1:03d}.las", xyz + np.array([412000.0, 3245000.0, 0.0]))
    if junk:
        (folder / "readme.txt").write_text("not a tile")
    return folder


def test_a_folder_of_tiles_is_every_las_in_it_sorted(tmp_path):
    folder = _tiles(tmp_path)
    assert [p.name for p in C.las_inputs(folder)] == ["tile-001.las", "tile-002.las"]
    assert C.las_inputs(tmp_path / "one.las") == [tmp_path / "one.las"]
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(JobError, match="no LAS or LAZ"):
        C.las_inputs(empty)


def test_pdal_merges_every_tile_of_a_folder(tmp_path):
    folder = _tiles(tmp_path)
    pipe = C.pdal_copc_pipeline(folder, tmp_path / "o.copc.laz", 32639)["pipeline"]
    assert [s["type"] for s in pipe] == ["readers.las", "readers.las", "filters.merge", "writers.copc"]
    assert pipe[0]["override_srs"] == "EPSG:32639"
    one = C.pdal_copc_pipeline(tmp_path / "c.las", tmp_path / "o.copc.laz", None)["pipeline"]
    assert [s["type"] for s in one] == ["readers.las", "writers.copc"]


@pytest.mark.skipif(not all(_real_tools()), reason="needs untwine and PDAL (AIO_UNTWINE, AIO_PDAL)")
def test_real_untwine_merges_a_folder_of_tiles(tmp_path):
    import json
    import subprocess

    from aio_pipelines.pointcloud import find_pdal, pdal_env

    folder = _tiles(tmp_path, n=2, points=5000, junk=False)  # a zpc folder holds tiles only
    ctx, _ = _ctx(tmp_path)
    out = tmp_path / "m.copc.laz"
    assert C.write_copc(ctx, folder, out, 10_000, ps.EPSG, tmp_path / ".t", 2**31) == "untwine"
    pdal = find_pdal()
    info = json.loads(
        subprocess.run(
            [pdal, "info", "--summary", str(out)], capture_output=True, check=True, env=pdal_env(pdal)
        ).stdout
    )["summary"]
    assert info["num_points"] == 10_000
    assert info["bounds"]["maxx"] - info["bounds"]["minx"] > 19.0  # both tiles
