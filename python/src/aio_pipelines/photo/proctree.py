"""Child processes: their tree, their memory, and ending them (moved from colmap_io, 14 Oct 2026)."""

from __future__ import annotations

import contextlib
import ctypes
import os
import re
import subprocess
import sys
import time
from collections.abc import Callable

from ..runtime import JobError


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


def _kernel32():
    from ctypes import wintypes

    k32 = ctypes.WinDLL("kernel32")
    k32.OpenProcess.restype = wintypes.HANDLE
    k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    k32.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    k32.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    k32.WaitForSingleObject.restype = wintypes.DWORD
    k32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    k32.CloseHandle.argtypes = [wintypes.HANDLE]
    return k32


def _handle_started(k32, h) -> float | None:
    from ctypes import wintypes

    made, ended, kernel, user = (wintypes.FILETIME() for _ in range(4))
    if not k32.GetProcessTimes(
        h, ctypes.byref(made), ctypes.byref(ended), ctypes.byref(kernel), ctypes.byref(user)
    ):
        return None
    # 100 ns ticks since 1601, as the seconds of ``time.time()``
    return ((made.dwHighDateTime << 32) | made.dwLowDateTime) / 1e7 - 11_644_473_600


def process_started(pid: int) -> float | None:
    """When a process started, in the seconds of ``time.time()`` (Windows); None when that
    cannot be read: the process is gone, or it is not ours to open."""
    try:
        k32 = _kernel32()
        h = k32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return None
        try:
            return _handle_started(k32, h)
        finally:
            k32.CloseHandle(h)
    except Exception:
        return None


def process_links() -> list[tuple[int, int]]:
    """Every process of this computer as (PID, parent PID)."""
    links: list[tuple[int, int]] = []
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
            return links
        try:
            pe = PE()
            pe.dwSize = ctypes.sizeof(PE)
            ok = k32.Process32First(snap, ctypes.byref(pe))
            while ok:
                links.append((int(pe.th32ProcessID), int(pe.th32ParentProcessID)))
                ok = k32.Process32Next(snap, ctypes.byref(pe))
        finally:
            k32.CloseHandle(snap)
    else:
        out = subprocess.run(["ps", "-A", "-o", "pid=,ppid="], capture_output=True, text=True, timeout=5)
        for line in out.stdout.splitlines():
            a, b = line.split()
            links.append((int(a), int(b)))
    return links


#: A child starts after its parent. The slack is for a clock that was set back in between.
START_TOLERANCE_S = 1.0


def descendants(
    pid: int, links: list[tuple[int, int]], started: Callable[[int], float | None] | None = None
) -> list[int]:
    """``pid`` and every process below it in ``links`` (PID, parent PID).

    With ``started`` (when a process started, in seconds; None when unknown) a process counts
    as a child only when it started no earlier than its parent, ``START_TOLERANCE_S`` allowed.
    Windows needs that: it never updates a parent PID, so when a parent ends and its PID is given
    to a new process, the old children still name that PID and the new process would adopt them,
    and everything below them. A process whose start is unknown is left out with all below it: it
    has ended, or it is not ours to open, and then its memory cannot be read either."""
    return list(_family(pid, links, started))


def _family(
    pid: int,
    links: list[tuple[int, int]],
    started: Callable[[int], float | None] | None,
    ended: dict[int, tuple[float, float]] | None = None,
) -> dict[int, float | None]:
    """The walk of ``descendants``: each process of the tree with its start, ``pid`` first."""
    ended = ended or {}
    times: dict[int, float | None] = {pid: started(pid) if started else None}
    times.update({p: t for p, (t, _) in ended.items()})
    tree = list(times)
    k = 0
    while k < len(tree):
        parent = tree[k]
        k += 1
        for child, of in links:
            if of != parent or child in times:
                continue
            t = None
            if started:
                t0, t = times[parent], started(child)
                if t0 is None or t is None or t < t0 - START_TOLERANCE_S:
                    continue
                if parent in ended and t > ended[parent][1]:
                    continue  # started after that parent ended: a child of whoever has its PID now
            times[child] = t
            tree.append(child)
    return times


def kill_list(
    pid: int,
    links: list[tuple[int, int]],
    started: Callable[[int], float | None],
    ended: dict[int, tuple[float, float]] | None = None,
) -> list[tuple[int, float]]:
    """The processes below ``pid`` to end, parents first, each with the start it had in this walk
    (``end_process`` checks it again). Only what ``descendants`` counts is in it.

    ``ended`` names the processes of the tree that were ended already, as PID: (start, end).
    A child one of them started in between still names its PID, and started before that end."""
    ended = ended or {}
    family = _family(pid, links, started, ended)
    return [(p, t) for p, t in family.items() if p != pid and p not in ended and t is not None]


def end_process(pid: int, started_at: float) -> str:
    """End the process that has ``pid`` and started at ``started_at`` (Windows).

    A PID is given out again once its process has ended, so the start is read from the very
    handle the process is ended through. Returns "ended"; "gone" when there is no such process any
    more (a process that has the PID now is left alone); "refused" when it could not be ended."""

    def same(t: float | None) -> bool:
        return t is not None and abs(t - started_at) < 1e-3

    try:
        k32 = _kernel32()
        h = k32.OpenProcess(0x101001, False, pid)  # SYNCHRONIZE, QUERY_LIMITED_INFORMATION, TERMINATE
        if not h:
            return "refused" if same(process_started(pid)) else "gone"
        try:
            if not same(_handle_started(k32, h)):
                return "gone"
            k32.TerminateProcess(h, 1)
            return "ended" if k32.WaitForSingleObject(h, 5000) == 0 else "refused"
        finally:
            k32.CloseHandle(h)
    except Exception:
        return "refused"


def end_tree(proc: subprocess.Popen, passes: int = 3) -> None:
    """End a child and every process below it, and nothing else (Windows).

    ``taskkill /T`` is not used: it builds its own tree from parent PIDs, and a parent PID alone
    does not make a child (``descendants``). The processes below are listed first, then the child
    is ended through its own handle (so it starts nothing more), then the listed ones, each only
    if it still is the process that was listed. A few more walks catch what was started in
    between."""
    pid = proc.pid
    root_started = process_started(pid)
    try:
        todo = kill_list(pid, process_links(), process_started)
    except Exception:
        todo = []
    with contextlib.suppress(OSError):
        proc.kill()
    with contextlib.suppress(subprocess.TimeoutExpired):
        proc.wait(timeout=5)
    ended = {} if root_started is None else {pid: (root_started, time.time())}
    for _ in range(passes):
        for p, t in todo:
            if end_process(p, t) != "refused":
                ended[p] = (t, time.time())
        try:
            todo = kill_list(pid, process_links(), process_started, ended)
        except Exception:
            return
        if not todo:
            return


def process_tree(pid: int) -> list[int]:
    """A process and all its descendants (a Windows venv ``python.exe`` is a launcher whose child
    does the work). On Windows a parent PID alone does not make a child (``descendants``); other
    systems re-parent the children of a process that ends, so their links are always live."""
    try:
        links = process_links()
    except Exception:
        return [pid]
    return descendants(pid, links, process_started if os.name == "nt" else None)


def tree_memory(pid: int) -> int:
    return sum(process_memory(p) for p in process_tree(pid))


class MemoryExceeded(JobError):
    """An engine stage passed the memory limit and was stopped."""


def kill(proc: subprocess.Popen) -> None:
    """Stop a worker now (the whole tree on Windows, ``end_tree``), and reap it."""
    try:
        if os.name == "nt":
            end_tree(proc)
        proc.kill()
    except OSError:
        pass
    with contextlib.suppress(subprocess.TimeoutExpired):
        proc.wait(timeout=10)


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
