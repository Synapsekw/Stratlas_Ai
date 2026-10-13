"""photo/cloud_out.py: the fused tiles as a classified LAS, then a COPC through untwine or PDAL;
and native.run_tool's progress hook."""

from __future__ import annotations

import json
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
from aio_pipelines.photo import surface as S
from aio_pipelines.photo.fuse import PointTiles
from aio_pipelines.runtime import Job, JobError, Step, StepContext
from conftest import Recorder


def _ctx(tmp_path):
    rec = Recorder()
    job = Job("t1", None, tmp_path, {}, rec, threading.Event())  # type: ignore[arg-type]
    job.steps, job.weights = [Step("cloud", "Cloud", lambda c: None)], [1.0]
    return StepContext(job, 0, job.steps[0]), rec


def _fused(root: Path, tiles: dict[str, np.ndarray], tile: float = 10.0) -> PointTiles:
    """A store with these fused tiles (as ``merge`` leaves them), without fusing anything."""
    out = root / "fused"
    out.mkdir(parents=True)
    lo, hi, n = np.full(3, np.inf), np.full(3, -np.inf), 0
    for name, xyz in tiles.items():
        k = len(xyz)
        np.savez(out / f"{name}.npz", xyz=xyz, rgb=np.full((k, 3), 90, np.uint8),
                 normal=np.tile(np.float32([0, 0, 1]), (k, 1)), count=np.ones(k, np.int32))  # fmt: skip
        lo, hi, n = np.minimum(lo, xyz.min(0)), np.maximum(hi, xyz.max(0)), n + k
    (out / "index.json").write_text(json.dumps({"points": n, "bounds": [lo.tolist(), hi.tolist()]}), "utf-8")
    return PointTiles(root, tile)


def _flat_dtm(path: Path, z: float = 10.0, hole: tuple[int, int] | None = None) -> Path:
    """A 20 m x 20 m DTM at 0.5 m in the project CRS (x 412000.., y 3245000..)."""
    spec = S.GridSpec(412000.0, 3245020.0, 0.5, 40, 40)
    a = np.full((40, 40), z, np.float32)
    if hole:
        a[hole] = S.NODATA
    with S.write_tif(path, spec, ps.EPSG, 1, "float32", S.NODATA) as ds:
        ds.write(a, 1)
    return path


SHIFT = np.array([412000.0, 3245000.0, 0.0])


def test_points_are_ground_from_half_a_metre_below_to_twenty_cm_above_the_dtm():
    z = np.array([9.49, 9.5, 10.0, 10.2, 10.21, 10.0])
    g = np.array([10.0, 10.0, 10.0, 10.0, 10.0, np.nan])
    assert C.classify(z, g).tolist() == [1, 2, 2, 2, 1, 1]


def test_the_dtm_is_sampled_bilinearly(tmp_path):
    spec = S.GridSpec(0.0, 10.0, 1.0, 10, 10)
    gx, gy = spec.centres(0, 0, 10, 10)
    with S.write_tif(tmp_path / "p.tif", spec, None, 1, "float32", S.NODATA) as ds:
        ds.write((gx + 2 * gy).astype(np.float32), 1)
    sample = C.DtmSampler(tmp_path / "p.tif")
    try:
        x, y = np.array([2.0, 5.25, 7.9]), np.array([3.0, 4.75, 1.6])
        np.testing.assert_allclose(sample(x, y), x + 2 * y, atol=1e-5)
    finally:
        sample.close()


def test_points_where_the_dtm_has_no_height_are_not_ground(tmp_path):
    dtm = _flat_dtm(tmp_path / "dtm.tif", hole=(10, 10))  # the cell of x 5..5.5, y 14.5..15
    sample = C.DtmSampler(dtm)
    try:
        g = sample(np.array([412005.2, 412015.0, 412050.0]), np.array([3245014.7, 3245005.0, 3245005.0]))
    finally:
        sample.close()
    assert np.isnan(g[0]) and g[1] == pytest.approx(10.0) and np.isnan(g[2])  # in the hole, inside, outside
    assert C.classify(np.array([10.0, 10.0, 10.0]), g).tolist() == [1, 2, 1]


def test_the_las_is_written_tile_by_tile_with_the_classes(tmp_path):
    from aio_pipelines.change.las import read_las

    rng = np.random.default_rng(3)
    ground = np.column_stack([rng.uniform(0, 20, 3000), rng.uniform(0, 20, 3000), rng.normal(10, 0.02, 3000)])
    roof = np.column_stack([rng.uniform(4, 8, 400), rng.uniform(4, 8, 400), np.full(400, 15.0)])
    pts = np.concatenate([ground, roof])
    tiles = {f"{i}_{j}": pts[(np.floor(pts[:, 0] / 10) == i) & (np.floor(pts[:, 1] / 10) == j)]
             for i in range(2) for j in range(2)}  # fmt: skip
    store = _fused(tmp_path / "m", tiles)
    seen = []
    got = C.write_las(tmp_path / "c.las", store, SHIFT, _flat_dtm(tmp_path / "dtm.tif"),
                      progress=lambda f, m=None: seen.append(m))  # fmt: skip
    las = read_las(tmp_path / "c.las")
    assert got == {"points": 3400, "ground": 3000} and las.count == 3400 and las.pdrf == 7
    cls = las.field("Classification")
    assert (cls[las.xyz[:, 2] > 14] == 1).all() and (cls[las.xyz[:, 2] < 11] == 2).all()
    want = np.concatenate([p["xyz"] for _, p in store.fused()]) + SHIFT
    assert np.abs(las.xyz - want).max() <= 0.0005 + 1e-9  # millimetres, in the tiles' order
    assert las.field("Red").max() > 255  # 16-bit colour
    assert seen[-1] == "Writing the cloud: tile 4 of 4"


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


def test_without_untwine_pdal_writes_the_copc(tmp_path, monkeypatch):
    monkeypatch.setenv("AIO_UNTWINE", str(tmp_path / "no-untwine.exe"))
    monkeypatch.setenv("AIO_PDAL", str(ps.fake_tool(tmp_path / "tools", "pdal", FAKE_PDAL)))
    ctx, _ = _ctx(tmp_path)
    out = tmp_path / "out.copc.laz"
    assert C.write_copc(ctx, _las(tmp_path), out, 1000, 32639, tmp_path / ".tmp", 2**30) == "pdal"
    assert out.is_file()


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
    from aio_pipelines.change.las import read_las
    from aio_pipelines.pointcloud import find_pdal, pdal_env

    rng = np.random.default_rng(5)
    pts = np.column_stack(
        [rng.uniform(0, 20, 20_000), rng.uniform(0, 20, 20_000), rng.normal(10, 0.02, 20_000)]
    )
    pts[:5000, 2] = 14.0
    store = _fused(tmp_path / "m", {"0_0": pts})
    counts = C.write_las(tmp_path / "c.las", store, SHIFT, _flat_dtm(tmp_path / "dtm.tif"))
    ctx, _ = _ctx(tmp_path)
    out = tmp_path / "c.copc.laz"
    assert (
        C.write_copc(ctx, tmp_path / "c.las", out, counts["points"], ps.EPSG, tmp_path / ".t", 2**31)
        == "untwine"
    )
    pdal = find_pdal()
    native.run_tool(ctx, [pdal, "translate", str(out), str(tmp_path / "back.las")], "Read the COPC back",
                    tmp_path / "w", env=pdal_env(pdal))  # fmt: skip
    back = read_las(tmp_path / "back.las")
    cls = back.field("Classification")
    assert back.count == 20_000 and int((cls == 2).sum()) == counts["ground"] == 15_000


@pytest.mark.skipif(_real_tools()[1] is None, reason="needs PDAL (AIO_PDAL)")
def test_real_pdal_writes_the_copc_and_its_rate_is_printed(tmp_path, monkeypatch):
    monkeypatch.setenv("AIO_UNTWINE", str(tmp_path / "no-untwine.exe"))
    rng = np.random.default_rng(6)
    n = 2_000_000
    pts = np.column_stack([rng.uniform(0, 20, n), rng.uniform(0, 20, n), rng.normal(10, 0.05, n)])
    store = _fused(tmp_path / "m", {"0_0": pts})
    counts = C.write_las(tmp_path / "c.las", store, SHIFT, None)
    ctx, _ = _ctx(tmp_path)
    t0 = time.monotonic()
    assert C.write_copc(ctx, tmp_path / "c.las", tmp_path / "c.copc.laz", counts["points"], ps.EPSG,
                        tmp_path / ".t", 2**33) == "pdal"  # fmt: skip
    rate = n / (time.monotonic() - t0)
    print(f"\nPDAL writers.copc: {rate:,.0f} points a second", file=sys.stderr)
