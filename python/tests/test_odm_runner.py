import json
import socket
import sys
import threading
import time
from pathlib import Path

import pytest

import products_synth as ps
from aio_pipelines.photo import native
from aio_pipelines.photo.odm import runner as R
from aio_pipelines.runtime import Cancelled, JobError

FAKE = Path(__file__).parent / "fake_odm"


class Ctx:
    """The StepContext parts run_odm uses."""

    def __init__(self):
        self.cancel_event = threading.Event()
        self.bar: list[tuple[float, str | None]] = []
        self.logs: list[tuple[str, str]] = []

    def progress(self, f, m=None):
        self.bar.append((f, m))

    def log(self, m, level="info"):
        self.logs.append((m, level))

    def check(self):
        if self.cancel_event.is_set():
            raise Cancelled()


@pytest.fixture
def odm(monkeypatch):
    monkeypatch.setenv("FAKE_ODM_PYTHON", sys.executable)
    monkeypatch.setenv(R.ODM_ENV, str(FAKE))
    return R.find_odm()


@pytest.fixture
def aligned(tmp_path):
    ps.write_project(tmp_path / "p", ps.make_scene(step=0.2))
    return tmp_path / "p" / "photogrammetry" / ps.RUN / "odm"


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_find_odm_needs_the_folder(monkeypatch, tmp_path):
    monkeypatch.delenv(R.ODM_ENV, raising=False)
    with pytest.raises(JobError, match="Install it in Settings, Processing tools"):
        R.find_odm()
    monkeypatch.setenv(R.ODM_ENV, str(tmp_path))
    with pytest.raises(JobError):
        R.find_odm()
    monkeypatch.setenv(R.ODM_ENV, str(FAKE))
    monkeypatch.delenv(R.VERSION_ENV, raising=False)
    assert R.find_odm().version == "3.6.2"


def test_datagrams_for_another_project_are_ignored():
    assert R.parse_datagram(b"PGUP/123/odm/42.5", "odm") == 42.5
    assert R.parse_datagram(b"PGUP/123/other/42.5", "odm") is None
    assert R.parse_datagram(b"garbage", "odm") is None
    assert R.parse_datagram(b"PGUP/1/odm/400", "odm") is None


def test_stage_progress_maps_odm_percent_onto_the_step_and_never_steps_back():
    sp = R.StageProgress("openmvs", "odm_filterpoints")  # ODM 25..52
    assert sp.feed_line("[INFO]    Running openmvs stage") == 0.0
    assert sp.message == "Dense matching"
    assert sp.feed_udp(38.5) == pytest.approx(0.5)
    assert sp.feed_udp(75.0) is None  # not openmvs's range: the split stage's or another tool's
    assert sp.feed_udp(30.0) == pytest.approx(0.5)  # never back
    assert sp.feed_line("\x1b[32m[INFO]    Finished openmvs stage\x1b[0m") == pytest.approx(25 / 27)


def test_resume_starts_after_the_last_finished_stage():
    log = "Running openmvs stage\nFinished openmvs stage\nRunning odm_filterpoints stage\n"
    assert R.resume_from(log, "openmvs", "odm_georeferencing") == "odm_filterpoints"
    assert R.resume_from("", "openmvs", "odm_georeferencing") == "openmvs"
    assert R.resume_from("Finished opensfm stage\n", "openmvs", "odm_georeferencing") == "openmvs"
    assert (
        R.resume_from("Finished odm_georeferencing stage\n", "openmvs", "odm_georeferencing")
        == "odm_georeferencing"
    )


def test_gpu_use_from_the_log():
    ok = R.gpu_use(
        "Using GPU for extracting SIFT features\nRunning openmvs stage\nCUDA device 0 initialized: X\n", True
    )
    cpu = R.gpu_use("Using GPU for extracting SIFT features\nRunning openmvs stage\n", True)
    assert (cpu.features, cpu.dense) == (True, False)  # ODM 3.6.2 on Windows: no CUDA line, dense on the CPU
    assert (ok.features, ok.dense, ok.fallbacks) == (True, True, [])
    bad = R.gpu_use("GPU SIFT extraction failed\nRunning openmvs stage\nOpenMVS failed with GPU\n", True)
    assert (bad.features, bad.dense) == (False, False) and len(bad.fallbacks) == 2
    off = R.gpu_use("Running opensfm stage\n", False)
    assert off.features is False and off.dense is None
    assert ok.summary() == "Graphics card used for features: yes; for dense matching: yes."


@pytest.mark.parametrize(
    ("code", "text"),
    [(137, "ran out of memory"), (3221226505, "ran out of memory"), (132, "processor is not supported"),
     (3, "reinstall the processing engine"), (1, "could not process these photos: last line"),
     (139, "could not process"), (99, "exit code 99")],
)  # fmt: skip
def test_exit_codes_become_plain_messages(code, text):
    assert text in str(R.exit_error(code, ["first", "last line"]))


def test_the_environment_is_odms_own():
    base = {
        "PATH": "x",
        "PYTHONPATH": "y",
        "PYTHONHOME": "z",
        "VIRTUAL_ENV": "v",
        "NoDefaultCurrentDirectoryInExePath": "1",
    }
    env = R.odm_env(base, use_gpu=False)
    assert env["ODM_NONINTERACTIVE"] == "1" and env["ODM_NO_GPU"] == "1" and env["PATH"] == "x"
    # run.bat calls winrun.bat by bare name: with this variable set, cmd does not find it and run.bat still exits 0
    assert not {"PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV", "NoDefaultCurrentDirectoryInExePath"} & set(env)
    assert "ODM_NO_GPU" not in R.odm_env({}, use_gpu=True)


def test_every_conda_variable_is_left_out():
    base = {
        "CONDA_PREFIX": "a",
        "CONDA_PREFIX_1": "b",
        "CONDA_EXE": "c",
        "CONDA_SHLVL": "1",
        "conda_python_exe": "d",
    }
    assert R.odm_env({**base, "PATH": "x"}, use_gpu=True).keys() == {
        "PATH",
        "ODM_NONINTERACTIVE",
        "PYTHONUNBUFFERED",
    }


def test_odm_prints_unbuffered():
    # stdout to a file is block-buffered: without this ODM's stage lines would arrive only at exit
    env = R.odm_env({"PYTHONUNBUFFERED": "0", "PYTHONPATH": "y"}, use_gpu=True)
    assert env["PYTHONUNBUFFERED"] == "1" and "PYTHONPATH" not in env


QUIET_ODM = """
import sys, time
from pathlib import Path
print("[INFO]    Running opensfm stage")  # no flush: as ODM, which never flushes its log lines
go, seen = Path(sys.argv[1]) / "go", Path(sys.argv[1]) / "seen-while-running"
for _ in range(80):
    if go.exists():
        seen.write_text("")
        break
    time.sleep(0.1)
print("[INFO]    Finished opensfm stage")
"""


def test_stage_lines_reach_the_runner_while_odm_runs(tmp_path, monkeypatch):
    odm_dir = tmp_path / "odm"
    odm_dir.mkdir()
    (odm_dir / "quiet.py").write_text(QUIET_ODM, "utf-8")
    (odm_dir / "run.bat").write_text(
        '@echo off\r\n"%FAKE_ODM_PYTHON%" "%~dp0quiet.py" "%QUIET_DIR%"\r\n', "utf-8"
    )
    (odm_dir / "run.sh").write_text(
        '#!/bin/sh\nexec "$FAKE_ODM_PYTHON" "$(dirname "$0")/quiet.py" "$QUIET_DIR"\n'
    )
    monkeypatch.setenv("FAKE_ODM_PYTHON", sys.executable)
    monkeypatch.setenv("QUIET_DIR", str(tmp_path))
    monkeypatch.delenv("PYTHONUNBUFFERED", raising=False)
    project = tmp_path / "work" / "odm"
    project.mkdir(parents=True)

    class Watching(Ctx):
        def progress(self, f, m=None):
            super().progress(f, m)
            if m == "Aligning the photos":  # the Running line was read: let the stand-in finish
                (tmp_path / "go").touch()

    R.run_odm(Watching(), R.OdmInstall(odm_dir, "3.6.2"), project, [], "opensfm", "opensfm", tmp_path / "logs",
              rerun=False, use_gpu=False, port=_free_port())  # fmt: skip
    assert (tmp_path / "seen-while-running").exists()


@pytest.mark.parametrize("bad", ["", "abc", "0", "-5", "inf", "-inf", "nan"])
def test_bad_limits_count_as_unset(bad):
    assert R.odm_memory_cap({R.MEMORY_CAP_ENV: bad}) is None
    assert R.stall_seconds({R.STALL_ENV: bad}) == 60 * 60


def test_the_stall_limit_defaults_to_an_hour_and_can_be_set():
    assert R.stall_seconds({}) == 60 * 60
    assert R.stall_seconds({R.STALL_ENV: "0.5"}) == 30
    assert R.odm_memory_cap({R.MEMORY_CAP_ENV: "1"}) == 64 * 1024 * 1024  # at least 64 MB


def test_the_gpu_setting_from_the_environment(monkeypatch):
    monkeypatch.setenv(R.GPU_ENV, "off")
    assert R.machine().use_gpu is False


def test_threads_and_memory_limit_come_only_from_the_hand_set_cap(odm, aligned, tmp_path, monkeypatch):
    GB = 1024**3
    monkeypatch.setattr(R.os, "cpu_count", lambda: 24)
    monkeypatch.setattr(native, "total_memory", lambda: 64 * GB)
    monkeypatch.setenv("AIO_PHOTO_MEMORY_MB", "49152")  # the app's automatic 75 %: ignored by ODM
    monkeypatch.delenv("AIO_ODM_MEMORY_CAP_MB", raising=False)
    assert R.odm_memory_cap() is None and R.machine().threads == 21
    seen: dict[str, int] = {}
    real = native.run_tool

    def spy(*a, **kw):
        seen["limit"] = kw["memory_limit"]
        return real(*a, **kw)

    monkeypatch.setattr(native, "run_tool", spy)
    R.run_odm(
        Ctx(),
        odm,
        aligned,
        [],
        "openmvs",
        "odm_filterpoints",
        tmp_path / "a",
        rerun=True,
        use_gpu=False,
        port=_free_port(),
    )
    assert seen["limit"] == 0
    monkeypatch.setenv("AIO_ODM_MEMORY_CAP_MB", "49152")  # set by hand
    assert R.odm_memory_cap() == 48 * GB and R.machine().threads == 16
    R.run_odm(
        Ctx(),
        odm,
        aligned,
        [],
        "openmvs",
        "odm_filterpoints",
        tmp_path / "b",
        rerun=True,
        use_gpu=False,
        port=_free_port(),
    )
    assert seen["limit"] == 48 * GB


def test_align_runs_to_opensfm_with_progress_and_the_gpu_line(odm, aligned, tmp_path, monkeypatch):
    (aligned / ".fake" / "opensfm.done").unlink()  # a fresh alignment: the fake runs opensfm again
    log = tmp_path / "args.jsonl"
    monkeypatch.setenv("FAKE_ODM_ARGS_LOG", str(log))
    ctx = Ctx()
    run = R.run_odm(ctx, odm, aligned, ["--feature-type", "sift"], "dataset", "opensfm",
                    tmp_path / "logs", rerun=False, use_gpu=True, port=_free_port())  # fmt: skip
    args = json.loads(log.read_text().splitlines()[-1])
    assert "--rerun-from" not in args and args[args.index("--end-with") + 1] == "opensfm"
    assert run.gpu.features is True
    fractions = [f for f, _ in ctx.bar]
    assert fractions == sorted(fractions) and fractions[-1] == pytest.approx(1.0)
    assert ("Graphics card used for features: yes.", "info") in ctx.logs
    assert "Finished opensfm stage" in run.log.read_text()


def test_udp_refines_progress_and_stdout_takes_over_when_the_port_is_taken(
    odm, aligned, tmp_path, monkeypatch
):
    port = _free_port()
    monkeypatch.setenv("FAKE_ODM_UDP_PORT", str(port))
    monkeypatch.setenv("FAKE_ODM_STAGE_S", "1.0")
    ctx = Ctx()
    R.run_odm(
        ctx,
        odm,
        aligned,
        [],
        "openmvs",
        "odm_filterpoints",
        tmp_path / "a",
        rerun=True,
        use_gpu=False,
        port=port,
    )
    assert any(0.3 < f < 0.7 for f, _ in ctx.bar)  # openmvs's midpoint datagram: (25 + 50) / 2 in 25..52
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as busy:
        busy.bind(("127.0.0.1", port))
        ctx = Ctx()
        R.run_odm(
            ctx,
            odm,
            aligned,
            [],
            "openmvs",
            "odm_filterpoints",
            tmp_path / "b",
            rerun=True,
            use_gpu=False,
            port=port,
        )
    assert ctx.bar[-1][0] == pytest.approx(1.0)


def test_a_stalled_odm_is_stopped_with_a_plain_message(odm, aligned, tmp_path, monkeypatch):
    pids = tmp_path / "pids"
    monkeypatch.setenv("FAKE_ODM_HANG", "odm_meshing")  # prints its stage line, then nothing
    monkeypatch.setenv("FAKE_ODM_PIDS", str(pids))
    monkeypatch.setenv(R.STALL_ENV, "0.05")  # three seconds
    with pytest.raises(JobError, match="ODM stopped making progress in the meshing stage"):
        R.run_odm(Ctx(), odm, aligned, [], "openmvs", "odm_georeferencing", tmp_path / "logs",
                  rerun=True, use_gpu=False, port=_free_port())  # fmt: skip
    from aio_pipelines.photo.proctree import process_started

    time.sleep(1.0)
    for pid in map(int, pids.read_text().split()):
        assert process_started(pid) is None, f"process {pid} survived the stall"


def test_dense_on_the_cpu_is_said_plainly(odm, aligned, tmp_path):
    ctx = Ctx()
    run = R.run_odm(ctx, odm, aligned, [], "openmvs", "odm_filterpoints", tmp_path / "l", rerun=True,
                    use_gpu=True, port=_free_port())  # fmt: skip
    assert run.gpu.dense is False  # the fake ODM folder has no parked stub
    assert (R.DENSE_CPU_NOTE, "info") in ctx.logs


def _install(tmp_path: Path, stub_bytes: int = 19_968) -> R.OdmInstall:
    bin_dir = tmp_path / "odm-3.6.2" / "SuperBuild" / "install" / "bin"
    bin_dir.mkdir(parents=True)
    (bin_dir / "nvcuda.dll").write_bytes(b"\0" * stub_bytes)
    return R.OdmInstall(tmp_path / "odm-3.6.2", "3.6.2")


def test_the_stub_is_parked_when_the_driver_is_there_and_back_when_off(tmp_path, monkeypatch):
    inst = _install(tmp_path)
    stub, parked = inst.dir / R.STUB, inst.dir / R.PARKED
    monkeypatch.setattr(R, "nvcuda_present", lambda env=None: True)
    owned = {R.OWNED_ENV: "1"}
    assert R.ensure_dense_gpu(inst, True, owned) is True
    assert not stub.exists() and parked.stat().st_size == 19_968  # renamed, never deleted
    assert R.ensure_dense_gpu(inst, True, owned) is True  # idempotent
    assert R.ensure_dense_gpu(inst, False, owned) is False  # GPU off: the stub goes back
    assert stub.exists() and not parked.exists()


def test_the_stub_stays_without_a_driver_or_outside_our_install(tmp_path, monkeypatch):
    inst = _install(tmp_path)
    monkeypatch.setattr(R, "nvcuda_present", lambda env=None: False)
    assert R.ensure_dense_gpu(inst, True, {R.OWNED_ENV: "1"}) is False
    assert (inst.dir / R.STUB).exists()  # without the real driver OpenMVS would not even start
    monkeypatch.setattr(R, "nvcuda_present", lambda env=None: True)
    assert R.ensure_dense_gpu(inst, True, {}) is False  # not the ODM the app installed (QUADRION_ODM_DIR)
    assert (inst.dir / R.STUB).exists()
    big = _install(tmp_path / "big", stub_bytes=2_000_000)
    # a real driver someone copied there: left alone
    assert R.ensure_dense_gpu(big, True, {R.OWNED_ENV: "1"}) is False
    assert (big.dir / R.STUB).exists()


def test_dense_counts_as_gpu_when_the_stub_is_parked():
    text = "Running openmvs stage\nFinished openmvs stage\n"
    assert R.gpu_use(text, True, ("openmvs", "odm_filterpoints"), dense_capable=True).dense is True
    assert (
        R.gpu_use(
            text + "OpenMVS failed with GPU\n", True, ("openmvs", "odm_filterpoints"), dense_capable=True
        ).dense
        is False
    )
    assert R.gpu_use(text, True, ("openmvs", "odm_filterpoints"), dense_capable=False).dense is False


def test_a_dtm_is_never_added_from_odm_dem_on_a_cloud_made_without_it(odm, aligned, tmp_path, monkeypatch):
    log = tmp_path / "args.jsonl"
    monkeypatch.setenv("FAKE_ODM_ARGS_LOG", str(log))
    R.run_odm(Ctx(), odm, aligned, ["--dsm", "--dtm"], "odm_dem", "odm_dem", tmp_path / "a", rerun=True,
              use_gpu=False, port=_free_port())  # fmt: skip
    first = json.loads(log.read_text().splitlines()[-1])
    assert first[first.index("--rerun-from") + 1] == "odm_georeferencing"  # no mark: reclassify first
    assert R.dtm_cloud_ok(aligned)  # that run made the cloud with --dtm and left the mark
    R.run_odm(Ctx(), odm, aligned, ["--dsm", "--dtm"], "odm_dem", "odm_dem", tmp_path / "b", rerun=True,
              use_gpu=False, port=_free_port())  # fmt: skip
    second = json.loads(log.read_text().splitlines()[-1])
    assert second[second.index("--rerun-from") + 1] == "odm_dem"


SMRF_FAIL = (
    "[WARNING] Error creating classified file x: PDAL: Cannot determine reader for input file: E:\\x\\Probe"
)


@pytest.mark.parametrize(
    ("said_in", "first", "last"),
    [("odm_georeferencing", "odm_georeferencing", "odm_dem"),  # georeferencing and DEM in one call
     ("odm_georeferencing", "odm_meshing", "odm_georeferencing"),  # the cloud step: exits 0 right after SMRF
     ("odm_georeferencing", "odm_georeferencing", "odm_georeferencing"),
     ("odm_dem", "odm_dem", "odm_dem")],  # a later step
)  # fmt: skip
def test_a_failed_ground_classification_stops_the_dtm_at_once(
    odm, aligned, tmp_path, monkeypatch, said_in, first, last
):
    monkeypatch.setenv("FAKE_ODM_SAY", f"{said_in}:{SMRF_FAIL}")
    ctx = Ctx()
    with pytest.raises(
        R.OdmGroundFailed, match="ODM found no ground points, so it cannot make a terrain model"
    ):
        R.run_odm(ctx, odm, aligned, ["--dsm", "--dtm"], first, last, tmp_path / "g",
                  rerun=True, use_gpu=False, port=_free_port())  # fmt: skip
    assert any("Cannot determine reader" in m and level == "warn" for m, level in ctx.logs)  # the ODM tail


def test_resume_reports_gpu_use_only_for_the_stages_that_ran(odm, aligned, tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_ODM_FAIL", "odm_meshing:1")
    logs = tmp_path / "logs"
    with pytest.raises(JobError):
        R.run_odm(Ctx(), odm, aligned, [], "openmvs", "odm_georeferencing", logs, rerun=True, use_gpu=True,
                  port=_free_port())  # fmt: skip
    monkeypatch.delenv("FAKE_ODM_FAIL")
    ctx = Ctx()
    run = R.run_odm(ctx, odm, aligned, [], "openmvs", "odm_georeferencing", logs, rerun=True, use_gpu=True,
                    port=_free_port())  # fmt: skip
    assert run.started_from == "odm_meshing"
    assert run.gpu.dense is None  # ODM printed "Running openmvs stage" but skipped it
    assert (R.DENSE_CPU_NOTE, "info") not in ctx.logs


def test_cancel_kills_the_whole_odm_tree(odm, aligned, tmp_path, monkeypatch):
    pids = tmp_path / "pids"
    monkeypatch.setenv("FAKE_ODM_HANG", "odm_meshing")
    monkeypatch.setenv("FAKE_ODM_PIDS", str(pids))
    ctx = Ctx()

    def cancel_when_hanging():
        for _ in range(600):
            if pids.exists() and len(pids.read_text().split()) == 2:
                ctx.cancel_event.set()
                return
            time.sleep(0.1)

    threading.Thread(target=cancel_when_hanging, daemon=True).start()
    with pytest.raises(Cancelled):
        R.run_odm(ctx, odm, aligned, [], "openmvs", "odm_georeferencing", tmp_path / "logs",
                  rerun=True, use_gpu=False, port=_free_port())  # fmt: skip
    from aio_pipelines.photo.proctree import process_started

    time.sleep(1.0)
    for pid in map(int, pids.read_text().split()):
        assert process_started(pid) is None, f"process {pid} survived the cancel"


def test_products_resume_starts_after_the_last_finished_stage(odm, aligned, tmp_path, monkeypatch):
    args_log = tmp_path / "args.jsonl"
    monkeypatch.setenv("FAKE_ODM_ARGS_LOG", str(args_log))
    monkeypatch.setenv("FAKE_ODM_FAIL", "odm_meshing:1")
    logs = tmp_path / "logs"
    with pytest.raises(JobError, match="could not process these photos"):
        R.run_odm(
            Ctx(),
            odm,
            aligned,
            [],
            "openmvs",
            "odm_georeferencing",
            logs,
            rerun=True,
            use_gpu=False,
            port=_free_port(),
        )
    monkeypatch.delenv("FAKE_ODM_FAIL")
    run = R.run_odm(
        Ctx(),
        odm,
        aligned,
        [],
        "openmvs",
        "odm_georeferencing",
        logs,
        rerun=True,
        use_gpu=False,
        port=_free_port(),
    )
    first, second = (json.loads(x) for x in args_log.read_text().splitlines()[-2:])
    assert first[first.index("--rerun-from") + 1] == "openmvs"
    assert second[second.index("--rerun-from") + 1] == "odm_meshing"
    assert run.started_from == "odm_meshing"


def test_a_gpu_fallback_is_a_warning_not_a_failure(odm, aligned, tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_ODM_GPU", "features-fallback")
    ctx = Ctx()
    run = R.run_odm(ctx, odm, aligned, ["--feature-type", "sift"], "opensfm", "opensfm", tmp_path / "l",
                    rerun=True, use_gpu=True, port=_free_port())  # fmt: skip
    assert run.gpu.features is False
    assert any(level == "warn" and "CPU" in m for m, level in ctx.logs)


def test_engine_record():
    rec = R.engine_record(R.OdmInstall(FAKE, "3.6.2"), R.GpuUse(True, None, []))
    assert rec == {"name": "odm", "version": "3.6.2", "gpu": {"features": True}}
