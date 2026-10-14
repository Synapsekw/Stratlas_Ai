"""Run ODM (``run.bat``) as a job step: progress, cancel, resume, plain errors (ADR 0012).

Progress: ODM prints ``Running <stage> stage`` and ``Finished <stage> stage``; it also sends
``PGUP/<pid>/<project>/<percent>`` datagrams to 127.0.0.1:6367 (what NodeODM listens to). A step
covers a window of ODM's stages; stage lines move the bar to each stage's start and end, and a
datagram inside the running stage's own range refines it. When the port is taken, stage lines alone
drive the bar. Cancel ends ODM's whole process tree (``native.run_tool``). Resume: each step keeps
ODM's output in ``<log_dir>/odm.log``; with ``rerun`` the next attempt starts ``--rerun-from`` the
stage after the last one finished (without it ODM's own rerun skips what is done).

ODM's program code is never changed. One exception (founder, 14 Oct 2026; deviation 17): in the
ODM folder the app installed itself, the placeholder ``nvcuda.dll`` beside OpenMVS is renamed so
dense matching can use the real NVIDIA driver (``ensure_dense_gpu``).
"""

from __future__ import annotations

import contextlib
import os
import re
import socket
import subprocess
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path

from ...runtime import JobError, StepContext
from .. import native
from .flags import STAGE_END, gpu_wanted, odm_threads, stage_after, stage_index, stage_start, stage_window

ODM_ENV, VERSION_ENV, GPU_ENV = "AIO_ODM", "AIO_ODM_VERSION", "AIO_ODM_GPU"
WORK_ENV = "AIO_ODM_WORK"  # the same name as project.WORK_ENV (Task 5); kept here so this module stands alone
MEMORY_CAP_ENV = "AIO_ODM_MEMORY_CAP_MB"  # set by the app only for a memory limit set by hand
OWNED_ENV = "AIO_ODM_OWNED"  # "1" only for the ODM the app installed itself
STUB = Path("SuperBuild/install/bin/nvcuda.dll")
PARKED = Path("SuperBuild/install/bin/nvcuda.dll.odm-stub")
STUB_MAX_BYTES = 100_000  # ODM's placeholder is 19 KB; a real driver someone copied there is left alone
UDP_PORT = 6367
NO_ODM = "The processing engine (ODM) is not installed. Install it in Settings, Processing tools."
OOM = "ODM ran out of memory; try the Fast preset or close other programs."
STAGE_LINE = re.compile(r"\b(Running|Finished) (\w+) stage\b")
ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
FEATURES_YES, FEATURES_NO = "Using GPU for extracting SIFT features", "GPU SIFT extraction failed"
DENSE_YES, DENSE_NO = re.compile(r"CUDA device \d+ initialized"), "OpenMVS failed with GPU"
STAGE_WORDS = {
    "dataset": "Reading the photos", "opensfm": "Aligning the photos", "openmvs": "Dense matching",
    "odm_filterpoints": "Filtering the point cloud", "odm_meshing": "Meshing", "mvs_texturing": "Texturing",
    "odm_georeferencing": "Georeferencing", "odm_dem": "Elevation models", "odm_orthophoto": "Orthophoto",
    "odm_report": "Report", "odm_postprocess": "Finishing",
}  # fmt: skip
EXIT = {
    137: OOM, 3221226505: OOM,
    132: "This computer's processor is not supported by ODM.",
    3: "ODM is missing a program; reinstall the processing engine in Settings, Processing tools.",
}  # fmt: skip
BAD_INPUT = {1, 134, 139, 3221225477}
STALL_ENV = "AIO_ODM_STALL_MIN"
DENSE_CPU_NOTE = "ODM ran dense matching on the CPU; the graphics card was not used for this step."
FEATURES_FALLBACK = "The graphics card could not extract features; ODM used the CPU."
DENSE_FALLBACK = "The graphics card could not run dense matching; ODM used the CPU."
GROUND_FAIL = re.compile(r"Cannot determine reader|Error creating classified file")
DTM_MARK = "odm_georeferencing/.aio-dtm"
GEOREF_LAZ = "odm_georeferencing/odm_georeferenced_model.laz"
TAIL_LINES = 20
_DROP_ENV = (
    "PYTHON",
    "VIRTUAL_ENV",
    "CONDA_PREFIX",
    "CONDA_DEFAULT_ENV",
    "NODEFAULTCURRENTDIRECTORYINEXEPATH",
)


class OdmStalled(JobError):
    """ODM printed nothing and sent no progress for ``stall_seconds()``: its tree is ended."""


class OdmGroundFailed(JobError):
    """ODM's ground classification failed (it carries on, and its DTM would never finish)."""


# ------------------------------------------------------------------------------ the install


@dataclass(frozen=True)
class OdmInstall:
    dir: Path
    version: str


def find_odm(env: Mapping[str, str] | None = None) -> OdmInstall:
    env = os.environ if env is None else env
    folder = env.get(ODM_ENV)
    if not folder:
        raise JobError(NO_ODM)
    d = Path(folder)
    if not (d / ("run.bat" if os.name == "nt" else "run.sh")).is_file():
        raise JobError(NO_ODM)
    version = env.get(VERSION_ENV)
    if not version:
        try:
            version = (d / "VERSION").read_text("utf-8").strip() or "unknown"
        except OSError:
            version = "unknown"
    return OdmInstall(d, version)


def nvcuda_present(env: Mapping[str, str] | None = None) -> bool:
    """NVIDIA's CUDA driver is on this computer (``%SYSTEMROOT%\\System32\\nvcuda.dll``)."""
    env = os.environ if env is None else env
    return (
        os.name == "nt" and (Path(env.get("SYSTEMROOT", r"C:\Windows")) / "System32" / "nvcuda.dll").is_file()
    )


def ensure_dense_gpu(odm: OdmInstall, use_gpu: bool, env: Mapping[str, str] | None = None) -> bool:
    """Park ODM's placeholder ``nvcuda.dll`` (rename, never delete) when the app installed this ODM,
    the GPU is wanted and the real driver exists; otherwise put it back. Returns whether OpenMVS
    can use the graphics card for dense matching (deviation 17)."""
    env = os.environ if env is None else env
    if env.get(OWNED_ENV) != "1":
        return False
    stub, parked = odm.dir / STUB, odm.dir / PARKED
    want = use_gpu and nvcuda_present(env)
    with contextlib.suppress(OSError):  # a file in use stays as it is; the answer below says so
        if want:
            if stub.is_file() and stub.stat().st_size < STUB_MAX_BYTES:
                os.replace(stub, parked)  # a repair may have brought the stub back beside a parked copy
        elif parked.is_file() and not stub.exists():
            os.replace(parked, stub)
    return want and parked.is_file() and not stub.exists()


@dataclass(frozen=True)
class Machine:
    threads: int
    use_gpu: bool


def odm_memory_cap(env: Mapping[str, str] | None = None) -> int | None:
    """The memory limit set by hand, bytes (``AIO_ODM_MEMORY_CAP_MB``); None when there is none."""
    env = os.environ if env is None else env
    try:
        mb = float(env.get(MEMORY_CAP_ENV, ""))
    except ValueError:
        return None
    return int(max(64.0, mb) * 1024 * 1024)


def machine(env: Mapping[str, str] | None = None) -> Machine:
    env = os.environ if env is None else env
    threads = odm_threads(os.cpu_count() or 2, native.total_memory(), odm_memory_cap(env))
    return Machine(threads, gpu_wanted(env.get(GPU_ENV, "auto"), nvcuda_present(env)))


# ------------------------------------------------------------------------------ log reading


def stall_seconds(env: Mapping[str, str] | None = None) -> float:
    env = os.environ if env is None else env
    try:
        minutes = float(env.get(STALL_ENV, "30"))
    except ValueError:
        minutes = 30.0
    return max(0.01, minutes) * 60.0


def exit_error(code: int, lines: list[str]) -> JobError:
    if code in EXIT:
        return JobError(EXIT[code])
    last = ANSI.sub("", lines[-1]).strip() if lines else ""
    if code in BAD_INPUT:
        return JobError(f"ODM could not process these photos: {last or f'exit code {code}'}")
    return JobError(f"ODM stopped with exit code {code}{f': {last}' if last else ''}")


def finished_stages(text: str) -> list[str]:
    return [m.group(2) for m in STAGE_LINE.finditer(ANSI.sub("", text)) if m.group(1) == "Finished"]


def resume_from(text: str, first: str, last: str) -> str:
    lo, hi = stage_index(first), stage_index(last)
    done = {s for s in finished_stages(text) if s in STAGE_END and lo <= stage_index(s) <= hi}
    if not done:
        return first
    after = stage_after(max(done, key=stage_index))
    return after if after is not None and stage_index(after) <= hi else last


def parse_datagram(data: bytes, project_name: str) -> float | None:
    parts = data.decode("utf-8", errors="replace").strip().split("/")
    if len(parts) < 4 or parts[0] != "PGUP" or "/".join(parts[2:-1]) != project_name:
        return None
    try:
        pct = float(parts[-1])
    except ValueError:
        return None
    return pct if 0.0 <= pct <= 100.0 else None


class StageProgress:
    """ODM's stage lines and datagrams as the fraction of one step's window; never steps back
    (ODM's split and merge stages send 5 then 0, and skipped stages still send theirs)."""

    def __init__(self, first: str, last: str):
        self.lo, self.hi = stage_window(first, last)
        self.stage: str | None = None
        self.fraction: float | None = None
        self.message: str | None = None
        self.last_activity = time.monotonic()
        self._lock = threading.Lock()

    def _set(self, pct: float) -> float:
        span = self.hi - self.lo
        f = min(1.0, max(0.0, (pct - self.lo) / span)) if span > 0 else 1.0
        with self._lock:
            self.fraction = f if self.fraction is None else max(self.fraction, f)
            return self.fraction

    def feed_line(self, line: str) -> float | None:
        self.last_activity = time.monotonic()
        m = STAGE_LINE.search(ANSI.sub("", line))
        if m is None or m.group(2) not in STAGE_END:
            return None
        stage = m.group(2)
        if m.group(1) == "Running":
            self.stage, self.message = stage, STAGE_WORDS[stage]
            return self._set(stage_start(stage))
        return self._set(STAGE_END[stage])

    def feed_udp(self, percent: float) -> float | None:
        self.last_activity = time.monotonic()
        stage = self.stage
        if stage is None or not stage_start(stage) <= percent <= STAGE_END[stage]:
            return None
        return self._set(percent)


class UdpProgress:
    """Listens for ODM's progress datagrams; ``available`` is False when the port is taken."""

    def __init__(self, port: int, project_name: str, on_percent: Callable[[float], object]):
        self.port, self.name, self.on_percent = port, project_name, on_percent
        self.available = False
        self._sock: socket.socket | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def __enter__(self) -> UdpProgress:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
                s.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            s.bind(("127.0.0.1", self.port))
        except OSError:
            s.close()
            return self
        s.settimeout(0.2)
        self._sock, self.available = s, True
        self._thread = threading.Thread(target=self._read, name="odm-udp", daemon=True)
        self._thread.start()
        return self

    def _read(self) -> None:
        assert self._sock is not None
        while not self._stop.is_set():
            try:
                data = self._sock.recv(1024)
            except TimeoutError:
                continue
            except OSError:
                return
            pct = parse_datagram(data, self.name)
            if pct is not None:
                self.on_percent(pct)

    def __exit__(self, *exc: object) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
        if self._sock is not None:
            self._sock.close()


# ------------------------------------------------------------------------------ the GPU


@dataclass
class GpuUse:
    features: bool | None
    dense: bool | None
    fallbacks: list[str] = field(default_factory=list)

    def summary(self) -> str:
        parts = [
            f"for {what}: {'yes' if v else 'no'}"
            for what, v in (("features", self.features), ("dense matching", self.dense))
            if v is not None
        ]
        return f"Graphics card used {'; '.join(parts)}." if parts else ""

    def merge(self, other: GpuUse) -> GpuUse:
        def pick(a: bool | None, b: bool | None) -> bool | None:
            return True if True in (a, b) else False if False in (a, b) else None

        return GpuUse(
            pick(self.features, other.features),
            pick(self.dense, other.dense),
            [*self.fallbacks, *other.fallbacks],
        )


def _inside(stage: str, window: tuple[str, str]) -> bool:
    return stage_index(window[0]) <= stage_index(stage) <= stage_index(window[1])


def gpu_use(
    text: str,
    requested: bool,
    window: tuple[str, str] = ("dataset", "odm_postprocess"),
    dense_capable: bool = False,
) -> GpuUse:
    """What ODM's log says about the graphics card. A stage outside ``window`` was skipped by ODM,
    so the absence of its lines says nothing. ODM never logs OpenMVS's CUDA line (``-v 0``): with
    the stub parked (``dense_capable``) a dense run without a fallback line counts as the GPU."""
    fallbacks: list[str] = []
    if FEATURES_YES in text:
        features: bool | None = True
    elif FEATURES_NO in text:
        features = False
        fallbacks.append(FEATURES_FALLBACK)
    elif not requested and _inside("opensfm", window):
        features = False
    else:
        features = None
    dense_ran = _inside("openmvs", window) and "Running openmvs stage" in text
    if DENSE_YES.search(text):
        dense: bool | None = True
    elif DENSE_NO in text:
        dense = False
        fallbacks.append(DENSE_FALLBACK)
    elif dense_ran:
        dense = bool(dense_capable and requested)
    else:
        dense = None
    return GpuUse(features, dense, fallbacks)


def engine_record(odm: OdmInstall, gpu: GpuUse) -> dict:
    g = {k: v for k, v in (("features", gpu.features), ("dense", gpu.dense)) if v is not None}
    return {"name": "odm", "version": odm.version, "gpu": g}


# ------------------------------------------------------------------------------ running


def dtm_cloud_ok(project_dir: Path) -> bool:
    """The georeferenced cloud was made by a run with ``--dtm`` (ground points classified)."""
    try:
        mark = (project_dir / DTM_MARK).read_text("utf-8").strip()
        return mark == str((project_dir / GEOREF_LAZ).stat().st_mtime_ns)
    except OSError:
        return False


def odm_env(base: Mapping[str, str], use_gpu: bool) -> dict[str, str]:
    # with NoDefaultCurrentDirectoryInExePath set, run.bat cannot find winrun.bat and still exits 0
    env = {k: v for k, v in base.items() if not k.upper().startswith(_DROP_ENV)}
    env["ODM_NONINTERACTIVE"] = "1"
    if not use_gpu:
        env["ODM_NO_GPU"] = "1"
    return env


def odm_command(odm: OdmInstall, project_dir: Path, flags: Sequence[str]) -> str | list[str]:
    """ODM's command line; the project name stays last (ODM's positional argument)."""
    tail = [*flags, "--project-path", str(project_dir.parent), project_dir.name]
    if os.name == "nt":
        inner = subprocess.list2cmdline([str(odm.dir / "run.bat"), *tail])
        return f'"{os.environ.get("COMSPEC", "cmd.exe")}" /d /s /c "{inner}"'
    return ["sh", str(odm.dir / "run.sh"), *tail]


@dataclass
class OdmRun:
    log: Path
    gpu: GpuUse
    started_from: str | None


def _tail(log_dir: Path) -> list[str]:
    text = ""
    for name in ("tool.err", "tool.out"):
        with contextlib.suppress(OSError):
            text += (log_dir / name).read_text("utf-8", errors="replace") + "\n"
    return [ln for ln in text.splitlines() if ln.strip()]


def run_odm(
    ctx: StepContext,
    odm: OdmInstall,
    project_dir: Path,
    flags: Sequence[str],
    first: str,
    last: str,
    log_dir: Path,
    *,
    rerun: bool,
    use_gpu: bool,
    progress: tuple[float, float] = (0.0, 1.0),
    port: int = UDP_PORT,
) -> OdmRun:
    """Run ODM over the stages ``first`` to ``last`` of ``project_dir`` (flags without
    ``--rerun-from``, ``--end-with`` and the project); the bar moves over ``progress``."""
    log_dir.mkdir(parents=True, exist_ok=True)
    log, last_out = log_dir / "odm.log", log_dir / "tool.out"
    if last_out.exists():  # an attempt that was cancelled or failed: its lines count for the resume
        with open(log, "ab") as f:
            f.write(last_out.read_bytes())
        last_out.unlink()
    earlier = log.read_text("utf-8", errors="replace") if log.exists() else ""
    dtm = "--dtm" in flags
    start = resume_from(earlier, first, last) if rerun else None
    if start and dtm and stage_index(start) >= stage_index("odm_dem") and not dtm_cloud_ok(project_dir):
        # ODM would reuse a cloud without ground points and its DTM would never finish (14 Oct root cause)
        ctx.log(
            "The point cloud was not classified for a terrain model; ODM starts again from georeferencing."
        )
        start = "odm_georeferencing"
    args = [*flags, *(["--rerun-from", start] if start else []), "--end-with", last]
    if start and start != first and stage_index(start) > stage_index(first):
        ctx.log(f"Resuming ODM from the {STAGE_WORDS.get(start, start).lower()} stage.")
    dense_capable = ensure_dense_gpu(odm, use_gpu)
    sp = StageProgress(first, last)
    lo, hi = progress
    stall = stall_seconds()
    shown = [0.0]

    class _Bar:  # run_tool's view of the context: ODM's stage words, ODM's own fraction, the watchdog
        cancel_event = ctx.cancel_event

        @staticmethod
        def progress(f: float, m: str | None = None) -> None:
            # run_tool calls this every 0.1 s; raising here ends ODM's whole tree (its BaseException path)
            if time.monotonic() - sp.last_activity > stall:
                words = STAGE_WORDS.get(sp.stage or "", sp.stage or "current").lower()
                raise OdmStalled(
                    f"ODM stopped making progress in the {words} stage: nothing for {stall / 60:g} minutes. "
                    "Start the job again, or try the Fast preset."
                )
            real = sp.fraction if sp.fraction is not None else 0.2 * f
            shown[0] = max(shown[0], real)
            ctx.progress(lo + (hi - lo) * shown[0], sp.message or m)

    def ground_failed() -> OdmGroundFailed:
        return OdmGroundFailed(
            "ODM could not find the ground points, so it cannot make the terrain model (DTM). "
            "Look at the job log; untick DTM to make the other products."
        )

    def watch(line: str) -> float | None:
        # ODM swallows a failed SMRF ground classification and its DTM would then spin for ever
        if dtm and GROUND_FAIL.search(line):
            raise ground_failed()
        return sp.feed_line(line)

    with UdpProgress(port, project_dir.name, sp.feed_udp) as udp:
        if not udp.available:
            ctx.log(f"Port {port} is in use; ODM's progress comes from its stage lines.")
        try:
            native.run_tool(
                _Bar, odm_command(odm, project_dir, args), "ODM", log_dir, expected_s=3600.0,
                progress=(0.0, 1.0), memory_limit=odm_memory_cap() or 0,
                env=odm_env(os.environ, use_gpu), on_output=watch, fail=exit_error,
            )  # fmt: skip
        except JobError as e:
            for line in _tail(log_dir)[-TAIL_LINES:]:  # the last ODM lines always go to the job log
                ctx.log(f"ODM: {ANSI.sub('', line)}", "warn")
            if isinstance(e, native.ToolMemoryExceeded):
                raise JobError(OOM) from None
            raise
    text = last_out.read_text("utf-8", errors="replace") if last_out.exists() else ""
    err = (
        (log_dir / "tool.err").read_text("utf-8", errors="replace") if (log_dir / "tool.err").exists() else ""
    )
    if dtm and GROUND_FAIL.search(text + err):  # ODM ended before its line was read
        for line in _tail(log_dir)[-TAIL_LINES:]:
            ctx.log(f"ODM: {ANSI.sub('', line)}", "warn")
        raise ground_failed()
    with open(log, "a", encoding="utf-8") as f:
        f.write(text)
    last_out.unlink(missing_ok=True)
    gpu = gpu_use(text + err, use_gpu, (first, last), dense_capable)
    if dtm and stage_index(start or first) <= stage_index("odm_georeferencing") <= stage_index(last):
        laz = project_dir / GEOREF_LAZ
        if laz.exists():  # this cloud was classified for a DTM: a later --rerun-from odm_dem may use it
            (project_dir / DTM_MARK).write_text(str(laz.stat().st_mtime_ns), "utf-8")
    if gpu.summary():
        ctx.log(gpu.summary())
    for msg in gpu.fallbacks:
        ctx.log(msg, "warn")
    if use_gpu and gpu.dense is False and not gpu.fallbacks:
        ctx.log(DENSE_CPU_NOTE)
    ctx.progress(hi, sp.message)
    return OdmRun(log, gpu, start)
