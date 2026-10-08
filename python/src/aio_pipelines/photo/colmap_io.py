"""The alignment engine adapter, and its COLMAP implementation (pycolmap in a child process).

``photo.align`` talks to an ``SfmEngine``: ``features``, ``match`` (on the pairs the pipeline
chose) and ``map`` (global or incremental structure from motion), each returning plain results
and writing models as ``model.npz`` files (``photo/model.py``). The pipeline never imports
pycolmap; tests use an engine over a known scene, and an OpenSfM engine could take COLMAP's place
without changing the stages.

``ColmapEngine`` runs each stage in a child Python (``python -m aio_pipelines.photo.colmap_io
<request.json>``) so that:

- **cancel** kills it within a fraction of a second (the global mapper has no cancellation hook);
- a native crash or a memory spike cannot take the pipeline process down;
- the stage's **peak memory** is measured and recorded in ``run.json``;
- the interpreter can differ: ``AIO_COLMAP_PYTHON`` names a development Python with a pycolmap
  build (the pack's own build is in the pack's Python, the default).

**Licence guard.** The PyPI pycolmap wheels bundle GPL libraries (``cholmod``, ``spqr``) and must
never run inside Stratlas. The worker refuses a pycolmap whose bundled libraries include them,
unless ``AIO_DEV_ALLOW_GPL_PYCOLMAP=1`` is set for a local experiment outside the product.

Resume: the COLMAP database lives in the job's staging ``work/``; feature extraction skips photos
that already have keypoints and matching skips pairs that are already matched, so a resumed stage
continues where it stopped.

**Photo names with spaces.** COLMAP's pair list (``ImportedPairingOptions.match_list_path``) is
one ``name1 name2`` per line, split at the first space, so a photo below a folder such as
``Mapping Photos/`` could never be paired. The pair list therefore names photos by
``engine_alias`` (space as ``%20``, percent as ``%25``), and the match stage renames the images in
the database to those aliases for its own duration (``names.alias.json`` remembers the real names,
so a stage stopped half way is put right by the next one). Features and mapping use the real
names, which is what COLMAP reads the photos by. On Windows the worker sets the C runtime's locale
to UTF-8 before COLMAP loads (``utf8_paths``), so photos below folders such as ``Média`` open too.

**Memory.** The guard stops a stage above ``memory_limit``: ``AIO_PHOTO_MEMORY_MB`` when the app
sets it (one cap for every photo job, ``native.memory_cap``), else 75 % of the physical memory and
no more than 90 % of what is free when the stage starts.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import subprocess
import sys
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Protocol

from ..runtime import Cancelled, JobError

PYTHON_ENV = "AIO_COLMAP_PYTHON"
ALLOW_GPL_ENV = "AIO_DEV_ALLOW_GPL_PYCOLMAP"
#: Native libraries that must never be inside the pycolmap Stratlas runs.
FORBIDDEN_LIBS = re.compile(r"(cholmod|spqr|cxsparse|csparse|siftgpu|lsd|cgal)", re.I)

Progress = Callable[[float, str | None], None]


@dataclass
class EngineGroup:
    """One calibration group (camera body and lens at one size) with its starting calibration."""

    id: int
    model: str
    width: int
    height: int
    params: list[float]


@dataclass
class EngineImage:
    key: str  # the run's photo key (folder and path)
    name: str  # path relative to ``image_root`` (what the engine reads)
    group: int


@dataclass
class EngineJob:
    work: Path
    image_root: Path
    images: list[EngineImage]
    groups: list[EngineGroup]
    max_image_size: int = 1600
    max_features: int = 8192
    #: SIFT's first octave: -1 doubles the image first (fine detail on small images, four times
    #: the memory); 0 for images of 1600 px and more.
    first_octave: int = 0
    threads: int = -1
    #: Stop the stage when the engine's memory passes this (0: no limit).
    memory_limit_bytes: int = 0
    seed: int = 0
    check: Callable[[], None] = field(default=lambda: None)
    log: Callable[[str], None] = field(default=lambda m: None)
    memory_peak: dict[str, int] = field(default_factory=dict)

    @property
    def database(self) -> Path:
        return self.work / "database.db"


class SfmEngine(Protocol):
    name: str

    def versions(self) -> dict[str, str]: ...

    def features(self, job: EngineJob, progress: Progress) -> dict[str, Any]: ...

    def match(self, job: EngineJob, pairs: list[tuple[str, str]], progress: Progress) -> dict[str, Any]: ...

    def map(self, job: EngineJob, mapper: str, progress: Progress) -> dict[str, Any]: ...


# ------------------------------------------------------------------------------- memory


def memory_status() -> tuple[int, int]:
    """Total and available physical memory of this computer, bytes (0, 0 when unknown)."""
    try:
        if os.name == "nt":
            import ctypes

            class MS(ctypes.Structure):
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

            ms = MS()
            ms.dwLength = ctypes.sizeof(MS)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(ms))
            return int(ms.ullTotalPhys), int(ms.ullAvailPhys)
        total = int(os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES"))
        if sys.platform == "darwin":
            out = subprocess.run(["vm_stat"], capture_output=True, text=True, timeout=5).stdout
            page = int(re.search(r"page size of (\d+)", out).group(1)) if "page size" in out else 4096
            pages = sum(
                int(m.group(1)) for m in re.finditer(r"Pages (?:free|inactive|speculative):\s+(\d+)", out)
            )
            return total, pages * page
        return total, int(os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_AVPHYS_PAGES"))
    except Exception:
        return 0, 0


def memory_limit(total: int, available: int, cap: int | None = None) -> int:
    """The most an engine stage may use: ``cap`` (``AIO_PHOTO_MEMORY_MB``, the app's setting)
    when given, else 75 % of the memory at most and no more than 90 % of what is free when the
    stage starts (other programs keep theirs)."""
    if cap:
        return int(cap)
    if total <= 0:
        return 0
    lim = int(0.75 * total)
    if available > 0:
        lim = min(lim, int(0.9 * available))
    return max(lim, 512 * 2**20)


def process_memory(pid: int) -> int:
    """Resident memory of a process, bytes (0 when unknown)."""
    try:
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes

            class PMC(ctypes.Structure):
                _fields_ = [
                    ("cb", wintypes.DWORD),
                    ("PageFaultCount", wintypes.DWORD),
                    ("PeakWorkingSetSize", ctypes.c_size_t),
                    ("WorkingSetSize", ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                    ("PagefileUsage", ctypes.c_size_t),
                    ("PeakPagefileUsage", ctypes.c_size_t),
                ]

            k32 = ctypes.WinDLL("kernel32")
            psapi = ctypes.WinDLL("psapi")
            k32.OpenProcess.restype = wintypes.HANDLE
            psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(PMC), wintypes.DWORD]
            h = k32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
            if not h:
                return 0
            try:
                pmc = PMC()
                pmc.cb = ctypes.sizeof(PMC)
                if psapi.GetProcessMemoryInfo(h, ctypes.byref(pmc), pmc.cb):
                    return int(pmc.WorkingSetSize)
                return 0
            finally:
                k32.CloseHandle(h)
        out = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)], capture_output=True, text=True, timeout=5)
        return int(out.stdout.strip() or 0) * 1024
    except Exception:
        return 0


def process_tree(pid: int) -> list[int]:
    """A process and all its descendants (a Windows venv ``python.exe`` is a launcher whose child
    does the work)."""
    pairs: list[tuple[int, int]] = []
    try:
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes

            class PE(ctypes.Structure):
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
                    ("szExeFile", ctypes.c_char * 260),
                ]

            k32 = ctypes.WinDLL("kernel32")
            k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
            snap = k32.CreateToolhelp32Snapshot(0x2, 0)  # TH32CS_SNAPPROCESS
            if snap in (None, wintypes.HANDLE(-1).value):
                return [pid]
            try:
                pe = PE()
                pe.dwSize = ctypes.sizeof(PE)
                ok = k32.Process32First(snap, ctypes.byref(pe))
                while ok:
                    pairs.append((int(pe.th32ProcessID), int(pe.th32ParentProcessID)))
                    ok = k32.Process32Next(snap, ctypes.byref(pe))
            finally:
                k32.CloseHandle(snap)
        else:
            out = subprocess.run(["ps", "-A", "-o", "pid=,ppid="], capture_output=True, text=True, timeout=5)
            for line in out.stdout.splitlines():
                a, b = line.split()
                pairs.append((int(a), int(b)))
    except Exception:
        return [pid]
    tree = [pid]
    k = 0
    while k < len(tree):
        tree += [c for c, parent in pairs if parent == tree[k] and c not in tree]
        k += 1
    return tree


def tree_memory(pid: int) -> int:
    return sum(process_memory(p) for p in process_tree(pid))


class MemoryExceeded(JobError):
    """An engine stage passed the memory limit and was stopped."""


# ------------------------------------------------------------------------------- names


def engine_alias(name: str) -> str:
    """A photo name as COLMAP's pair list can hold it (that list splits each line at a space):
    the percent sign and every white space or control character percent-encoded (UTF-8), so a
    space is ``%20`` and a percent sign ``%25``. Unique, and ``urllib.parse.unquote`` reverses it."""
    from urllib.parse import quote

    return "".join(quote(ch, safe="") if ch == "%" or ch.isspace() or ord(ch) < 32 else ch for ch in name)


def alias_names(db, work: Path) -> int:
    """Rename the database's images to their ``engine_alias`` for matching; the real names are
    kept in ``work/names.alias.json`` until ``restore_names``. Returns how many were renamed."""
    restore_names(db, work)
    images = list(db.read_all_images())
    real = {int(im.image_id): im.name for im in images if engine_alias(im.name) != im.name}
    if not real:
        return 0
    rec = work / "names.alias.json"
    tmp = rec.with_name(rec.name + ".tmp")
    tmp.write_text(json.dumps({str(k): v for k, v in real.items()}), "utf-8")
    tmp.replace(rec)
    for im in images:
        if int(im.image_id) in real:
            im.name = engine_alias(im.name)
            db.update_image(im)
    return len(real)


def restore_names(db, work: Path) -> int:
    """Put back the real image names an aliased (perhaps stopped) match stage left in the database."""
    rec = work / "names.alias.json"
    if not rec.is_file():
        return 0
    real = {int(k): v for k, v in json.loads(rec.read_text("utf-8")).items()}
    n = 0
    for im in db.read_all_images():
        name = real.get(int(im.image_id))
        if name is not None and im.name != name:
            im.name = name
            db.update_image(im)
            n += 1
    rec.unlink()
    return n


# ------------------------------------------------------------------------------- parent side


def _src_root() -> Path:
    return Path(__file__).resolve().parents[2]


class ColmapEngine:
    name = "colmap"

    def __init__(self, python: str | None = None):
        self.python = python or os.environ.get(PYTHON_ENV) or sys.executable
        self._versions: dict[str, str] | None = None

    def _run(
        self, job: EngineJob, op: str, payload: dict[str, Any], progress: Progress, stage: str
    ) -> dict[str, Any]:
        job.work.mkdir(parents=True, exist_ok=True)
        req = job.work / f"{stage}.request.json"
        prog = job.work / f"{stage}.progress.jsonl"
        out = job.work / f"{stage}.out.log"
        req.write_text(json.dumps({"op": op, **payload}), "utf-8")
        prog.write_text("", "utf-8")
        env = dict(os.environ)
        env["PYTHONPATH"] = str(_src_root()) + (
            os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else ""
        )
        env["AIO_COLMAP_PROGRESS"] = str(prog)
        env.setdefault("GLOG_minloglevel", "1")
        with open(out, "wb") as log_f:
            proc = subprocess.Popen(
                [self.python, "-m", "aio_pipelines.photo.colmap_io", str(req)],
                stdin=subprocess.DEVNULL,
                stdout=log_f,
                stderr=subprocess.STDOUT,
                env=env,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            pos = 0
            result: dict[str, Any] | None = None
            error: str | None = None
            seen_peak = 0
            last_mem = 0.0
            try:
                while True:
                    done = proc.poll() is not None
                    try:
                        job.check()
                    except Cancelled:
                        kill(proc)
                        raise
                    if job.memory_limit_bytes and not done and time.monotonic() - last_mem >= 0.5:
                        last_mem = time.monotonic()
                        used = tree_memory(proc.pid)
                        seen_peak = max(seen_peak, used)
                        if used > job.memory_limit_bytes:
                            kill(proc)
                            job.memory_peak[stage] = used
                            raise MemoryExceeded(
                                f"Alignment stopped during {stage}: COLMAP needed more than "
                                f"{job.memory_limit_bytes / 1e9:.1f} GB of memory, the limit for this computer "
                                "now. Choose a lower preset, process fewer photos at a time, or close other programs."
                            )
                    with open(prog, encoding="utf-8") as f:
                        f.seek(pos)
                        chunk = f.read()
                    lines = chunk.split("\n")
                    pos += len(chunk.encode("utf-8")) - len(lines[-1].encode("utf-8"))
                    for line in lines[:-1]:
                        try:
                            msg = json.loads(line)
                        except ValueError:
                            continue
                        if "progress" in msg:
                            progress(float(msg["progress"]), msg.get("message"))
                        if "log" in msg:
                            job.log(str(msg["log"]))
                        if "result" in msg:
                            result = msg["result"]
                        if "error" in msg:
                            error = str(msg["error"])
                        if "memoryPeakBytes" in msg:
                            job.memory_peak[stage] = max(int(msg["memoryPeakBytes"]), seen_peak)
                    if done:
                        break
                    time.sleep(0.1)
            finally:
                if proc.poll() is None:
                    kill(proc)
        if error:
            raise JobError(error)
        if proc.returncode != 0 or result is None:
            tail = out.read_text("utf-8", errors="replace").strip().splitlines()[-3:]
            raise JobError(
                f"COLMAP stopped during {stage} (exit {proc.returncode}). " + " ".join(tail)[-400:]
            )
        return result

    def _base(self, job: EngineJob) -> dict[str, Any]:
        return {
            "database": str(job.database),
            "imageRoot": str(job.image_root),
            "maxImageSize": job.max_image_size,
            "maxFeatures": job.max_features,
            "firstOctave": job.first_octave,
            "threads": job.threads,
            "seed": job.seed,
        }

    def versions(self) -> dict[str, str]:
        if self._versions is None:
            env = dict(os.environ)
            env["PYTHONPATH"] = str(_src_root()) + (
                os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else ""
            )
            try:
                p = subprocess.run(
                    [self.python, "-m", "aio_pipelines.photo.colmap_io", "--versions"],
                    capture_output=True,
                    text=True,
                    timeout=120,
                    env=env,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
            except (OSError, subprocess.TimeoutExpired) as e:
                raise JobError(f"The photo alignment engine could not start: {e}") from e
            try:
                data = json.loads(p.stdout.strip().splitlines()[-1])
            except (ValueError, IndexError):
                data = {"error": (p.stderr or p.stdout or "no output").strip()[-300:]}
            if "error" in data:
                raise JobError(data["error"])
            self._versions = data
        return self._versions

    def features(self, job: EngineJob, progress: Progress) -> dict[str, Any]:
        payload = {
            **self._base(job),
            "groups": [asdict(g) for g in job.groups],
            "images": [{"name": i.name, "group": i.group} for i in job.images],
        }
        return self._run(job, "features", payload, progress, "features")

    def match(self, job: EngineJob, pairs: list[tuple[str, str]], progress: Progress) -> dict[str, Any]:
        pairs_file = job.work / "pairs.txt"
        pairs_file.write_text("".join(f"{engine_alias(a)} {engine_alias(b)}\n" for a, b in pairs), "utf-8")
        return self._run(job, "match", {**self._base(job), "pairs": str(pairs_file)}, progress, "match")

    def map(self, job: EngineJob, mapper: str, progress: Progress) -> dict[str, Any]:
        out = job.work / f"sfm-{mapper}"
        return self._run(
            job, "map", {**self._base(job), "mapper": mapper, "out": str(out)}, progress, f"map-{mapper}"
        )


def kill(proc: subprocess.Popen) -> None:
    """Stop a worker now (the whole tree on Windows), and reap it."""
    try:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/T", "/F", "/PID", str(proc.pid)],
                capture_output=True,
                timeout=10,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        proc.kill()
    except (OSError, subprocess.TimeoutExpired):
        pass
    with contextlib.suppress(subprocess.TimeoutExpired):
        proc.wait(timeout=10)


def load_engine() -> SfmEngine:
    """The engine of this pack: COLMAP, when its build is installed and licence-clean."""
    eng = ColmapEngine()
    eng.versions()
    return eng


# ------------------------------------------------------------------------------- worker side


def peak_memory_bytes() -> int:
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        class PMC(ctypes.Structure):
            _fields_ = [
                ("cb", wintypes.DWORD),
                ("PageFaultCount", wintypes.DWORD),
                ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t),
                ("PeakPagefileUsage", ctypes.c_size_t),
            ]

        pmc = PMC()
        pmc.cb = ctypes.sizeof(PMC)
        k32 = ctypes.WinDLL("kernel32")
        psapi = ctypes.WinDLL("psapi")
        k32.GetCurrentProcess.restype = wintypes.HANDLE
        psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(PMC), wintypes.DWORD]
        if psapi.GetProcessMemoryInfo(k32.GetCurrentProcess(), ctypes.byref(pmc), pmc.cb):
            return int(pmc.PeakWorkingSetSize)
        return 0
    import resource

    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(rss if sys.platform == "darwin" else rss * 1024)


def licence_problem(pycolmap_module) -> str | None:
    """Why this pycolmap build must not run in Stratlas (its bundled native libraries), or None."""
    base = Path(pycolmap_module.__file__).resolve().parent
    found: list[str] = []
    for d in (base, base.parent / "pycolmap.libs", base / ".dylibs", base.parent / "pycolmap" / ".dylibs"):
        if d.is_dir():
            found += [p.name for p in d.iterdir() if p.is_file() and FORBIDDEN_LIBS.search(p.name)]
    if not found:
        return None
    return (
        "This pycolmap build bundles libraries Stratlas may not ship ("
        + ", ".join(sorted(set(found))[:6])
        + "). Install the pipeline pack's own COLMAP build."
    )


class _Out:
    def __init__(self):
        self.path = os.environ.get("AIO_COLMAP_PROGRESS")

    def send(self, **msg) -> None:
        line = json.dumps(msg)
        if self.path:
            with open(self.path, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        else:
            print(line, flush=True)


def utf8_paths() -> bool:
    """Make COLMAP open photos whose paths have letters outside the ANSI code page (Windows).

    COLMAP reads images through the C runtime's narrow file functions, which take a path in the
    ANSI code page: a photo below ``Média`` fails with "BITMAP_ERROR: Failed to read the image
    file format". With the C runtime's character type set to UTF-8 (the pack builds COLMAP
    against the shared UCRT, ``VCPKG_CRT_LINKAGE dynamic``; Windows 10 1803 and later) those
    functions take UTF-8, which is what COLMAP passes. Only ``LC_CTYPE``: numbers keep the "C"
    format. Other systems take UTF-8 already."""
    if os.name != "nt":
        return False
    try:
        import ctypes

        ucrt = ctypes.CDLL("ucrtbase")
        ucrt.setlocale.restype = ctypes.c_char_p
        ucrt.setlocale.argtypes = [ctypes.c_int, ctypes.c_char_p]
        return bool(ucrt.setlocale(2, b".UTF-8"))  # LC_CTYPE
    except (OSError, AttributeError):
        return False


def _import_pycolmap(out: _Out):
    utf8_paths()
    try:
        import pycolmap
    except Exception as e:
        raise JobError(
            "Photo alignment needs the pipeline pack's COLMAP build, which is not installed "
            f"({type(e).__name__})."
        ) from None
    problem = licence_problem(pycolmap)
    if problem and os.environ.get(ALLOW_GPL_ENV) != "1":
        raise JobError(problem)
    if problem:
        out.send(log="Development run with a pycolmap that bundles GPL libraries: never ship this.")
    return pycolmap


def _versions() -> dict[str, Any]:
    out = _Out()
    try:
        pc = _import_pycolmap(out)
    except JobError as e:
        return {"error": str(e)}
    info = {
        "pycolmap": str(getattr(pc, "__version__", "?")),
        "colmap": str(getattr(pc, "COLMAP_version", "?")),
    }
    info["cuda"] = str(bool(getattr(pc, "has_cuda", False))).lower()
    if licence_problem(pc):
        info["licence"] = "dev-only (bundles GPL libraries)"
    return info


def _op_features(pc, req: dict[str, Any], out: _Out) -> dict[str, Any]:
    db_path = req["database"]
    root = req["imageRoot"]
    groups = {g["id"]: g for g in req["groups"]}
    images = req["images"]
    with pc.Database.open(db_path) as db:
        restore_names(db, Path(db_path).parent)
        existing = {im.name: im for im in db.read_all_images()}
        cams = {c.camera_id: c for c in db.read_all_cameras()}
        cam_of_group: dict[int, int] = {}
        for gid, g in groups.items():
            # one camera per group, created once (a resume finds it by its stored id)
            want = next(
                (
                    cid
                    for cid, c in cams.items()
                    if c.width == g["width"] and c.height == g["height"] and cid == gid
                ),
                None,
            )
            if want is None:
                cam = pc.Camera.create_from_model_name(
                    gid, g["model"], float(g["params"][0]), g["width"], g["height"]
                )
                cam.params = g["params"]
                cam.has_prior_focal_length = True
                want = db.write_camera(cam, use_camera_id=True)
            cam_of_group[gid] = int(want)
        todo = []
        for im in images:
            e = existing.get(im["name"])
            if e is not None and db.exists_keypoints(e.image_id):
                continue
            todo.append(im)
    opts = pc.FeatureExtractionOptions()
    opts.max_image_size = int(req["maxImageSize"])
    opts.num_threads = int(req["threads"])
    opts.use_gpu = False
    opts.sift.max_num_features = int(req["maxFeatures"])
    opts.sift.first_octave = int(req.get("firstOctave", 0))
    total = len(images)
    done = total - len(todo)
    out.send(progress=done / max(total, 1), message=f"{done} of {total} photos")
    by_group: dict[int, list[str]] = {}
    for im in todo:
        by_group.setdefault(im["group"], []).append(im["name"])
    # batches big enough to keep every core busy (COLMAP extracts the photos of a call in
    # parallel), small enough for progress and resume: about 20 calls per run
    batch = max(2 * (os.cpu_count() or 8), total // 20)
    for gid, names in by_group.items():
        ro = pc.ImageReaderOptions()
        ro.existing_camera_id = cam_of_group[gid]
        for k in range(0, len(names), batch):
            part = names[k : k + batch]
            pc.extract_features(
                db_path,
                root,
                image_names=part,
                camera_mode=pc.CameraMode.SINGLE,
                reader_options=ro,
                extraction_options=opts,
                device=pc.Device.cpu,
            )
            done += len(part)
            out.send(progress=done / max(total, 1), message=f"{done} of {total} photos")
    with pc.Database.open(db_path) as db:
        n = db.num_images()
        kp = db.num_keypoints()
    return {"images": n, "keypoints": int(kp)}


def _op_match(pc, req: dict[str, Any], out: _Out) -> dict[str, Any]:
    db_path = req["database"]
    lines = [ln for ln in Path(req["pairs"]).read_text("utf-8").splitlines() if ln.strip()]
    mo = pc.FeatureMatchingOptions()
    mo.num_threads = int(req["threads"])
    mo.use_gpu = False
    vo = pc.TwoViewGeometryOptions()
    chunk = max(200, len(lines) // 50)
    work = Path(req["pairs"]).parent
    db_work = Path(db_path).parent
    with pc.Database.open(db_path) as db:
        renamed = alias_names(db, db_work)  # the pair list names photos by their aliases
    if renamed:
        out.send(log=f"{renamed} photo names have spaces; matched under escaped names.")
    try:
        for k in range(0, len(lines), chunk):
            part = work / "pairs.part.txt"
            part.write_text("\n".join(lines[k : k + chunk]) + "\n", "utf-8")
            po = pc.ImportedPairingOptions()
            po.match_list_path = str(part)
            pc.match_image_pairs(
                db_path,
                matching_options=mo,
                pairing_options=po,
                verification_options=vo,
                device=pc.Device.cpu,
            )
            out.send(
                progress=min(1.0, (k + chunk) / max(len(lines), 1)),
                message=f"{min(k + chunk, len(lines))} of {len(lines)} pairs",
            )
    finally:
        with pc.Database.open(db_path) as db:
            restore_names(db, db_work)
    with pc.Database.open(db_path) as db:
        matched = db.num_matched_image_pairs()
        verified = db.num_verified_image_pairs()
    return {"pairs": len(lines), "matched": int(matched), "verified": int(verified)}


def _export(pc, rec, path: Path) -> dict[str, Any]:
    """A pycolmap reconstruction as ``model.npz`` (``photo/model.py``)."""
    import numpy as np

    cams = sorted(rec.cameras.items())
    cam_params = []
    for _, c in cams:
        p = np.asarray(c.params, dtype=np.float64)
        cam_params.append(np.pad(p, (0, 12 - len(p))))
    reg = sorted(rec.reg_image_ids())
    names, cids, Rs, ts, counts, xys, p3d = [], [], [], [], [], [], []
    for iid in reg:
        im = rec.images[iid]
        cfw = im.cam_from_world() if callable(im.cam_from_world) else im.cam_from_world
        m = np.asarray(cfw.matrix())
        obs = im.get_observation_points2D()
        names.append(im.name)
        cids.append(im.camera_id)
        Rs.append(m[:, :3])
        ts.append(m[:, 3])
        counts.append(len(obs))
        xys.append(np.array([p.xy for p in obs], dtype=np.float64).reshape(-1, 2))
        p3d.append(np.array([p.point3D_id for p in obs], dtype=np.int64))
    pids = sorted(rec.point3D_ids())
    pts = [rec.points3D[i] for i in pids]
    np.savez(
        path,
        cam_ids=np.array([c for c, _ in cams], np.int64),
        cam_models=np.array([c.model.name for _, c in cams]),
        cam_sizes=np.array([[c.width, c.height] for _, c in cams], np.int64).reshape(-1, 2),
        cam_params=np.array(cam_params).reshape(-1, 12),
        img_ids=np.array(reg, np.int64),
        img_names=np.array(names),
        img_cams=np.array(cids, np.int64),
        img_R=np.array(Rs).reshape(-1, 3, 3),
        img_t=np.array(ts).reshape(-1, 3),
        img_counts=np.array(counts, np.int64),
        xys=np.concatenate(xys) if xys else np.zeros((0, 2)),
        p3d=np.concatenate(p3d) if p3d else np.zeros(0, np.int64),
        point_ids=np.array(pids, np.int64),
        xyz=np.array([p.xyz for p in pts], dtype=np.float64).reshape(-1, 3),
        rgb=np.array([p.color for p in pts], dtype=np.uint8).reshape(-1, 3),
        error=np.array([p.error for p in pts], dtype=np.float64),
    )
    return {"path": str(path), "images": len(reg), "points": len(pids)}


def _op_map(pc, req: dict[str, Any], out: _Out) -> dict[str, Any]:
    db_path = req["database"]
    root = req["imageRoot"]
    dest = Path(req["out"])
    dest.mkdir(parents=True, exist_ok=True)
    mapper = req["mapper"]
    with pc.Database.open(db_path) as db:
        restore_names(db, Path(db_path).parent)  # the real names: COLMAP reads the photos by them
    t0 = time.monotonic()
    out.send(progress=0.02, message=f"{mapper} structure from motion")
    if mapper == "global":
        opts = pc.GlobalPipelineOptions()
        opts.num_threads = int(req["threads"])
        opts.random_seed = int(req["seed"])
        opts.mapper.global_positioning.use_gpu = False
        opts.mapper.bundle_adjustment.ceres.use_gpu = False
        recs = pc.global_mapping(db_path, root, str(dest), opts)
    else:
        opts = pc.IncrementalPipelineOptions()
        opts.num_threads = int(req["threads"])
        opts.random_seed = int(req["seed"])
        count = {"n": 0}

        def next_image():
            count["n"] += 1
            if count["n"] % 10 == 0:
                out.send(progress=0.05, message=f"{count['n']} photos placed")

        recs = pc.incremental_mapping(db_path, root, str(dest), opts, next_image_callback=next_image)
    models = []
    for k, rec in sorted(recs.items(), key=lambda kv: -kv[1].num_reg_images()):
        models.append(_export(pc, rec, dest / f"model-{k}.npz"))
    out.send(progress=1.0, message=f"{len(models)} models in {time.monotonic() - t0:.0f} s")
    return {"models": models, "mapper": mapper, "seconds": round(time.monotonic() - t0, 1)}


def worker_main(argv: list[str]) -> int:
    if argv and argv[0] == "--versions":
        print(json.dumps(_versions()), flush=True)
        return 0
    out = _Out()
    try:
        req = json.loads(Path(argv[0]).read_text("utf-8"))
        if req.get("op") == "probe-alloc":  # memory guard probe: grow in steps, then wait
            hold = []
            for _ in range(int(req.get("steps", 20))):
                hold.append(bytearray(int(req.get("stepBytes", 100 * 2**20))))
                out.send(progress=0.5, message=f"{len(hold)} steps")
                time.sleep(0.3)
            time.sleep(float(req.get("seconds", 30)))
            out.send(result={"held": len(hold)})
            return 0
        if req.get("op") == "probe-sleep":  # liveness probe: progress, then a long wait (cancel tests)
            for k in range(int(req.get("seconds", 60)) * 10):
                if k % 5 == 0:
                    out.send(progress=min(0.99, k / 600), message="waiting")
                time.sleep(0.1)
            out.send(result={"slept": True})
            return 0
        pc = _import_pycolmap(out)
        if hasattr(pc, "set_random_seed"):
            pc.set_random_seed(int(req.get("seed", 0)))
        op = {"features": _op_features, "match": _op_match, "map": _op_map}[req["op"]]
        result = op(pc, req, out)
        out.send(memoryPeakBytes=peak_memory_bytes())
        out.send(result=result)
        return 0
    except JobError as e:
        out.send(error=str(e))
        return 1
    except Exception as e:  # a COLMAP failure: shown to the person with its type
        out.send(error=f"COLMAP failed: {type(e).__name__}: {str(e)[:300]}")
        return 1


if __name__ == "__main__":
    sys.exit(worker_main(sys.argv[1:]))
