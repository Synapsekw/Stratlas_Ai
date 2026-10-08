"""Native tools, memory and disk for ``photo.products``.

Native tools are optional command-line programs in the pipeline pack's ``tools/`` folder or on
this machine; each is found like PDAL (``pointcloud.find_pdal``): an environment variable, then
``<pack>/tools/<name>/``, then the PATH. Every caller has a pure-Python path when a tool is
missing, so a pack without the tool still produces the product (and says which engine ran). Since
8 Oct 2026 the pack ships only PDAL (conda-forge's build); the others are local builds a person
points at, and the mesh's primary engine is MeshLab (``pymeshlab``, ``mesh.py``).

| Tool          | Variable              | Pack folder                | Licence                                  |
| ------------- | --------------------- | -------------------------- | ---------------------------------------- |
| ``texrecon``  | ``AIO_TEXRECON``      | ``tools/texrecon/``        | BSD-3 (mvs-texturing, mapMAP not gco)    |
| ``PoissonRecon`` | ``AIO_POISSONRECON`` | ``tools/poissonrecon/``   | MIT (mkazhdan/PoissonRecon)              |
| ``SurfaceTrimmer`` | ``AIO_SURFACETRIMMER`` | ``tools/poissonrecon/`` | MIT (same repository)                    |
| ``pdal``      | ``AIO_PDAL``          | ``tools/pdal/`` (shipped)  | BSD-3 (conda-forge build, GPL/LGPL deps) |

``run_tool`` runs one cancellably: output to files (a full pipe would block the child), stdin
closed, no console window, and on cancel the whole process tree is killed (``taskkill /T`` on
Windows), so no orphan keeps running after the job stops.

Memory: ``AIO_PHOTO_MEMORY_MB`` is the one memory cap of the photo jobs (the app sets it from
Settings). ``photo.products`` plans within it (``memory_budget``; without it 40 % of the physical
memory) and ``photo.align`` stops a COLMAP stage above it (``colmap_io.memory_limit``; without it
75 % of the memory and 90 % of what is free).
"""

from __future__ import annotations

import ctypes
import os
import shutil
import subprocess
import sys
import time
from collections.abc import Sequence
from pathlib import Path

from ..runtime import Cancelled, JobError, StepContext

TOOLS = {
    "texrecon": ("AIO_TEXRECON", "texrecon"),
    "PoissonRecon": ("AIO_POISSONRECON", "poissonrecon"),
    "SurfaceTrimmer": ("AIO_SURFACETRIMMER", "poissonrecon"),
}
GB = 1024**3


def find_tool(name: str) -> str | None:
    """The path of a native tool, or None when this pack does not have it."""
    env_name, folder = TOOLS[name]
    env = os.environ.get(env_name)
    if env:
        return env if Path(env).is_file() else None
    exe = f"{name}.exe" if os.name == "nt" else name
    pack = Path(sys.prefix).parent / "tools" / folder
    for cand in (pack / exe, pack / "bin" / exe):
        if cand.is_file():
            return str(cand)
    return shutil.which(name)


def _kill_tree(proc: subprocess.Popen) -> None:
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/T", "/F", "/PID", str(proc.pid)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            check=False,
        )
    else:
        try:
            os.killpg(proc.pid, 9)
        except OSError:
            proc.kill()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()


class ToolMemoryExceeded(JobError):
    """A native tool passed its memory limit and was stopped."""


def run_tool(
    ctx: StepContext,
    args: Sequence[str],
    what: str,
    work: Path,
    expected_s: float = 60.0,
    progress: tuple[float, float] = (0.0, 0.95),
    memory_limit: int = 0,
    env: dict[str, str] | None = None,
) -> str:
    """Run a native tool; return its stdout, or raise with the last line it printed. With
    ``memory_limit`` (bytes) the tool and its children are stopped above it
    (``ToolMemoryExceeded``), so a tool never pushes the computer into swapping."""
    work.mkdir(parents=True, exist_ok=True)
    out_path, err_path = work / "tool.out", work / "tool.err"
    kw: dict = {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)}
    if os.name != "nt":
        kw = {"start_new_session": True}
    if env is not None:
        kw["env"] = env
    with open(out_path, "wb") as out_f, open(err_path, "wb") as err_f:
        try:
            proc = subprocess.Popen(list(args), stdin=subprocess.DEVNULL, stdout=out_f, stderr=err_f, **kw)
        except OSError as e:
            raise JobError(f"{what}: the tool {Path(args[0]).name} could not start ({e}).") from e
        t0 = time.monotonic()
        lo, hi = progress
        last_mem = 0.0
        while proc.poll() is None:
            if ctx.cancel_event.is_set():
                _kill_tree(proc)
                raise Cancelled()
            if memory_limit and time.monotonic() - last_mem >= 0.5:
                from .colmap_io import tree_memory

                last_mem = time.monotonic()
                used = tree_memory(proc.pid)
                if used > memory_limit:
                    _kill_tree(proc)
                    raise ToolMemoryExceeded(
                        f"{what} stopped: it needed more than {memory_limit / 1e9:.1f} GB of memory."
                    )
            frac = min(1.0, (time.monotonic() - t0) / max(1.0, expected_s))
            ctx.progress(lo + (hi - lo) * frac * 0.95, what)
            time.sleep(0.1)
    out = out_path.read_text("utf-8", errors="replace")
    if proc.returncode != 0:
        err = err_path.read_text("utf-8", errors="replace")
        lines = (err or out or "").strip().splitlines()
        raise JobError(f"{what} failed: {lines[-1] if lines else f'exit {proc.returncode}'}")
    return out


# ---------------------------------------------------------------------------------- memory, disk


def total_memory() -> int:
    """Physical memory in bytes (0 when it cannot be read)."""
    try:
        if os.name == "nt":

            class MemStatus(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            st = MemStatus()
            st.dwLength = ctypes.sizeof(MemStatus)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st))  # type: ignore[attr-defined]
            return int(st.ullTotalPhys)
        return int(os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES"))
    except (OSError, ValueError, AttributeError):
        return 0


MEMORY_ENV = "AIO_PHOTO_MEMORY_MB"


def memory_cap() -> int | None:
    """The photo jobs' memory cap in bytes from ``AIO_PHOTO_MEMORY_MB`` (at least 64 MB), or None
    when it is not set (or not a number).

    One setting for every photo job: the app sets it from Settings. ``photo.products`` plans its
    clusters within it (``memory_budget``) and ``photo.align``'s memory guard stops a COLMAP stage
    that goes above it (``colmap_io.memory_limit``)."""
    env = os.environ.get(MEMORY_ENV)
    if not env:
        return None
    try:
        return max(64, int(float(env))) * 1024 * 1024
    except ValueError:
        return None


def tool_threads(cap: int = 8) -> int:
    """Threads for a native tool: this computer's cores, at most ``cap`` (a small machine is not
    oversubscribed, a large one is not flooded by a library's own default)."""
    return max(1, min(os.cpu_count() or 1, cap))


def memory_budget() -> int:
    """Bytes the heavy stages may hold at once: ``AIO_PHOTO_MEMORY_MB`` when set (the app passes
    the cap from Settings), else 40% of physical memory, at least 512 MB."""
    cap = memory_cap()
    if cap:
        return cap
    total = total_memory() or 8 * GB
    return max(512 * 1024 * 1024, int(total * 0.4))


def peak_memory() -> int:
    """Peak resident memory of this process so far, bytes (0 when unknown)."""
    try:
        if os.name == "nt":

            class Counters(ctypes.Structure):
                _fields_ = [
                    ("cb", ctypes.c_ulong),
                    ("PageFaultCount", ctypes.c_ulong),
                    ("PeakWorkingSetSize", ctypes.c_size_t),
                    ("WorkingSetSize", ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                    ("PagefileUsage", ctypes.c_size_t),
                    ("PeakPagefileUsage", ctypes.c_size_t),
                ]

            c = Counters()
            c.cb = ctypes.sizeof(Counters)
            psapi = ctypes.WinDLL("psapi")
            kernel = ctypes.windll.kernel32  # type: ignore[attr-defined]
            kernel.GetCurrentProcess.restype = ctypes.c_void_p
            psapi.GetProcessMemoryInfo.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ulong]
            psapi.GetProcessMemoryInfo(kernel.GetCurrentProcess(), ctypes.byref(c), c.cb)
            return int(c.PeakWorkingSetSize)
        import resource

        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return int(peak if sys.platform == "darwin" else peak * 1024)
    except (OSError, AttributeError, ImportError):
        return 0


def _gb(n: float) -> str:
    return f"{n / GB:.1f} GB" if n >= GB else f"{n / 1024**2:.0f} MB"


def check_disk(folder: Path, needed: int) -> int:
    """Refuse with both numbers when the drive of ``folder`` has less than ``needed`` bytes free."""
    free = shutil.disk_usage(folder).free
    if free < needed:
        drive = Path(folder).resolve().anchor.rstrip("\\/") or str(folder)
        raise JobError(f"Creating these products needs {_gb(needed)} free on {drive}, which has {_gb(free)}.")
    return free
