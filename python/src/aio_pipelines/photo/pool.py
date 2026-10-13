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

import contextlib
import math
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
#: Memory of merging one tile per byte of its chunks: unpacked to float64, voxel keys, sorting.
#: The outlier filter's tile, KD-tree and distances come to about 110 bytes a point, under the
#: 180 this gives each 18 byte chunk point (a tile only loses points to the merge).
MERGE_BYTES_PER_CHUNK_BYTE = 10
#: On top, per worker: one block of the outlier filter's neighbour query (``fuse.OUTLIER_BLOCK``
#: points of 17 float64 distances and 17 int64 indices).
MERGE_FILTER_BYTES = 1_000_000 * 17 * 16
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


def plan_merge_workers(tiles: int, largest: int, budget: int, cores: int | None = None) -> int:
    """How many tiles to merge at once: as many as fit 80% of the memory budget at the largest
    tile's chunk bytes (plus the outlier filter's block), half the cores and ``MAX_WORKERS``."""
    if tiles <= 1:
        return 1
    forced = forced_workers()
    if forced is not None:
        return min(forced, tiles)
    cores = cores or os.cpu_count() or 1
    per_tile = largest * MERGE_BYTES_PER_CHUNK_BYTE + MERGE_FILTER_BYTES
    by_memory = int(0.8 * budget // max(1, per_tile))
    return max(1, min(MAX_WORKERS, max(1, cores // 2), by_memory, tiles))


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


# ---------------------------------------------------------------------------- the graphics card

#: Card memory one worker takes: its CUDA context and CuPy's kernels, plus the working arrays per
#: pixel of the matching size (2.2 GB at 20.9 MP, 1.6 GB at 5.2 MP in the spike of 11 Oct 2026).
CARD_BASE_BYTES = 1_200_000_000
CARD_BYTES_PER_PIXEL = 70
#: Main memory of a worker whose array code runs on the card: the photos and the matcher.
CARD_HOST_BYTES_PER_PIXEL = 120
#: The CPU matcher is what is left to wait for, so more workers than this gain little.
MAX_CARD_WORKERS = 4


def plan_card_workers(
    photos: int, pixels: int, free_card: int, budget: int, cores: int | None = None, insist: bool = False
) -> int:
    """How many worker processes share the graphics card; 0 when the card should not be used:
    too little of its memory is free for one worker, or the photos are small (unless ``insist``,
    the job asked for the card by name)."""
    if photos <= 0:
        return 0
    forced = forced_workers()
    if forced is not None:
        return min(forced, photos)
    if pixels < MIN_PIXELS and not insist:
        return 0
    by_card = int(0.7 * free_card // (CARD_BASE_BYTES + pixels * CARD_BYTES_PER_PIXEL))
    if by_card < 1:
        return 0
    cores = cores or os.cpu_count() or 1
    by_memory = int(0.8 * budget // max(1, pixels * CARD_HOST_BYTES_PER_PIXEL))
    return max(1, min(MAX_CARD_WORKERS, cores // 3, by_card, by_memory, photos))


def attach_card(state: dict[str, Any], addon: str | None) -> None:
    """In a worker: load the GPU add-on and keep its backend in ``state``. When that fails the
    worker works on the CPU and says why with its first photo (``card_problem``)."""
    if not addon:
        return
    try:
        from pathlib import Path

        from .. import accel
        from . import card

        accel.activate(Path(addon))
        b = card.cupy_backend()
        int(b.xp.arange(4).sum())  # the first call onto the card: a failure shows here
        state["card"], state["rays"] = b, card.Rays(b)
    except Exception as e:
        state["card_problem"] = f"{type(e).__name__}: {e}"[:300]


def with_card(state: dict[str, Any], on_card: Callable[[Any], Any], on_cpu: Callable[[], Any]):
    """One photo's work on the card when this process has it, else on the CPU; and on the CPU
    when the card fails (out of memory, a driver reset, a lost device). After two failures the
    process stops trying the card. Answers ``(result, device, problem)``."""
    from ..runtime import Cancelled, JobError

    b = state.get("card")
    if b is None:
        return on_cpu(), "cpu", state.pop("card_problem", None)
    try:
        return on_card(b), "gpu", None
    except (Cancelled, JobError):
        raise
    except Exception as e:
        problem = f"{type(e).__name__}: {e}"[:300]
        with contextlib.suppress(Exception):  # the card is already in trouble
            b.release()
        state["card_failures"] = state.get("card_failures", 0) + 1
        if state["card_failures"] >= 2:
            state["card"] = None
        return on_cpu(), "cpu", problem


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


def depth_photo(state: dict[str, Any], view_id: int, check: Callable[[], None]) -> dict[str, Any]:
    """Make and save one photo's depth map. Answers ``n`` (the pixels matched over its pairs),
    ``device`` (``gpu`` or ``cpu``: where the array code ran) and ``problem`` (why the card was
    not used for it, when it should have been)."""
    import numpy as np

    from ..runtime import replace_over
    from . import card
    from .dense import depth_map

    model = state["model"]
    v = model.view(view_id)
    partners = [model.view(j) for j in state["pairs"].get(view_id, [])]
    args = (v, partners, state["images"], model, state["matcher"], state["settings"], check)
    (d, info), device, problem = with_card(
        state, lambda b: card.depth_map(b, *args), lambda: depth_map(*args)
    )
    tmp = state["out"] / f".{view_id}.tmp.npy"
    np.save(tmp, d)
    replace_over(tmp, state["out"] / f"{view_id}.npy")
    return {"n": sum(p["matched"] for p in info["pairs"]), "device": device, "problem": problem}


def init_dense(
    project: str, run_id: str, scale: float, budget: int, out: str, threads: int, addon: str | None = None
) -> None:
    from pathlib import Path

    from .scene import load_run

    cap_threads(threads)
    _W.clear()
    _W.update(dense_state(load_run(Path(project), run_id).model, scale, budget, Path(out)))
    attach_card(_W, addon)


def dense_task(view_id: int) -> dict[str, Any]:
    return depth_photo(_W, view_id, lambda: None)


# -------------------------------------------------------------------------------------- fusion


def fuse_state(
    model, scale: float, depth_dir, store_root, tile_m: float, abs_tol: float = math.inf
) -> dict[str, Any]:
    """What fusing one photo needs: the same in the job's process and in a worker. ``store_root``
    is the folder that holds ``chunks/``; ``abs_tol`` the run's agreement limit in metres."""
    from .dense import select_pairs
    from .fuse import FuseSettings, PointTiles

    settings = FuseSettings(abs_tol=abs_tol)
    store = PointTiles(store_root, tile_m)
    marks = store.chunks_dir / ".done"
    marks.mkdir(parents=True, exist_ok=True)
    return {
        "model": model,
        "scale": scale,
        "settings": settings,
        "near": select_pairs(model, settings.neighbours),
        "cams": {v.id: v.camera.scaled(scale) for v in model.views},
        "depth": depth_dir,
        "store": store,
        "marks": marks,
    }


def fuse_photo(state: dict[str, Any], view_id: int) -> dict[str, Any]:
    """Keep one photo's points that its neighbours confirm, add them to the tiles and mark the
    photo done. Answers ``n`` (the points added), ``device`` and ``problem`` as ``depth_photo``."""
    import numpy as np

    from . import card
    from .fuse import consistent, normals_of
    from .scene import load_image

    model, cams, depth, settings = state["model"], state["cams"], state["depth"], state["settings"]
    v = model.view(view_id)
    d = np.load(depth / f"{v.id}.npy")
    others = [(model.view(j), cams[j], np.load(depth / f"{j}.npy")) for j in state["near"].get(v.id, [])]

    def on_cpu():
        pts, agree = consistent(v, cams[v.id], d, others, settings)
        good = np.isfinite(d) & (agree >= settings.min_agree)
        if not good.any():
            return None
        nrm = normals_of(pts, v.centre)
        ok = np.isfinite(nrm[good]).all(1)
        keep = np.zeros(d.shape, bool)
        keep[good] = ok
        return pts[good][ok], nrm[good][ok].astype(np.float32), keep

    def on_card(b):
        return card.fuse_arrays(b, v, cams[v.id], d, others, settings, state["rays"])

    kept, device, problem = with_card(state, on_card, on_cpu)
    added = 0
    if kept is not None and len(kept[0]):
        xyz, nrm, keep = kept
        h, w = d.shape
        rgb = load_image(v.path, state["scale"])[:h, :w][keep]
        added = state["store"].add(f"v{v.id}", xyz, rgb, nrm)
    (state["marks"] / str(v.id)).write_text("", "utf-8")
    return {"n": added, "device": device, "problem": problem}


def init_fuse(
    project: str,
    run_id: str,
    scale: float,
    depth_dir: str,
    store_root: str,
    tile_m: float,
    abs_tol: float,
    threads: int,
    addon: str | None = None,
) -> None:
    from pathlib import Path

    from .scene import load_run

    cap_threads(threads)
    _W.clear()
    model = load_run(Path(project), run_id).model
    _W.update(fuse_state(model, scale, Path(depth_dir), Path(store_root), tile_m, abs_tol))
    attach_card(_W, addon)


def fuse_task(view_id: int) -> dict[str, Any]:
    return fuse_photo(_W, view_id)


# ---------------------------------------------------------------------------------------- merge


def init_merge(root: str, chunks: str, tile_m: float, voxel: float, rule, keep, threads: int) -> None:
    from pathlib import Path

    from .fuse import PointTiles

    cap_threads(threads)
    _W.clear()
    _W.update(
        {
            "store": PointTiles(Path(root), tile_m, chunks=Path(chunks)),
            "voxel": voxel,
            "rule": rule,
            "keep": keep,
        }
    )


def merge_task(name: str) -> dict[str, Any]:
    from .fuse import merge_tile

    return merge_tile(_W["store"], name, _W["voxel"], _W["rule"], _W["keep"])


def filter_task(name: str) -> dict[str, Any]:
    from .fuse import filter_tile

    return filter_tile(_W["store"], name, _W["voxel"], _W["rule"])
