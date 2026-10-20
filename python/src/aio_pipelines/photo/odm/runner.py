"""Run ODM (``run.bat``) as a job step: progress, cancel, resume, plain errors (ADR 0012).

Progress: ODM prints ``Running <stage> stage`` and ``Finished <stage> stage``; it also sends
``PGUP/<pid>/<project>/<percent>`` datagrams to 127.0.0.1:6367 (what NodeODM listens to). A step
covers a window of ODM's stages; stage lines move the bar to each stage's start and end, and a
datagram inside the running stage's own range refines it. When the port is taken, stage lines alone
drive the bar. Inside the alignment stage OpenSfM's own lines (``sfm_progress``) name the sub-step,
count its photos or pairs and move the bar; every update also tells the app when ODM last showed a
sign of life (``liveness``: lines, counts, files and CPU time). Cancel ends ODM's whole process
tree (``native.run_tool``). The watchdog (``Watchdog``) stops ODM only when, over the whole stall
window, it printed nothing, sent no progress and its process tree used almost no CPU (OpenMVS
densifies silently for hours on a large set); and, for a DTM, when the terrain program ran silently
past its own limit (the 14 Oct hang: one busy core for ever). Resume: each step keeps ODM's output
in ``<log_dir>/odm.log``; with ``rerun`` the next attempt starts ``--rerun-from`` the stage after
the last one finished (without it ODM's own rerun skips what is done).

ODM's program code is never changed. One exception (founder, 14 Oct 2026; deviation 17): in the
ODM folder the app installed itself, the placeholder ``nvcuda.dll`` beside OpenMVS is renamed so
dense matching can use the real NVIDIA driver (``ensure_dense_gpu``).
"""

from __future__ import annotations

import contextlib
import math
import os
import re
import socket
import subprocess
import threading
import time
from collections import deque
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path

from ...runtime import JobError, StepContext, replace_over
from .. import native, proctree
from .flags import STAGE_END, gpu_wanted, odm_threads, stage_after, stage_index, stage_span, stage_start
from .liveness import Liveness, iso_at
from .sfm_progress import SfmProgress, photo_count

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
STALL_DEFAULT_MIN = 60.0
#: Below this share of one core over the whole stall window, ODM's tree counts as idle.
BUSY_SHARE = 0.01
DEM_ENV = "AIO_ODM_DEM_MIN"
DEM_DEFAULT_MIN = 30.0
DEM_PROGRAM = "renderdem"  # ODM's DSM and DTM program; with no ground points it never finishes
UNDISTORT_EVERY_S = 2.0  # how often the undistorted photos are counted while ODM writes them
_DROP_ENV = (
    "PYTHON",
    "VIRTUAL_ENV",
    "CONDA_",
    "NODEFAULTCURRENTDIRECTORYINEXEPATH",
)


class OdmStalled(JobError):
    """ODM printed nothing, sent no progress and used almost no CPU for ``stall_seconds()``: its
    tree is ended."""


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
                replace_over(stub, parked)  # a repair may have brought the stub back beside a parked copy
        elif parked.is_file() and not stub.exists():
            replace_over(parked, stub)
    return want and parked.is_file() and not stub.exists()


@dataclass(frozen=True)
class Machine:
    threads: int
    use_gpu: bool


def _positive(value: str | None) -> float | None:
    """A finite number above zero, else None (unset, not a number, zero, negative, inf, nan)."""
    try:
        v = float(value or "")
    except ValueError:
        return None
    return v if math.isfinite(v) and v > 0 else None


def odm_memory_cap(env: Mapping[str, str] | None = None) -> int | None:
    """The memory limit set by hand, bytes (``AIO_ODM_MEMORY_CAP_MB``); None when there is none."""
    env = os.environ if env is None else env
    mb = _positive(env.get(MEMORY_CAP_ENV))
    return None if mb is None else int(max(64.0, mb) * 1024 * 1024)


def machine(env: Mapping[str, str] | None = None) -> Machine:
    env = os.environ if env is None else env
    threads = odm_threads(os.cpu_count() or 2, native.total_memory(), odm_memory_cap(env))
    return Machine(threads, gpu_wanted(env.get(GPU_ENV, "auto"), nvcuda_present(env)))


# ------------------------------------------------------------------------------ log reading


def stall_seconds(env: Mapping[str, str] | None = None) -> float:
    """How long ODM may stay silent and idle before it is stopped (``AIO_ODM_STALL_MIN``, default
    60 minutes)."""
    env = os.environ if env is None else env
    minutes = _positive(env.get(STALL_ENV))
    return (STALL_DEFAULT_MIN if minutes is None else minutes) * 60.0


def dem_seconds(env: Mapping[str, str] | None = None) -> float:
    """How long the terrain program may run silently in a DTM run (``AIO_ODM_DEM_MIN``, default 30
    minutes; the real DTM of 24 photos takes 10 to 25 seconds)."""
    env = os.environ if env is None else env
    minutes = _positive(env.get(DEM_ENV))
    return (DEM_DEFAULT_MIN if minutes is None else minutes) * 60.0


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
    (ODM's split and merge stages send 5 then 0, and skipped stages still send theirs). Each stage
    holds its ``stage_span`` of the step. Inside ``opensfm`` the OpenSfM sub-steps (``sfm``) move
    the bar; a datagram stays a backup there."""

    def __init__(self, first: str, last: str, sfm: SfmProgress | None = None):
        self.first, self.last, self.sfm = first, last, sfm
        self.stage: str | None = None
        self.fraction: float | None = None
        self.message: str | None = None
        self.last_activity = time.monotonic()
        self.stage_started_at: float | None = None  # wall clock
        self._udp_within = 0.0  # the running stage's share done by ODM's datagrams
        self._lock = threading.Lock()

    def _set(self, stage: str, within: float) -> float:
        """Under the lock: the bar at ``within`` (0..1) of ``stage``, never back."""
        if stage == "opensfm" and self.sfm is not None:
            within = max(within, self.sfm.fraction())
        lo, hi = stage_span(self.first, self.last, stage)
        f = min(1.0, max(0.0, lo + (hi - lo) * within))
        self.fraction = f if self.fraction is None else max(self.fraction, f)
        return self.fraction

    def feed_line(self, line: str) -> float | None:
        self.last_activity = time.monotonic()
        clean = ANSI.sub("", line)
        m = STAGE_LINE.search(clean)
        with self._lock:
            if m is not None and m.group(2) in STAGE_END:
                stage = m.group(2)
                if m.group(1) == "Running":
                    self.stage, self.message = stage, STAGE_WORDS[stage]
                    self.stage_started_at, self._udp_within = time.time(), 0.0
                    if stage == "opensfm" and self.sfm is not None:
                        self.sfm.feed(clean)  # the sub-steps start with the stage
                    return self._set(stage, 0.0)
                if stage == "opensfm" and self.sfm is not None:
                    self.sfm.finish()
                return self._set(stage, 1.0)
            if self.stage == "opensfm" and self.sfm is not None and self.sfm.feed(clean):
                return self._set("opensfm", self._udp_within)
        return None

    def feed_udp(self, percent: float) -> float | None:
        self.last_activity = time.monotonic()
        stage = self.stage
        if stage is None or not stage_start(stage) <= percent <= STAGE_END[stage]:
            return None
        span = STAGE_END[stage] - stage_start(stage)
        with self._lock:
            within = (percent - stage_start(stage)) / span if span > 0 else 1.0
            self._udp_within = max(self._udp_within, within)
            return self._set(stage, self._udp_within)

    def set_undistorted(self, n: int) -> bool:
        """The undistorted photos written so far (inside ``opensfm``); True when the count rose."""
        with self._lock:
            if self.stage != "opensfm" or self.sfm is None or not self.sfm.set_undistorted(n):
                return False
            self._set("opensfm", self._udp_within)
            return True

    def finish(self) -> None:
        """ODM ended well: the alignment is done, even if its last lines were not read in time."""
        with self._lock:
            if self.sfm is not None:
                self.sfm.finish()

    def current(self) -> str | None:
        """The OpenSfM sub-step running now (its key), else None."""
        with self._lock:
            return self.sfm.current if self.stage == "opensfm" and self.sfm is not None else None

    def detail(self) -> dict | None:
        """The running OpenSfM sub-step's detail, without the estimate (cheap: read on every line)."""
        with self._lock:
            sfm = self.sfm
            return sfm.detail() if self.stage == "opensfm" and sfm is not None else None

    def sub_step(self) -> tuple[dict | None, float | None, float | None]:
        """Inside ``opensfm``: the sub-step's detail, its estimate (seconds) and its start (wall
        clock); otherwise no detail, no estimate and the stage's start."""
        with self._lock:
            sfm = self.sfm
            if self.stage == "opensfm" and sfm is not None and sfm.current is not None:
                return sfm.detail(), sfm.eta_seconds(), sfm.step_started_at
            return None, None, self.stage_started_at


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


class Watchdog:
    """``native.run_tool``'s ``on_poll`` for ODM: samples the CPU time of ODM's process tree and
    raises when ODM has stalled. Stalled: over the whole stall window no output line, no progress
    and less than ``BUSY_SHARE`` of one core. A DTM run also fails when ``DEM_PROGRAM`` has run
    silently for ``dem_seconds()`` (it spins on one core when there are no ground points)."""

    def __init__(self, sp: StageProgress, stall: float, dem: float | None):
        self.sp, self.stall, self.dem = sp, stall, dem
        self.every = min(30.0, max(0.5, min(stall, dem or stall) / 10))
        self.cpu = proctree.TreeCpu()
        self.samples: deque[tuple[float, float]] = deque()
        self.next = 0.0

    def __call__(self, proc: subprocess.Popen) -> None:
        now = time.monotonic()
        if now < self.next:
            return
        self.next = now + self.every
        self.samples.append((now, self.cpu.sample(proc.pid)))
        while len(self.samples) > 1 and self.samples[1][0] <= now - self.stall:
            self.samples.popleft()  # the first sample left is the newest one a whole window old
        quiet = now - self.sp.last_activity
        if self.dem is not None and quiet > self.dem and self._dem_since(time.time() - self.dem, proc.pid):
            raise OdmGroundFailed(
                f"ODM's terrain model (DTM) made no progress for {self.dem / 60:g} minutes; this happens "
                "when ODM finds no ground points. Make the maps again without the DTM."
            )
        t0, used0 = self.samples[0]
        busy = self.samples[-1][1] - used0 >= BUSY_SHARE * (now - t0)
        if quiet > self.stall and now - t0 >= self.stall and not busy:
            words = STAGE_WORDS.get(self.sp.stage or "", self.sp.stage or "current").lower()
            raise OdmStalled(
                f"ODM stopped making progress in the {words} stage: nothing for {self.stall / 60:g} minutes. "
                "Start the job again, or try the Fast preset.",
                code="odm-stalled",
                data={"minutes": self.stall / 60},
            )

    @staticmethod
    def _dem_since(before: float, pid: int) -> bool:
        """The terrain program is in ODM's tree and started no later than ``before``."""
        for p, name in proctree.tree_programs(pid):
            if Path(name).stem.lower() == DEM_PROGRAM:
                started = proctree.process_started(p)
                if started is None or started <= before:
                    return True
        return False


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
    # ODM's stdout goes to a file, which Python block-buffers: its stage lines (progress, the stall
    # watchdog, GPU and ground-failure lines) would otherwise arrive only when it exits
    env["PYTHONUNBUFFERED"] = "1"
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


def _tail(out: Path) -> list[str]:
    text = ""
    for path in (out.with_suffix(".err"), out):
        with contextlib.suppress(OSError):
            text += path.read_text("utf-8", errors="replace") + "\n"
    return [ln for ln in text.splitlines() if ln.strip()]


ATTEMPT = re.compile(r"tool(?:-(\d+))?\.(?:out|err)")


def _attempt_number(path: Path) -> int:
    m = ATTEMPT.fullmatch(path.name)
    return int(m.group(1) or 0) if m else -1


def _next_attempt(log_dir: Path, log: Path) -> Path:
    """Fold the output of earlier attempts (cancelled, failed, or of an ODM that outlived its app)
    into ``log`` (their lines count for the resume), and name this attempt's output file. An
    earlier output file still held by a running ODM cannot be deleted, so every attempt writes its
    own: ``tool-<n>.out``."""
    files = sorted((p for p in log_dir.glob("tool*.*") if _attempt_number(p) >= 0), key=_attempt_number)
    for path in files:
        if path.suffix == ".out":
            with contextlib.suppress(OSError), open(log, "ab") as f:
                f.write(path.read_bytes())
        with contextlib.suppress(OSError):
            path.unlink()
    used = [_attempt_number(p) for p in log_dir.glob("tool*.*") if _attempt_number(p) >= 0]
    return log_dir / f"tool-{max(used, default=0) + 1}.out"


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
    log = log_dir / "odm.log"
    last_out = _next_attempt(log_dir, log)
    last_err = last_out.with_suffix(".err")
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
    # the OpenSfM sub-steps only when ODM aligns in this run (it names skipped stages too)
    aligns = stage_index(start or first) <= stage_index("opensfm") <= stage_index(last)
    sfm = SfmProgress(lambda: photo_count(project_dir)) if aligns else None
    sp = StageProgress(first, last, sfm)
    liveness = Liveness(project_dir)
    lo, hi = progress
    # run_tool calls it every 0.1 s; raising there ends ODM's whole tree (its BaseException path)
    watchdog = Watchdog(sp, stall_seconds(), dem_seconds() if dtm else None)
    shown = [0.0]
    told: list[str | None] = [None, None]  # the sub-step logged, the sub-step waiting for its total

    def bar(fraction: float, fallback: str | None) -> None:
        detail, eta, started = sp.sub_step()
        live: dict = {"lastActivityAt": iso_at(liveness.last_at)}
        if started is not None:
            live["stepStartedAt"] = iso_at(started)
        if detail is not None:
            live["detail"] = detail
        if eta is not None:
            live["etaSeconds"] = eta
        ctx.progress(fraction, (detail or {}).get("label") or sp.message or fallback, live=live)

    class _Bar:  # run_tool's view of the context: ODM's stage words and ODM's own fraction
        cancel_event = ctx.cancel_event

        @staticmethod
        def progress(f: float, m: str | None = None) -> None:
            # called on every poll tick too, so activity seen only in CPU time or files still goes out
            real = sp.fraction if sp.fraction is not None else 0.2 * f
            shown[0] = max(shown[0], real)
            bar(lo + (hi - lo) * shown[0], m)

    def announce() -> None:
        """One job-log line per sub-step: its label, with its total once known (or once counting
        starts without one)."""
        detail = sp.detail()
        key = detail and detail["label"]
        if key == told[0]:
            return
        if told[1] is not None and told[1] != key:  # ended before its total was known
            ctx.log(told[1])
            told[0] = told[1]
        told[1] = None
        if detail is None:
            return
        if "total" in detail:
            ctx.log(f"{key}: {detail['total']:,} {detail['unit']}")
        elif "unit" not in detail or detail["done"]:
            ctx.log(key)
        else:
            told[1] = key
            return
        told[0] = key

    def ground_failed() -> OdmGroundFailed:
        return OdmGroundFailed(
            "ODM found no ground points, so it cannot make a terrain model (DTM) for this run."
        )

    def watch(line: str) -> float | None:
        # ODM swallows a failed SMRF ground classification and its DTM would then spin for ever
        if dtm and GROUND_FAIL.search(line):
            raise ground_failed()
        liveness.touch()
        f = sp.feed_line(line)
        if sfm is not None:
            announce()
        return f

    undistorted = project_dir / "opensfm" / "undistorted" / "images"
    next_count = [0.0]

    def poll(proc: subprocess.Popen) -> None:
        liveness.poll(proc.pid)
        if sp.current() == "undistort" and time.monotonic() >= next_count[0]:
            next_count[0] = time.monotonic() + UNDISTORT_EVERY_S
            with contextlib.suppress(OSError):
                if sp.set_undistorted(sum(1 for _ in undistorted.glob("*.tif"))):
                    liveness.touch()
                    announce()
        watchdog(proc)

    with UdpProgress(port, project_dir.name, sp.feed_udp) as udp:
        if not udp.available:
            ctx.log(f"Port {port} is in use; ODM's progress comes from its stage lines.")
        try:
            native.run_tool(
                _Bar, odm_command(odm, project_dir, args), "ODM", log_dir, expected_s=3600.0,
                progress=(0.0, 1.0), memory_limit=odm_memory_cap() or 0,
                env=odm_env(os.environ, use_gpu), on_output=watch, fail=exit_error, on_poll=poll,
                log_name=last_out.stem,
            )  # fmt: skip
        except JobError as e:
            for line in _tail(last_out)[-TAIL_LINES:]:  # the last ODM lines always go to the job log
                ctx.log(f"ODM: {ANSI.sub('', line)}", "warn")
            if isinstance(e, native.ToolMemoryExceeded):
                raise JobError(OOM) from None
            raise
    sp.finish()  # run_tool stops reading when ODM exits: no stale sub-step on the last update
    if sfm is not None:
        announce()
    text = last_out.read_text("utf-8", errors="replace") if last_out.exists() else ""
    err = last_err.read_text("utf-8", errors="replace") if last_err.exists() else ""
    if dtm and GROUND_FAIL.search(text + err):  # ODM ended before its line was read
        for line in _tail(last_out)[-TAIL_LINES:]:
            ctx.log(f"ODM: {ANSI.sub('', line)}", "warn")
        raise ground_failed()
    with open(log, "a", encoding="utf-8") as f:
        f.write(text)
    for path in (last_out, last_err):
        with contextlib.suppress(OSError):
            path.unlink()
    # ODM prints Running/Finished for the stages before --rerun-from too: only the stages that ran count
    gpu = gpu_use(text + err, use_gpu, (start or first, last), dense_capable)
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
    bar(hi, sp.message)
    return OdmRun(log, gpu, start)
