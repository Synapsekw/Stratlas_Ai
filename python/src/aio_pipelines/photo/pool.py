"""Worker processes for the per-photo stages of ``photo.products`` (depth maps, fusion).

One photo's depth map or fusion does not depend on another's, so the stages run several photos at
once when the computer has the cores and the memory for it. ``plan_workers`` decides how many;
with one, nothing is started and the stage runs in the job's own process. The per-photo work
(``depth_photo``, ``fuse_photo``) is the same function in both cases, so the files are the same.

Workers are started fresh (``spawn``), load the run themselves and write their own output files
under the fixed names a resumed job overwrites. A cancel stops them; a worker that dies (out of
memory) breaks the pool, and the stage finishes the rest in its own process.
"""

from __future__ import annotations

import multiprocessing
import os
from collections.abc import Callable
from concurrent.futures import FIRST_COMPLETED, Future, ProcessPoolExecutor, wait
from concurrent.futures.process import BrokenProcessPool
from typing import Any

WORKERS_ENV = "AIO_PHOTO_WORKERS"
MAX_WORKERS = 8
#: Below this many pixels at the matching size a photo takes well under a second: starting
#: processes would cost more than it saves.
MIN_PIXELS = 2_000_000
#: Peak memory of one worker per pixel of the matching size, measured on 5.2 and 20.9 MP photos
#: (plan "GPU acceleration", spike results): 295 for a depth map, 234 for fusing a photo.
DENSE_BYTES_PER_PIXEL = 300
FUSE_BYTES_PER_PIXEL = 250
_THREAD_ENV = ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS")


class PoolBroken(Exception):
    """A worker process stopped without an answer (killed, or out of memory)."""


def forced_workers() -> int | None:
    """The worker count from ``AIO_PHOTO_WORKERS`` (tests, support), or None when it is not set.
    Anything that is not a whole number of 1 or more counts as 1: one photo at a time."""
    env = os.environ.get(WORKERS_ENV)
    if not env:
        return None
    try:
        return max(1, int(env))
    except ValueError:
        return 1


def plan_workers(
    photos: int, pixels: int, bytes_per_pixel: int, budget: int, cores: int | None = None
) -> int:
    """How many photos to work on at once: as many as fit 80% of the memory budget, a third of
    the cores (the matcher and numpy use several each) and ``MAX_WORKERS``; one for small photos."""
    if photos <= 1:
        return 1
    forced = forced_workers()
    if forced is not None:
        return min(forced, photos)
    if pixels < MIN_PIXELS:
        return 1
    cores = cores or os.cpu_count() or 1
    by_memory = int(0.8 * budget // max(1, pixels * bytes_per_pixel))
    return max(1, min(MAX_WORKERS, cores // 3, by_memory, photos))


def worker_threads(workers: int) -> int:
    """Threads each worker's libraries may use, so workers times threads stays within the cores."""
    return max(1, (os.cpu_count() or 1) // max(1, workers))


def cap_threads(threads: int) -> None:
    """In a worker: hold OpenCV to ``threads`` (BLAS reads its cap from the environment)."""
    try:
        import cv2
    except ImportError:
        return
    cv2.setNumThreads(threads)


def _stop(executor: ProcessPoolExecutor) -> None:
    """Stop the workers now. ``shutdown`` only stops handing out work; a worker in the middle of
    a photo would run on for minutes, so its process is ended (Python 3.14 has a public call)."""
    procs = list((getattr(executor, "_processes", None) or {}).values())
    executor.shutdown(wait=False, cancel_futures=True)
    for p in procs:
        if p.is_alive():
            p.terminate()
    for p in procs:
        p.join(5)


def run_pool(
    workers: int,
    init: Callable[..., None],
    initargs: tuple,
    task: Callable[[Any], Any],
    items: list,
    check: Callable[[], None],
    done: Callable[[Any, Any], None],
) -> None:
    """Run ``task(item)`` for every item in ``workers`` processes, each started with
    ``init(*initargs)``. ``done(item, result)`` is called here as each one finishes; ``check`` is
    called about twenty times a second and whatever it raises (a cancel) stops the workers."""
    threads = worker_threads(workers)
    saved = {k: os.environ.get(k) for k in _THREAD_ENV}
    os.environ.update({k: str(threads) for k in _THREAD_ENV})  # the workers inherit these
    executor = ProcessPoolExecutor(
        workers, mp_context=multiprocessing.get_context("spawn"), initializer=init, initargs=initargs
    )
    try:
        try:
            pending: dict[Future, Any] = {executor.submit(task, item): item for item in items}
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
        while pending:
            check()
            finished, _ = wait(pending, timeout=0.05, return_when=FIRST_COMPLETED)
            for f in finished:
                item = pending.pop(f)
                done(item, f.result())
        executor.shutdown(wait=True)
    except BrokenProcessPool as e:
        _stop(executor)
        raise PoolBroken(str(e)) from e
    except BaseException:
        _stop(executor)
        raise


# ----------------------------------------------------------------------------------- depth maps

_W: dict[str, Any] = {}


def dense_state(model, scale: float, budget: int, out) -> dict[str, Any]:
    """What making one photo's depth map needs: the same in the job's process and in a worker."""
    from .dense import DenseSettings, make_matcher, select_pairs
    from .products import _Images

    settings = DenseSettings(scale=scale)
    return {
        "model": model,
        "settings": settings,
        "pairs": select_pairs(model, settings.neighbours),
        "matcher": make_matcher(settings, budget, "auto"),
        "images": _Images(scale),
        "out": out,
    }


def depth_photo(state: dict[str, Any], view_id: int, check: Callable[[], None]) -> int:
    """Make and save one photo's depth map; the pixels matched over its pairs."""
    import numpy as np

    from ..runtime import replace_over
    from .dense import depth_map

    model = state["model"]
    v = model.view(view_id)
    partners = [model.view(j) for j in state["pairs"].get(view_id, [])]
    d, info = depth_map(v, partners, state["images"], model, state["matcher"], state["settings"], check)
    tmp = state["out"] / f".{view_id}.tmp.npy"
    np.save(tmp, d)
    replace_over(tmp, state["out"] / f"{view_id}.npy")
    return sum(p["matched"] for p in info["pairs"])


def init_dense(project: str, run_id: str, scale: float, budget: int, out: str, threads: int) -> None:
    from pathlib import Path

    from .scene import load_run

    cap_threads(threads)
    _W.clear()
    _W.update(dense_state(load_run(Path(project), run_id).model, scale, budget, Path(out)))


def dense_task(view_id: int) -> int:
    return depth_photo(_W, view_id, lambda: None)
