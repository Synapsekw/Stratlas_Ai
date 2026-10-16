"""pointcloud.to_copc: LAS, LAZ, E57, PLY or a Bentley .zpc to a COPC file in the project CRS, with PDAL.

PDAL runs as its command-line tool (``pdal``), found in this order: the ``AIO_PDAL`` environment
variable, ``tools/pdal`` inside the pipeline pack, then the PATH. The pack's PDAL is conda-forge's
``libpdal-core`` build (``tools/pipeline-pack/pdal.mjs``): ``Library/bin/pdal.exe`` on Windows,
``bin/pdal`` on macOS, with its PROJ and GDAL data in ``share/`` beside ``bin/``; ``pdal_env``
points PDAL at that data wherever the pack was installed, and keeps PROJ off the network.

The COPC is built by the photo pipeline's shared writer (``photo.cloud_out.write_copc``): untwine,
out of core on all cores with its own progress, else PDAL's ``writers.copc`` in memory. The cloud
is reprojected to the project CRS only when its header declares another CRS (``source_epsg``);
untwine cannot reproject, so PDAL first streams it into a temporary LAS in the job's staging
folder (its progress is the share of points written), which is also how an E57 or PLY becomes
the LAS the writer reads. A source without a CRS is taken as already in the project CRS. The
layer is added to the project manifest last (data-conventions section 4: ``format: "copc"``,
project CRS).

A Bentley ``.zpc`` (a ZIP of LAS/LAZ tiles) is unpacked into the staging folder, each tile
reprojected when needed, and the folder of tiles becomes one COPC (``convert_zpc``).

A ``surveyDate`` (YYYY-MM-DD) files a newly added layer under the project's date of that day,
adding one when there is none (``captures.capture_for_date``), in the same manifest write.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from datetime import date
from pathlib import Path
from typing import Any

from .captures import capture_for_date
from .params import known_keys, number, numbers, text
from .runtime import JobError, Step, StepContext, atomic_write_json, commit_files, safe_project_path

PDAL_MISSING = (
    "PDAL is not available: the pipeline pack has no tools/pdal and none is on the PATH. "
    "Install the full pipeline pack, or set AIO_PDAL to pdal.exe."
)
CLOUD_EXTENSIONS = {".las", ".laz", ".e57", ".ply", ".zpc"}
#: What the COPC writer reads directly; anything else becomes a LAS first.
LAS_EXTENSIONS = {".las", ".laz"}
LAS_HEADER = 375  # a LAS 1.4 header; its few VLRs are noise next to the points
BUILDING = "Building the viewable cloud"
#: The convert step's progress: reading the header, then the reprojection (when needed), then the
#: COPC build up to the end.
READ_END, PREPARE_END, BUILD_END = 0.02, 0.35, 0.99
#: untwine's temporary folder, bytes a point (photo.cloud_out measured about 92).
UNTWINE_TEMP_BYTES_PER_POINT = 92
#: A COPC (LAZ) file, bytes a point, generously (colour and classes compress to about 10).
COPC_BYTES_PER_POINT = 16
#: An intermediate LAS whose record length the source cannot tell (E57, PLY): point format 7.
DEFAULT_RECORD = 36
TOO_BIG_WITHOUT_UNTWINE = (
    "This point cloud is too large to convert without untwine. Install pipeline pack 0.6.1 or later."
)
#: Seconds without any sign of work before the build's text says so (the job carries on).
STALL_S = 300
#: How often the build's watch samples its activity and updates the text, seconds.
WATCH_EVERY_S = 2.0
WATCH_THREAD = "pointcloud-build-watch"
#: How long leaving the watch waits for its thread, seconds. A sample stuck past it (a hung
#: process query) is left behind: the thread is a daemon and the build carries on.
WATCH_JOIN_S = 30.0


def find_pdal() -> str | None:
    env = os.environ.get("AIO_PDAL")
    if env and Path(env).is_file():
        return env
    exe = "pdal.exe" if os.name == "nt" else "pdal"
    pack = Path(sys.prefix).parent / "tools" / "pdal"
    for cand in (pack / "Library" / "bin" / exe, pack / "bin" / exe):
        if cand.is_file():
            return str(cand)
    return shutil.which("pdal")


def pdal_env(exe: str) -> dict[str, str]:
    """The environment PDAL runs in: this process's, plus the PROJ and GDAL data of a conda-style
    PDAL (``<exe>/../../share/proj``, as the pack's is; conda's activation scripts are never run)
    and, on Windows, its folder first on the PATH. A PDAL without such data keeps the environment."""
    env = dict(os.environ)
    share = Path(exe).resolve().parent.parent / "share"
    if (share / "proj" / "proj.db").is_file():
        env["PROJ_DATA"] = str(share / "proj")
        env["PROJ_LIB"] = str(share / "proj")
        env.setdefault("PROJ_NETWORK", "OFF")
    if (share / "gdal").is_dir():
        env["GDAL_DATA"] = str(share / "gdal")
    if os.name == "nt":
        env["PATH"] = str(Path(exe).resolve().parent) + os.pathsep + env.get("PATH", "")
    return env


def elapsed(seconds: float) -> str:
    """``42 s``, ``3 min 20 s`` or ``1 h 05 min``."""
    s = int(seconds)
    if s < 60:
        return f"{s} s"
    if s < 3600:
        return f"{s // 60} min {s % 60} s"
    return f"{s // 3600} h {s % 3600 // 60:02d} min"


def _run(
    ctx: StepContext,
    args: list[str],
    what: str,
    band: tuple[float, float] = (0.0, 0.0),
    measure: Callable[[], float | None] | None = None,
) -> str:
    """Run PDAL, cancellable (the cancel event kills it); return its stdout or raise with its
    message. Progress moves through ``band`` by ``measure`` (a fraction of the work done) when it
    gives one; otherwise the bar holds at the band's start and the text says how long it has run.

    Output goes to files in the job folder (a full pipe would block PDAL) and stdin is closed.
    """
    out_path = ctx.job.dir / "pdal.out"
    err_path = ctx.job.dir / "pdal.err"
    lo, hi = band
    with open(out_path, "wb") as out_f, open(err_path, "wb") as err_f:
        proc = subprocess.Popen(
            args,
            stdin=subprocess.DEVNULL,
            stdout=out_f,
            stderr=err_f,
            env=pdal_env(args[0]),
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        t0 = time.monotonic()
        shown = 0.0
        try:
            while proc.poll() is None:
                if ctx.cancel_event.is_set():
                    proc.kill()
                    proc.wait()
                    ctx.check()
                share = measure() if measure is not None else None
                if share is not None:
                    shown = max(shown, min(1.0, share))
                    ctx.progress(lo + (hi - lo) * shown, what)
                else:
                    ctx.progress(lo + (hi - lo) * shown, f"{what}, {elapsed(time.monotonic() - t0)} so far")
                time.sleep(0.1)
        except BaseException:
            if proc.poll() is None:  # never leave PDAL running
                proc.kill()
                proc.wait()
            raise
    out = out_path.read_text("utf-8", errors="replace")
    err = err_path.read_text("utf-8", errors="replace")
    if proc.returncode != 0:
        msg = (err or out or "").strip().splitlines()
        raise JobError(
            f"PDAL could not finish {what.lower()}: {msg[-1] if msg else f'exit {proc.returncode}'}"
        )
    return out


def read_summary(ctx: StepContext, pdal: str, src: Path) -> dict[str, Any]:
    """PDAL's summary of a cloud: ``num_points``, ``srs`` (``wkt``, ``horizontal``, ``json``)."""
    info = json.loads(_run(ctx, [pdal, "info", "--summary", str(src)], "Reading the cloud"))
    return info.get("summary", {})


_WKT_EPSG = re.compile(r'(?:AUTHORITY\["EPSG",\s*"(\d+)"\]|ID\["EPSG",\s*(\d+)\])\s*\]\s*$')


def source_epsg(srs: dict[str, Any]) -> int | None:
    """The EPSG code of a cloud's horizontal CRS from PDAL's ``srs`` summary: the PROJJSON
    ``id`` (a compound CRS's first component), else the horizontal WKT's own authority. None when
    the file has no CRS or one without an EPSG code."""
    j = srs.get("json")
    if isinstance(j, dict):
        if j.get("type") == "CompoundCRS" and j.get("components"):
            j = j["components"][0]
        ident = j.get("id") if isinstance(j, dict) else None
        if isinstance(ident, dict) and str(ident.get("authority", "")).upper() == "EPSG":
            try:
                return int(ident["code"])
            except (KeyError, TypeError, ValueError):
                pass
    for key in ("horizontal", "wkt"):
        m = _WKT_EPSG.search(str(srs.get(key) or "").strip())
        if m:
            return int(m.group(1) or m.group(2))
    return None


def las_record_length(path: Path) -> int | None:
    """The point record length in a LAS or LAZ header (bytes 105 and 106), else None."""
    try:
        with open(path, "rb") as f:
            head = f.read(107)
    except OSError:
        return None
    if len(head) < 107 or head[:4] != b"LASF":
        return None
    return int.from_bytes(head[105:107], "little") or None


def written_share(dst: Path, points: int, record: int) -> Callable[[], float]:
    """How much of an uncompressed LAS of ``points`` points of ``record`` bytes PDAL has written,
    from the file's size (at most 0.99 until PDAL is done)."""
    total = max(1, points * record)

    def share() -> float:
        try:
            size = dst.stat().st_size
        except OSError:
            return 0.0
        return min(0.99, max(0.0, size - LAS_HEADER) / total)

    return share


def prepare_las(
    ctx: StepContext,
    pdal: str,
    src: Path,
    dst: Path,
    epsg: int | None,
    points: int,
    band: tuple[float, float],
) -> None:
    """``src`` as an uncompressed LAS ``dst`` the COPC writer reads, reprojected to ``epsg`` when
    given. PDAL streams it (every stage here streams for LAS and LAZ), so memory stays flat."""
    writer: dict[str, Any] = {
        "type": "writers.las",
        "filename": str(dst),
        "forward": "major_version,minor_version,dataformat_id",
        "extra_dims": "all",
    }
    stages: list[Any] = [str(src)]
    if epsg:
        stages.append({"type": "filters.reprojection", "out_srs": f"EPSG:{epsg}"})
        # a new CRS needs new offsets (from the first point, as PDAL streams) and a millimetre scale
        writer.update({f"scale_{a}": 0.001 for a in "xyz"})
        writer.update({f"offset_{a}": "auto" for a in "xyz"})
        writer["a_srs"] = f"EPSG:{epsg}"
    stages.append(writer)
    pipe = ctx.stage("prepare-pipeline.json")
    atomic_write_json(pipe, {"pipeline": stages})
    record = las_record_length(src)
    measure = written_share(dst, points, record) if record and points else None
    what = "Reprojecting the cloud" if epsg else "Reading the cloud into LAS"
    try:
        _run(ctx, [pdal, "pipeline", str(pipe)], what, band, measure)
    finally:
        pipe.unlink(missing_ok=True)
    if not dst.is_file():
        raise JobError("PDAL finished without writing the intermediate LAS file.")


def disk_needed(points: int, record: int | None) -> int:
    """Bytes the conversion holds on the staging drive at once: the intermediate LAS when there
    is one (``record`` bytes a point), untwine's temporary files and the COPC itself."""
    return points * ((record or 0) + UNTWINE_TEMP_BYTES_PER_POINT + COPC_BYTES_PER_POINT)


#: A ``.zpc``'s progress: unpacking the tiles up to here, then as any cloud.
ZPC_UNPACK_END = 0.10
#: How many names of a ``.zpc``'s ignored (non-tile) files the log lists.
IGNORED_SHOWN = 5


def check_space(folder: Path, needed: int, what: str = "Importing") -> None:
    """Refuse up front, with both numbers, when the staging drive cannot hold the work; ``what``
    names it (``Importing``, ``Cleaning up``)."""
    from .photo import native

    try:
        native.check_disk(folder, needed)
    except JobError:
        free = shutil.disk_usage(folder).free
        drive = Path(folder).resolve().anchor.rstrip("\\/") or str(folder)
        raise JobError(
            f"{what} this point cloud needs about {needed / 1024**3:.1f} GB free on {drive}, "
            f"which has {free / 1024**3:.1f} GB. Free some space or move the project to a larger drive."
        ) from None


def span(seconds: float) -> str:
    """A coarse duration for status text: ``42 s``, ``6 min`` or ``1 h 05 min``."""
    s = max(0, int(seconds))
    if s < 60:
        return f"{s} s"
    if s < 3600:
        return f"{s // 60} min"
    return f"{s // 3600} h {s % 3600 // 60:02d} min"


def folder_signature(folder: Path) -> tuple[int, int, int]:
    """Files, bytes and the newest change (ns) under ``folder``: any change means a writer is
    at work there. Files that vanish during the walk are skipped."""
    files = size = newest = 0
    todo = [folder]
    while todo:
        try:
            entries = list(os.scandir(todo.pop()))
        except OSError:
            continue
        for e in entries:
            try:
                if e.is_dir(follow_symlinks=False):
                    todo.append(Path(e.path))
                    continue
                st = e.stat(follow_symlinks=False)
            except OSError:
                continue
            files, size, newest = files + 1, size + st.st_size, max(newest, st.st_mtime_ns)
    return files, size, newest


def children_cpu_seconds() -> float | None:
    """CPU time (kernel and user, seconds) of the processes this worker started and that still
    run (Windows), else None. Rising, it shows a converter at work while it writes nothing."""
    if os.name != "nt":
        return None
    try:
        k32 = _kernel32()
        me = os.getpid()
        mine = _process_times(k32, me)
        if mine is None:
            return None
        links = _process_links(k32)
        # A child starts after its parent: a process naming a reused PID as parent is no child.
        family, todo, total = {me: mine[0]}, [me], 0.0
        while todo:
            parent = todo.pop()
            for pid, of in links:
                if of != parent or pid in family:
                    continue
                times = _process_times(k32, pid)
                if times is None or times[0] < family[parent]:
                    continue
                family[pid] = times[0]
                todo.append(pid)
                total += times[1]
        return total
    except Exception:
        return None


def _kernel32() -> Any:
    """kernel32 with the few calls ``children_cpu_seconds`` makes (Windows)."""
    import ctypes
    from ctypes import wintypes

    k32 = ctypes.WinDLL("kernel32")
    k32.OpenProcess.restype = wintypes.HANDLE
    k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    k32.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    k32.CloseHandle.argtypes = [wintypes.HANDLE]
    k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    k32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    for walk in (k32.Process32FirstW, k32.Process32NextW):
        walk.restype = wintypes.BOOL
        walk.argtypes = [wintypes.HANDLE, ctypes.c_void_p]  # a PROCESSENTRY32W, by reference
    return k32


def _process_times(k32: Any, pid: int) -> tuple[int, float] | None:
    """A process's start (100 ns ticks) and its CPU time (seconds), else None."""
    import ctypes
    from ctypes import wintypes

    h = k32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not h:
        return None
    try:
        made, ended, kernel, user = (wintypes.FILETIME() for _ in range(4))
        refs = (ctypes.byref(t) for t in (made, ended, kernel, user))
        if not k32.GetProcessTimes(h, *refs):
            return None
        ticks = [(t.dwHighDateTime << 32) | t.dwLowDateTime for t in (made, kernel, user)]
        return ticks[0], (ticks[1] + ticks[2]) / 1e7
    finally:
        k32.CloseHandle(h)


def _process_links(k32: Any) -> list[tuple[int, int]]:
    """Every process of this computer as (PID, parent PID), from a Toolhelp snapshot."""
    import ctypes
    from ctypes import wintypes

    class Entry(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD),
            ("cntUsage", wintypes.DWORD),
            ("th32ProcessID", wintypes.DWORD),
            ("th32DefaultHeapID", ctypes.c_size_t),
            ("th32ModuleID", wintypes.DWORD),
            ("cntThreads", wintypes.DWORD),
            ("th32ParentProcessID", wintypes.DWORD),
            ("pcPriClassBase", ctypes.c_long),
            ("dwFlags", wintypes.DWORD),
            ("szExeFile", ctypes.c_wchar * 260),
        ]

    snap = k32.CreateToolhelp32Snapshot(0x2, 0)  # TH32CS_SNAPPROCESS
    if not snap or snap == wintypes.HANDLE(-1).value:
        raise OSError("no process snapshot")
    links: list[tuple[int, int]] = []
    try:
        e = Entry()
        e.dwSize = ctypes.sizeof(Entry)
        ok = k32.Process32FirstW(snap, ctypes.byref(e))
        while ok:
            links.append((int(e.th32ProcessID), int(e.th32ParentProcessID)))
            ok = k32.Process32NextW(snap, ctypes.byref(e))
    finally:
        k32.CloseHandle(snap)
    return links


class BuildWatch:
    """The COPC build's honest status, from what really happens rather than a timer.

    Every ``WATCH_EVERY_S`` a thread looks at the staging folder (untwine's temporary files and
    the COPC being written) and the CPU time of the worker's child processes: either changing
    is activity. The text keeps the stage name and adds how long the build has run, and either
    ``still working`` or, after ``STALL_S`` without any activity, how long nothing has moved
    (the job is never stopped for it). The bar moves only by the percentage untwine itself prints
    to its ``tool.out``, never backwards; without one it holds where the build began."""

    def __init__(
        self,
        ctx: StepContext,
        band: tuple[float, float],
        folder: Path,
        tool_out: Path,
        clock: Callable[[], float] = time.monotonic,
        cpu: Callable[[], float | None] = children_cpu_seconds,
    ):
        from .photo.cloud_out import UNTWINE_PROGRESS

        self._ctx, self._band, self._folder, self._tool_out = ctx, band, folder, tool_out
        self._clock, self._cpu, self._percent = clock, cpu, UNTWINE_PROGRESS
        self._t0 = self._active = clock()
        self._last: tuple[Any, ...] | None = None
        self._told = 0.0
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def told(self) -> float | None:
        """The last percentage untwine printed (0 to 1), else None. Read from the end of the
        file only, as the tool appends to it."""
        try:
            with open(self._tool_out, "rb") as f:
                f.seek(max(0, f.seek(0, os.SEEK_END) - 4096))
                tail = f.read().decode("utf-8", errors="replace")
        except OSError:
            return None
        found = self._percent.findall(tail)
        return min(100, int(found[-1])) / 100 if found else None

    def tick(self) -> None:
        """One sample and one progress update."""
        now = self._clock()
        seen = (folder_signature(self._folder), self._cpu())
        if self._last is not None and seen != self._last:
            self._active = now
        self._last = seen
        told = self.told()
        if told is not None:
            self._told = max(self._told, told)
        lo, hi = self._band
        quiet = now - self._active
        state = f"no activity for {span(quiet)}" if quiet >= STALL_S else "still working"
        self._ctx.progress(lo + (hi - lo) * self._told, f"{BUILDING}: {span(now - self._t0)}, {state}")

    def _loop(self) -> None:
        while True:
            with contextlib.suppress(Exception):  # a status line is never worth failing a build
                self.tick()
            if self._stop.wait(WATCH_EVERY_S):
                return

    def __enter__(self) -> BuildWatch:
        self._thread = threading.Thread(target=self._loop, name=WATCH_THREAD, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(WATCH_JOIN_S)
            self._thread = None


class _BuildProgress:
    """The step context ``write_copc`` runs with. Its tool runner moves the bar on a timer until
    untwine prints a percentage (which comes late and in bursts), so its progress is dropped
    here: ``BuildWatch`` reports the build. Everything else (the cancel event) goes through."""

    def __init__(self, ctx: StepContext):
        self._ctx = ctx

    def __getattr__(self, name: str) -> Any:
        return getattr(self._ctx, name)

    def progress(self, fraction: float, message: str | None = None) -> None:
        pass


def build_copc(ctx: StepContext, las: Path, staged: Path, count: int, epsg: int | None, start: float) -> str:
    """``las`` (a LAS/LAZ file or a folder of tiles) as the COPC ``staged``, with the shared
    writer under ``BuildWatch`` from ``start`` to ``BUILD_END``. Answers which writer built it."""
    # the photo pipeline's shared COPC writer (numpy and friends load only when needed)
    from .photo import cloud_out, native

    ctx.check()
    work = ctx.stage("copc-work")
    (work / "tool.out").unlink(missing_ok=True)  # an earlier run's percentage
    try:
        with BuildWatch(ctx, (start, BUILD_END), ctx.staging, work / "tool.out"):
            return cloud_out.write_copc(
                _BuildProgress(ctx),  # type: ignore[arg-type]  # a StepContext in all it uses
                las,
                staged,
                count,
                epsg,
                work,
                native.memory_budget(),
                progress=(start, BUILD_END),
            )
    except JobError as e:
        # the shared writer's refusal of PDAL over the memory budget speaks of photo products;
        # an import says it in its own words
        if "memory budget" in str(e) and "untwine" in str(e):
            raise JobError(TOO_BIG_WITHOUT_UNTWINE) from None
        raise


_VERTICAL_WKT = ("COMPD_CS", "COMPOUNDCRS", "VERT_CS", "VERTCRS")


def has_vertical_crs(srs: dict[str, Any]) -> bool:
    """Whether PDAL's summary of a file names a vertical CRS (a height datum): a vertical part, or
    a compound CRS in WKT or PROJJSON."""
    if str(srs.get("vertical") or "").strip():
        return True
    wkt = str(srs.get("wkt") or "").upper()
    if any(f"{k}[" in wkt for k in _VERTICAL_WKT):
        return True
    crs = srs.get("json")
    return isinstance(crs, dict) and crs.get("type") == "CompoundCRS"


def convert_zpc(ctx: StepContext, pdal: str, src: Path, epsg: int | None) -> dict[str, Any]:
    """A ``.zpc``'s tiles as one COPC in ``staging/cloud.copc.laz``: unpacked, read, reprojected
    tile by tile when they declare another CRS, then built from the folder of tiles. The unpacked
    and reprojected tiles go whatever happens."""
    from . import zpc

    ignored: list[str] = []
    tiles = zpc.list_tiles(src, ignored)
    if ignored:
        shown = ", ".join(n[:120] for n in ignored[:IGNORED_SHOWN])
        more = f" and {len(ignored) - IGNORED_SHOWN} more" if len(ignored) > IGNORED_SHOWN else ""
        ctx.log(f"Ignored {len(ignored)} other file(s) in {src.name}: {shown}{more}")
    check_space(ctx.staging, sum(t.size for t in tiles))
    raw, las_dir = ctx.stage("zpc-tiles"), ctx.stage("zpc-las")
    for d in (raw, las_dir):
        shutil.rmtree(d, ignore_errors=True)
    staged = ctx.stage("cloud.copc.laz")
    try:
        files = zpc.extract_tiles(ctx, src, tiles, raw, (0.0, ZPC_UNPACK_END))
        counts: list[int] = []
        # per tile: None when it declares no CRS, else its EPSG code, else its own WKT or PROJJSON
        # (a custom or local CRS has a CRS all the same, and PDAL reprojects from it)
        crss: set[tuple[str, Any] | None] = set()
        tile_epsg: int | None = None
        vertical = False
        for t, f in zip(tiles, files, strict=True):
            try:
                s = read_summary(ctx, pdal, f)
            except JobError as e:
                raise JobError(f"Tile {t.name} of {src.name} could not be read: {e}") from None
            srs = s.get("srs") or {}
            vertical = vertical or has_vertical_crs(srs)
            if srs.get("wkt") or srs.get("json"):
                tile_epsg = source_epsg(srs)
                own = srs.get("wkt") or json.dumps(srs.get("json"), sort_keys=True)
                crss.add(("epsg", tile_epsg) if tile_epsg else ("crs", own))
            else:
                crss.add(None)
            counts.append(int(s.get("num_points") or 0))
            ctx.log(f"{t.name}: {counts[-1]:,} points")
        if len(crss) > 1 and None in crss:
            raise JobError(
                f"Some tiles of {src.name} declare no CRS and others declare one; export them all in one CRS."
            )
        if len(crss) > 1:
            raise JobError(f"The tiles of {src.name} are in different CRSs; export them in one CRS.")
        count, has_crs = sum(counts), next(iter(crss)) is not None
        reproject = epsg if epsg and has_crs and tile_epsg != epsg else None
        if epsg and not has_crs:
            ctx.log(f"The tiles declare no CRS; they are taken as EPSG:{epsg} already.", "warn")
        ctx.log(f"{src.name}: {len(tiles)} tiles, {count:,} points")
        record = max((las_record_length(f) or DEFAULT_RECORD) for f in files)
        check_space(ctx.staging, disk_needed(count, record if reproject else None))
        folder, start = raw, ZPC_UNPACK_END
        if reproject:
            found = f"EPSG:{tile_epsg}" if tile_epsg else "their own CRS"
            ctx.log(f"Reprojecting the tiles from {found} to EPSG:{epsg}.")
            las_dir.mkdir(parents=True, exist_ok=True)
            step = (PREPARE_END - ZPC_UNPACK_END) / len(files)
            for i, (f, n) in enumerate(zip(files, counts, strict=True)):
                band = (ZPC_UNPACK_END + i * step, ZPC_UNPACK_END + (i + 1) * step)
                prepare_las(ctx, pdal, f, las_dir / f"tile-{i + 1:03d}.las", reproject, n, band)
                f.unlink()  # one copy of each tile on the drive at a time
            folder, start = las_dir, PREPARE_END
        writer = build_copc(ctx, folder, staged, count, epsg, start)
    finally:
        for d in (raw, las_dir):
            shutil.rmtree(d, ignore_errors=True)
    ctx.log(f"Built the viewable cloud with {writer}.")
    return {
        "points": count,
        "bytes": staged.stat().st_size,
        "tiles": len(tiles),
        "source": "zpc",
        "vertical": vertical,
    }


def _layer_id(out_rel: str, taken: set[str]) -> str:
    stem = Path(out_rel).name.split(".")[0]
    base = "cloud-" + (re.sub(r"[^a-z0-9]+", "-", stem.lower()).strip("-") or "points")
    lid, n = base, 2
    while lid in taken:
        lid, n = f"{base}-{n}", n + 1
    return lid


class PointcloudToCopc:
    name = "pointcloud.to_copc"
    title = "Point cloud to COPC"
    description = (
        "Converts LAS, LAZ, E57, PLY or a Bentley .zpc (a ZIP of LAS/LAZ tiles) to a COPC file in "
        "the project CRS and adds it as a layer."
    )

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(params, {"src", "out", "epsg", "origin", "surveyDate"}, self.name)
        src = text(params, "src", required=True)
        assert src is not None
        if Path(src).suffix.lower() not in CLOUD_EXTENSIONS:
            raise JobError("src must be a LAS, LAZ, E57, PLY or ZPC file.")
        day = params.get("surveyDate")
        if day is not None:
            try:
                ok = isinstance(day, str) and bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}", day))
                ok = ok and bool(date.fromisoformat(day))
            except ValueError:
                ok = False
            if not ok:
                raise JobError("surveyDate must be a day as YYYY-MM-DD.")
        stem = re.sub(r"[^a-z0-9]+", "-", Path(src).name.split(".")[0].lower()).strip("-") or "cloud"
        out = {
            "src": src,
            "out": text(params, "out", f"clouds/{stem}.copc.laz"),
            "epsg": number(params, "epsg", None, 1024, 999999, integer=True),
            "origin": numbers(params, "origin", 3),
            "surveyDate": day,
        }
        assert out["out"] is not None
        if not str(out["out"]).lower().endswith(".copc.laz"):
            raise JobError("out must end with .copc.laz.")
        return {k: v for k, v in out.items() if v is not None}

    def inputs(self, params: dict[str, Any]) -> list[str]:
        return [params["src"]]

    def plan(self, params: dict[str, Any]) -> list[Step]:
        def convert(ctx: StepContext) -> dict[str, Any]:
            pdal = find_pdal()
            if not pdal:
                raise JobError(PDAL_MISSING)
            src = ctx.input(params["src"])
            if src.suffix.lower() == ".zpc":
                return convert_zpc(ctx, pdal, src, params.get("epsg"))
            summary = read_summary(ctx, pdal, src)
            srs = summary.get("srs") or {}
            has_crs = bool(srs.get("wkt") or srs.get("json"))
            count = int(summary.get("num_points") or 0)
            ctx.log(f"{src.name}: {count:,} points" + ("" if has_crs else ", no CRS in the file"))
            ctx.progress(READ_END, "Reading the cloud")
            epsg = params.get("epsg")
            reproject = None
            if epsg and has_crs:
                found = source_epsg(srs)
                if found == epsg:
                    ctx.log(f"The file is already in EPSG:{epsg}; no reprojection needed.")
                else:
                    reproject = epsg
                    ctx.log(
                        f"Reprojecting from {f'EPSG:{found}' if found else 'the file CRS'} to EPSG:{epsg}."
                    )
            elif epsg:
                ctx.log(f"The file declares no CRS; it is taken as EPSG:{epsg} already.", "warn")
            las, start = src, READ_END
            prepared: Path | None = None
            staged = ctx.stage("cloud.copc.laz")
            needs_las = bool(reproject) or src.suffix.lower() not in LAS_EXTENSIONS
            record = (las_record_length(src) or DEFAULT_RECORD) if needs_las else None
            check_space(ctx.staging, disk_needed(count, record))
            try:
                if needs_las:
                    prepared = ctx.stage("source.las")
                    prepare_las(ctx, pdal, src, prepared, reproject, count, (READ_END, PREPARE_END))
                    las, start = prepared, PREPARE_END
                writer = build_copc(ctx, las, staged, count, epsg, start)
            finally:
                if prepared is not None:
                    prepared.unlink(missing_ok=True)  # as big as the cloud: never keep it
            ctx.log(f"Built the viewable cloud with {writer}.")
            return {
                "points": count,
                "bytes": staged.stat().st_size,
                "source": "file",
                "vertical": has_vertical_crs(srs),
            }

        def register(ctx: StepContext) -> dict[str, Any]:
            out_rel = str(params["out"]).replace("\\", "/")
            commit_files(ctx, [("cloud.copc.laz", out_rel)])
            mpath = safe_project_path(ctx.project, "manifest.json")
            manifest = json.loads(mpath.read_text("utf-8"))
            layers = manifest.setdefault("layers", [])
            existing = next(
                (
                    layer
                    for layer in layers
                    if layer.get("kind") == "pointcloud" and (layer.get("src") or {}).get("path") == out_rel
                ),
                None,
            )
            done = ctx.outputs("convert")
            points = int(done.get("points") or 0)
            capture: str | None = None
            if existing is None:
                # Decision 7: a Bentley .zpc without a height datum was built from the drone photos'
                # uncorrected altitudes, so it takes the project's photo altitude correction
                # (verticalDatum.absAltOffsetM), as the photos do
                raw_off = (manifest.get("verticalDatum") or {}).get("absAltOffsetM")
                off = (
                    round(float(raw_off), 3)
                    if isinstance(raw_off, int | float) and not isinstance(raw_off, bool) and raw_off
                    else 0.0
                )
                height_offset: float | None = None
                if off and not done.get("vertical"):
                    if done.get("source") == "zpc":
                        height_offset = off
                        ctx.log(
                            "The tiles name no height datum; the cloud was built from the same "
                            "uncorrected photo altitudes, so it is shifted by the project's photo "
                            f"altitude correction, {off:+.2f} m. The points are unchanged; use "
                            "Drop to ground if the cloud is off."
                        )
                    else:
                        ctx.log(
                            "The file names no height datum; its heights are used as they are. "
                            "If the cloud floats or sinks, use Drop to ground."
                        )
                lid = _layer_id(out_rel, {str(layer.get("id")) for layer in layers})
                if params.get("surveyDate"):
                    capture = capture_for_date(manifest, params["surveyDate"])
                layers.append(
                    {
                        "kind": "pointcloud",
                        "id": lid,
                        "name": Path(params["src"]).name,
                        "visible": True,
                        "src": {"path": out_rel},
                        "format": "copc",
                        **({"pointCount": points} if points else {}),
                        **({"capture": capture} if capture else {}),
                        **({"heightOffsetM": height_offset} if height_offset is not None else {}),
                    }
                )
                # keep the previous manifest beside it, as the app's own saves do
                shutil.copyfile(mpath, mpath.with_name("manifest.json.bak"))
                atomic_write_json(mpath, manifest, indent=2)
                ctx.log(f"Added layer {lid} ({out_rel}).")
            else:
                lid = str(existing.get("id"))  # a re-run leaves the layer, and its date, as they are
            return {"layer": lid, "path": out_rel, "capture": capture}

        return [
            Step("convert", "Convert with PDAL", convert, weight=10),
            Step("register", "Add the layer to the project", register, weight=0.5),
        ]
