# Photo products on several cores: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `photo.products` makes depth maps and fuses them on several CPU cores, and fusion stops repeating the same per-camera work for every photo, with the same files as today.

**Architecture:** The per-photo bodies of the `dense` and `fuse` steps move into one small module, `photo/pool.py`, that both the existing in-process loop and new worker processes call, so one process and many processes run the same code. The step decides how many workers fit the cores and the memory cap; with one worker nothing is started and the step runs as it does today. Fusion's pixel directions are kept per camera.

**Tech Stack:** Python 3.13, numpy, OpenCV (unchanged matcher), `concurrent.futures.ProcessPoolExecutor` with the `spawn` start method, pytest.

**Spec:** `docs/plans/2026-10-10-gpu-acceleration.md`, work package WP1, as changed by its "Spike results" (item 3 of "What this changes"). The array-module seam of the original WP1 is **not** in this plan: the spike showed the card's versions of these functions differ in shape (no matrix products, row chunks), so the seam is drawn in the package that puts them on the card, against a real add-on.

## Global Constraints

- One worker gives exactly today's depth maps and fused tiles; several workers give the same files as one.
- No new dependency, no contract change (`@aio/schema` untouched), no change to the matcher, `colmap_io.py`, `align.py`, `gcp.py` or georeferencing.
- Files are renamed only through `runtime.replace_over` or `atomic_write_bytes` (`python/tests/test_replace_over_callers.py`). Temporary names stay fixed per photo so a resumed job overwrites them; nothing is named after a process id.
- The memory cap is `AIO_PHOTO_MEMORY_MB` (`native.memory_budget()`); workers are sized within it. Workers cap their OpenCV and BLAS threads so workers times threads does not exceed the cores.
- A cancel or pause reaches the workers within a fraction of a second and the job still ends `cancelled`.
- Measured sizes this plan relies on (spike, 11 Oct 2026): a depth-map worker peaks at about 295 bytes per pixel of the matching size (1.5 GB at 5.2 MP, 6.2 GB at 20.9 MP); fusing one photo peaks at about 234 bytes per pixel; eight workers gave 3.6 times at 5.2 MP and four gave 2.3 times at 20.9 MP.
- Public repository: no client, site, tester or person names in code, tests, commits or this file.

## Review Focus

1. **A worker dies (out of memory, killed by the system).** Expected: the job does not hang or fail; it warns and finishes the remaining photos one at a time. Test in Task 2 (`test_a_worker_that_dies_is_reported`) and Task 3 (`test_a_broken_pool_finishes_in_process`).
2. **Pause or cancel while workers are busy.** Expected: workers stop within a second, the job ends `cancelled`, a resume skips finished photos. Test in Task 3 (`test_cancel_stops_the_workers_and_resume_continues`).
3. **A small computer or a CI runner (4 cores, 7 GB).** Expected: one worker, no processes started, today's path. Test in Task 2 (`test_plan_workers`).
4. **A photo a worker cannot read.** Expected: the job fails with the same message as today ("The photo ... could not be read"), not a pickling error. Test in Task 2 (`test_a_job_error_in_a_worker_keeps_its_message`).
5. **Few photos, or small photos.** Expected: no pool (starting processes costs more than it saves), so short jobs and the existing tests do not slow down. Test in Task 2 (`test_plan_workers`).

## Execution DAG

```
T1 pixel rays per camera ──────────────┐
T2 pool module ──► T3 depth maps ──► T4 fusion ──► T5 docs and hand-off
```

- **Batch A (parallel, no shared files):** T1 (`scene.py`, `fuse.py`, `test_photo_dense.py`) and T2 (`pool.py`, `test_photo_pool.py`, `pool_tasks.py`).
- **Batch B:** T3 (`pool.py`, `products.py::_dense`, `test_photo_pool.py`), after T2.
- **Batch C:** T4 (`pool.py`, `products.py::_fuse`, `test_photo_pool.py`), after T1 and T3 (same files as T3).
- **Batch D:** T5 (docs), after T4.
- **Critical path:** T2, T3, T4, T5.
- **Packages touched:** `python/` only, plus `docs/`. **E2E specs added or changed:** none (no app code changes; `photo-process.spec.ts` covers Pause and is run before hand-off). **Contract changes:** none.

---

### Task 1: Pixel directions per camera

**Files:**

- Modify: `python/src/aio_pipelines/photo/scene.py` (after `class Camera`)
- Modify: `python/src/aio_pipelines/photo/fuse.py` (`world_points`)
- Test: `python/tests/test_photo_dense.py`

**Interfaces:**

- Produces: `scene.pixel_rays(cam: Camera) -> np.ndarray`, the cached `(height, width, 3)` float32 array of `Camera.pixel_rays()`; read-only.

- [ ] **Step 1: Write the failing test** (append to `python/tests/test_photo_dense.py`)

```python
def test_pixel_directions_are_worked_out_once_per_camera(monkeypatch):
    from aio_pipelines.photo import scene as S

    s = ps.scene()
    a, b = s.views[5], s.views[6]
    cam = a.camera
    da, db = D.zbuffer(cam, a, s.points), D.zbuffer(cam, b, s.points)
    want = world_points(a, cam, da, cam.pixel_rays())
    calls = []
    real = S.Camera.pixel_rays
    monkeypatch.setattr(S.Camera, "pixel_rays", lambda self: calls.append(1) or real(self))
    S.pixel_rays.cache_clear()
    got_a = world_points(a, cam, da)
    world_points(b, cam, db)
    assert len(calls) == 1
    np.testing.assert_array_equal(got_a, want)
    assert not S.pixel_rays(cam).flags.writeable
```

- [ ] **Step 2: Run it and see it fail**

Run: `uv run pytest tests/test_photo_dense.py::test_pixel_directions_are_worked_out_once_per_camera -q` (from `python/`)
Expected: FAIL, `module 'aio_pipelines.photo.scene' has no attribute 'pixel_rays'`

- [ ] **Step 3: Implement**

`scene.py`, after the `Camera` class (add `import functools` to the imports):

```python
@functools.lru_cache(maxsize=2)
def pixel_rays(cam: Camera) -> np.ndarray:
    """``cam.pixel_rays()``, kept for the last two cameras: a run has one or two, and fusion asks
    for every photo (the lens model is half of fusing a photo otherwise). Read-only."""
    rays = cam.pixel_rays()
    rays.flags.writeable = False
    return rays
```

`fuse.py`, `world_points`: replace `r = cam.pixel_rays() if rays is None else rays` with

```python
    r = pixel_rays(cam) if rays is None else rays
```

and change the import to `from .scene import Camera, View, pixel_rays`.

- [ ] **Step 4: Run the dense tests**

Run: `uv run pytest tests/test_photo_dense.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add python/src/aio_pipelines/photo/scene.py python/src/aio_pipelines/photo/fuse.py python/tests/test_photo_dense.py
git commit -m "perf(photo): fusion keeps the pixel directions per camera"
```

### Task 2: The pool module

**Files:**

- Create: `python/src/aio_pipelines/photo/pool.py`
- Create: `python/tests/pool_tasks.py` (functions a worker process can import)
- Test: `python/tests/test_photo_pool.py`

**Interfaces:**

- Produces:
  - `WORKERS_ENV = "AIO_PHOTO_WORKERS"`: a whole number forces the worker count (tests, support); `1` is today's path.
  - `plan_workers(photos: int, pixels: int, bytes_per_pixel: int, budget: int, cores: int | None = None) -> int`
  - `DENSE_BYTES_PER_PIXEL = 300`, `FUSE_BYTES_PER_PIXEL = 250`, `MAX_WORKERS = 8`, `MIN_PIXELS = 2_000_000`
  - `class PoolBroken(Exception)`: a worker process stopped; carries `done: list` of the items finished.
  - `run_pool(workers: int, init: Callable[..., None], initargs: tuple, task: Callable[[Any], Any], items: list, check: Callable[[], None], done: Callable[[Any, Any], None]) -> None`: runs `task(item)` in `workers` processes started with `init(*initargs)`; calls `done(item, result)` in the caller's process as each finishes; calls `check()` about twenty times a second and stops the workers when it (or anything) raises.

- [ ] **Step 1: Write the failing tests**

`python/tests/pool_tasks.py`:

```python
"""Task functions for test_photo_pool: a worker process imports them by name."""

import os
import time

from aio_pipelines.runtime import JobError

STATE: dict = {}


def init(offset: int) -> None:
    STATE["offset"] = offset


def add(x: int) -> int:
    return x + STATE["offset"]


def slow(x: int) -> int:
    time.sleep(30)
    return x


def refuse(x: int) -> int:
    raise JobError(f"The photo {x} could not be read: broken")


def die(x: int) -> int:
    if x == 2:
        os._exit(3)
    time.sleep(0.2)
    return x
```

`python/tests/test_photo_pool.py`:

```python
"""photo/pool.py: how many workers, and the pool that runs the per-photo stages."""

import time

import pytest

import pool_tasks as T
from aio_pipelines.photo import pool as P
from aio_pipelines.runtime import Cancelled, JobError

GB = 1024**3


@pytest.mark.parametrize(
    "photos, pixels, budget, cores, want",
    [
        (200, 20_900_000, 48 * GB, 24, 6),  # by memory: 0.8 * 48 GB over 6.3 GB each
        (200, 5_200_000, 48 * GB, 24, 8),  # by the ceiling
        (200, 5_200_000, 48 * GB, 8, 2),  # by cores: the matcher threads need them too
        (200, 5_200_000, 3 * GB, 4, 1),  # a CI runner
        (200, 300_000, 48 * GB, 24, 1),  # small photos: not worth starting processes
        (1, 20_900_000, 48 * GB, 24, 1),
        (3, 5_200_000, 48 * GB, 24, 3),  # never more workers than photos
    ],
)
def test_plan_workers(monkeypatch, photos, pixels, budget, cores, want):
    monkeypatch.delenv(P.WORKERS_ENV, raising=False)
    assert P.plan_workers(photos, pixels, P.DENSE_BYTES_PER_PIXEL, budget, cores) == want


def test_the_worker_count_can_be_forced(monkeypatch):
    monkeypatch.setenv(P.WORKERS_ENV, "2")
    assert P.plan_workers(200, 300_000, P.DENSE_BYTES_PER_PIXEL, GB, 4) == 2
    assert P.plan_workers(1, 300_000, P.DENSE_BYTES_PER_PIXEL, GB, 4) == 1
    monkeypatch.setenv(P.WORKERS_ENV, "many")
    assert P.plan_workers(200, 300_000, P.DENSE_BYTES_PER_PIXEL, GB, 4) == 1


def test_results_come_back_with_their_items():
    got = {}
    P.run_pool(2, T.init, (10,), T.add, [1, 2, 3, 4], lambda: None, got.__setitem__)
    assert got == {1: 11, 2: 12, 3: 13, 4: 14}


def test_a_cancel_stops_the_workers_at_once():
    t0 = time.monotonic()

    def check():
        if time.monotonic() - t0 > 1.0:
            raise Cancelled()

    with pytest.raises(Cancelled):
        P.run_pool(2, T.init, (0,), T.slow, [1, 2, 3], check, lambda item, res: None)
    assert time.monotonic() - t0 < 15  # the 30 s tasks did not run out


def test_a_job_error_in_a_worker_keeps_its_message():
    with pytest.raises(JobError, match="The photo 1 could not be read: broken"):
        P.run_pool(2, T.init, (0,), T.refuse, [1, 2], lambda: None, lambda item, res: None)


def test_a_worker_that_dies_is_reported():
    done = []
    with pytest.raises(P.PoolBroken):
        P.run_pool(2, T.init, (0,), T.die, [1, 2, 3, 4], lambda: None, lambda item, res: done.append(item))
    assert 2 not in done
```

- [ ] **Step 2: Run them and see them fail**

Run: `uv run pytest tests/test_photo_pool.py -q`
Expected: FAIL at import, `cannot import name 'pool'`.

- [ ] **Step 3: Implement `python/src/aio_pipelines/photo/pool.py`**

```python
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
import time
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
    Anything that is not a whole number of 1 or more counts as 1: today's path."""
    env = os.environ.get(WORKERS_ENV)
    if not env:
        return None
    try:
        return max(1, int(env))
    except ValueError:
        return 1


def plan_workers(photos: int, pixels: int, bytes_per_pixel: int, budget: int, cores: int | None = None) -> int:
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

        cv2.setNumThreads(threads)
    except ImportError:
        pass


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
```

- [ ] **Step 4: Run the tests**

Run: `uv run pytest tests/test_photo_pool.py -q`
Expected: all pass (about 15 s: each test starts two processes).

- [ ] **Step 5: Commit**

```bash
git add python/src/aio_pipelines/photo/pool.py python/tests/pool_tasks.py python/tests/test_photo_pool.py
git commit -m "feat(photo): a pool of worker processes sized by cores and memory"
```

### Task 3: Depth maps through the pool

**Files:**

- Modify: `python/src/aio_pipelines/photo/pool.py` (add the depth-map state, body and worker entry points)
- Modify: `python/src/aio_pipelines/photo/products.py` (`_dense`)
- Test: `python/tests/test_photo_pool.py`

**Interfaces:**

- Consumes: `run_pool`, `plan_workers`, `PoolBroken`, `DENSE_BYTES_PER_PIXEL`, `cap_threads`, `worker_threads` (Task 2).
- Produces (in `pool.py`):
  - `dense_state(model, scale: float, budget: int, out: Path) -> dict`
  - `depth_photo(state: dict, view_id: int, check: Callable[[], None]) -> int` (pixels matched; writes `out/<id>.npy`)
  - `init_dense(project: str, run_id: str, scale: float, budget: int, out: str, threads: int) -> None`, `dense_task(view_id: int) -> int`
- `_dense` outputs gain `"workers": int`.

- [ ] **Step 1: Write the failing tests** (append to `python/tests/test_photo_pool.py`)

```python
import json
import threading

import numpy as np

import products_synth as ps
from aio_pipelines.photo.products import PhotoProducts
from aio_pipelines.runtime import Job
from conftest import Recorder

RUN = ps.RUN
PARAMS = {"run": RUN, "products": ["dsm"], "preset": "standard"}


def _until(step: str):
    """An emit function that cancels the job when ``step`` starts, and the event it sets."""
    cancel = threading.Event()

    def emit(m, p):
        if m == "progress" and p.get("step") == step:
            cancel.set()

    return emit, cancel


def _depth(root):
    d = next((root / "photogrammetry" / RUN / "work" / "products").glob("*/depth"))
    return {p.name: np.load(p) for p in sorted(d.glob("*.npy"))}


def _dense_only(name: str, monkeypatch, workers: str):
    monkeypatch.setenv(P.WORKERS_ENV, workers)
    root = ps.project(name)
    emit, cancel = _until("fuse")
    with pytest.raises(Cancelled):
        Job("d1", PhotoProducts(), root, PARAMS, emit, cancel).run()
    return root


def test_two_workers_make_the_depth_maps_of_one(monkeypatch):
    one = _depth(_dense_only("pool-one", monkeypatch, "1"))
    root = _dense_only("pool-two", monkeypatch, "2")
    two = _depth(root)
    assert one.keys() == two.keys() and len(one) > 4
    for name in one:
        np.testing.assert_array_equal(one[name], two[name])
    step = json.loads((root / "jobs" / "d1" / "steps" / "02-dense.json").read_text("utf-8"))
    assert step["outputs"]["workers"] == 2


def test_cancel_stops_the_workers_and_resume_continues(monkeypatch):
    monkeypatch.setenv(P.WORKERS_ENV, "2")
    root = ps.project("pool-cancel")
    cancel = threading.Event()

    def emit(m, p):
        if m == "progress" and str(p.get("message", "")).startswith("Depth map 3 of"):
            cancel.set()

    with pytest.raises(Cancelled):
        Job("c1", PhotoProducts(), root, PARAMS, emit, cancel).run()
    job = json.loads((root / "jobs" / "c1" / "job.json").read_text("utf-8"))
    assert job["status"] == "cancelled"
    emit2, cancel2 = _until("fuse")
    with pytest.raises(Cancelled):
        Job("c1", PhotoProducts(), root, PARAMS, emit2, cancel2).run()
    step = json.loads((root / "jobs" / "c1" / "steps" / "02-dense.json").read_text("utf-8"))
    assert step["outputs"]["resumed"] >= 3


def test_a_broken_pool_finishes_in_process(monkeypatch):
    monkeypatch.setenv(P.WORKERS_ENV, "2")

    def broken(*a, **k):
        raise P.PoolBroken("a worker stopped")

    monkeypatch.setattr(P, "run_pool", broken)
    root = ps.project("pool-broken")
    seen = Recorder()
    cancel = threading.Event()

    def emit(m, p):
        seen(m, p)
        if m == "progress" and p.get("step") == "fuse":
            cancel.set()

    with pytest.raises(Cancelled):
        Job("b1", PhotoProducts(), root, PARAMS, emit, cancel).run()
    assert len(_depth(root)) > 4
    assert any("one photo at a time" in p.get("message", "") for p in seen.of("log"))
```

- [ ] **Step 2: Run them and see them fail**

Run: `uv run pytest tests/test_photo_pool.py -q -k "workers_make or cancel_stops or broken_pool"`
Expected: FAIL, `KeyError: 'workers'` (and the pool is never used).

- [ ] **Step 3: Implement**

Append to `pool.py`:

```python
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
```

Replace the body of `PhotoProducts._dense` in `products.py` from `run = self._run(ctx)` to the `return` with:

```python
        from . import pool

        run = self._run(ctx)
        out = self._work(ctx) / "depth"
        out.mkdir(parents=True, exist_ok=True)
        budget = native.memory_budget()
        state = pool.dense_state(run.model, s["scale"], budget, out)
        matcher, pairs = state["matcher"], state["pairs"]
        ctx.log(f"Dense matching with {matcher.name} at {s['scale']:.0%} of the photo size.")
        views = run.model.views
        cam = views[0].camera.scaled(s["scale"])
        done = 0
        todo: list[int] = []
        for v in views:
            ctx.check()
            if (out / f"{v.id}.npy").exists():
                done += 1
            elif not pairs.get(v.id):
                ctx.log(f"{v.name}: no photo overlaps it enough for matching.", "warn")
                d = np.full(
                    (round(v.camera.height * s["scale"]), round(v.camera.width * s["scale"])),
                    np.nan,
                    np.float32,
                )
                tmp = out / f".{v.id}.tmp.npy"
                np.save(tmp, d)
                replace_over(tmp, out / f"{v.id}.npy")
            else:
                todo.append(v.id)
        made = len(views) - len(todo)

        def finished(view_id: int, matched: int) -> None:
            nonlocal made
            made += 1
            ctx.progress(made / len(views), f"Depth map {made} of {len(views)}")

        workers = pool.plan_workers(len(todo), cam.width * cam.height, pool.DENSE_BYTES_PER_PIXEL, budget)
        if workers > 1:
            ctx.log(f"Depth maps of {workers} photos at a time.")
            args = (
                str(ctx.project),
                ctx.params["run"],
                s["scale"],
                budget // workers,
                str(out),
                pool.worker_threads(workers),
            )
            try:
                pool.run_pool(workers, pool.init_dense, args, pool.dense_task, todo, ctx.check, finished)
                todo = []
            except pool.PoolBroken:
                ctx.log("A worker process stopped; finishing the depth maps one photo at a time.", "warn")
                made = sum((out / f"{v.id}.npy").exists() for v in views)
                todo = [i for i in todo if not (out / f"{i}.npy").exists()]
        for view_id in todo:
            ctx.check()
            finished(view_id, pool.depth_photo(state, view_id, ctx.check))
        return {
            "engine": matcher.name,
            "maps": len(views),
            "resumed": done,
            "pairs": sum(len(x) for x in pairs.values()),
            "workers": workers,
        }
```

The first lines of `_dense` (the `s = self._settings(ctx)` and the Fast preset return) stay; the import line at its top becomes unused and is removed.

- [ ] **Step 4: Run the pool tests and the products tests that touch depth maps**

Run: `uv run pytest tests/test_photo_pool.py tests/test_photo_products.py -q -k "pool or workers or cancel or broken or resume or memory_cap or dense_cloud"`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add python/src/aio_pipelines/photo/pool.py python/src/aio_pipelines/photo/products.py python/tests/test_photo_pool.py
git commit -m "feat(photo): depth maps of several photos at once"
```

### Task 4: Fusion through the pool

**Files:**

- Modify: `python/src/aio_pipelines/photo/pool.py` (fusion state, body and worker entry points)
- Modify: `python/src/aio_pipelines/photo/products.py` (`_fuse`)
- Test: `python/tests/test_photo_pool.py`

**Interfaces:**

- Consumes: Task 2's pool; Task 1's `pixel_rays` (through `fuse.world_points`).
- Produces (in `pool.py`):
  - `fuse_state(model, scale: float, depth_dir: Path, store_root: Path, tile_m: float) -> dict`
  - `fuse_photo(state: dict, view_id: int) -> int` (points added; writes the photo's chunks and its mark)
  - `init_fuse(project: str, run_id: str, scale: float, depth_dir: str, store_root: str, tile_m: float, threads: int) -> None`, `fuse_task(view_id: int) -> int`
- `_fuse` outputs gain `"workers": int`.

- [ ] **Step 1: Write the failing test** (append to `python/tests/test_photo_pool.py`)

```python
def _fused(root):
    d = next((root / "photogrammetry" / RUN / "work" / "products").glob("*/cloud/fused"))
    out = {}
    for p in sorted(d.glob("*.npz")):
        with np.load(p) as z:
            out[p.name] = {k: z[k] for k in z.files}
    return out


def _fuse_only(name: str, monkeypatch, workers: str):
    monkeypatch.setenv(P.WORKERS_ENV, workers)
    root = ps.project(name)
    emit, cancel = _until("dsm")
    with pytest.raises(Cancelled):
        Job("f1", PhotoProducts(), root, PARAMS, emit, cancel).run()
    return root


def test_two_workers_fuse_the_cloud_of_one(monkeypatch):
    one = _fused(_fuse_only("fuse-one", monkeypatch, "1"))
    root = _fuse_only("fuse-two", monkeypatch, "2")
    two = _fused(root)
    assert one.keys() == two.keys() and one
    for name in one:
        for key in one[name]:
            np.testing.assert_array_equal(one[name][key], two[name][key])
    step = json.loads((root / "jobs" / "f1" / "steps" / "03-fuse.json").read_text("utf-8"))
    assert step["outputs"]["workers"] == 2
```

- [ ] **Step 2: Run it and see it fail**

Run: `uv run pytest tests/test_photo_pool.py -q -k fuse_the_cloud`
Expected: FAIL, `KeyError: 'workers'`.

- [ ] **Step 3: Implement**

Append to `pool.py`:

```python
# -------------------------------------------------------------------------------------- fusion


def fuse_state(model, scale: float, depth_dir, store_root, tile_m: float) -> dict[str, Any]:
    """What fusing one photo needs: the same in the job's process and in a worker."""
    from .dense import select_pairs
    from .fuse import FuseSettings, PointTiles

    settings = FuseSettings()
    marks = store_root / "chunks" / ".done"
    marks.mkdir(parents=True, exist_ok=True)
    return {
        "model": model,
        "scale": scale,
        "settings": settings,
        "near": select_pairs(model, settings.neighbours),
        "cams": {v.id: v.camera.scaled(scale) for v in model.views},
        "depth": depth_dir,
        "store": PointTiles(store_root, tile_m),
        "marks": marks,
    }


def fuse_photo(state: dict[str, Any], view_id: int) -> int:
    """Keep one photo's points that its neighbours confirm, add them to the tiles and mark the
    photo done; the points added."""
    import numpy as np

    from .fuse import consistent, normals_of
    from .scene import load_image

    model, cams, depth, settings = state["model"], state["cams"], state["depth"], state["settings"]
    v = model.view(view_id)
    d = np.load(depth / f"{v.id}.npy")
    others = [(model.view(j), cams[j], np.load(depth / f"{j}.npy")) for j in state["near"].get(v.id, [])]
    pts, agree = consistent(v, cams[v.id], d, others, settings)
    good = np.isfinite(d) & (agree >= settings.min_agree)
    added = 0
    if good.any():
        nrm = normals_of(pts, v.centre)
        img = load_image(v.path, state["scale"])
        h, w = d.shape
        rgb = img[:h, :w][good]
        ok = np.isfinite(nrm[good]).all(1)
        added = state["store"].add(f"v{v.id}", pts[good][ok], rgb[ok], nrm[good][ok].astype(np.float32))
    (state["marks"] / str(v.id)).write_text("", "utf-8")
    return added


def init_fuse(
    project: str, run_id: str, scale: float, depth_dir: str, store_root: str, tile_m: float, threads: int
) -> None:
    from pathlib import Path

    from .scene import load_run

    cap_threads(threads)
    _W.clear()
    _W.update(fuse_state(load_run(Path(project), run_id).model, scale, Path(depth_dir), Path(store_root), tile_m))


def fuse_task(view_id: int) -> int:
    return fuse_photo(_W, view_id)
```

In `PhotoProducts._fuse` (`products.py`), replace everything from `from .dense import select_pairs` down to and including the per-photo `for` loop (up to, not including, `voxel = s["gsd"] / s["scale"]`) with:

```python
        from . import pool

        views = run.model.views
        depth_dir = self._work(ctx) / "depth"
        state = pool.fuse_state(run.model, s["scale"], depth_dir, store.root, s["tileM"])
        marks = state["marks"]
        todo = [v.id for v in views if not (marks / str(v.id)).exists()]
        made = len(views) - len(todo)

        def finished(view_id: int, added: int) -> None:
            nonlocal made
            made += 1
            ctx.progress(0.7 * made / len(views), f"Fusing photo {made} of {len(views)}")

        cam = views[0].camera.scaled(s["scale"])
        budget = native.memory_budget()
        workers = pool.plan_workers(len(todo), cam.width * cam.height, pool.FUSE_BYTES_PER_PIXEL, budget)
        if workers > 1:
            ctx.log(f"Fusing {workers} photos at a time.")
            args = (
                str(ctx.project),
                ctx.params["run"],
                s["scale"],
                str(depth_dir),
                str(store.root),
                s["tileM"],
                pool.worker_threads(workers),
            )
            try:
                pool.run_pool(workers, pool.init_fuse, args, pool.fuse_task, todo, ctx.check, finished)
                todo = []
            except pool.PoolBroken:
                ctx.log("A worker process stopped; fusing the rest one photo at a time.", "warn")
                todo = [i for i in todo if not (marks / str(i)).exists()]
                made = len(views) - len(todo)
        for view_id in todo:
            ctx.check()
            finished(view_id, pool.fuse_photo(state, view_id))
```

and add `"workers": workers` to the dictionary the dense branch of `_fuse` returns. The `settings = FuseSettings()`, `marks`, `near`, `cams` lines and the `from .scene import load_image` import above the old loop go with it; the `from .fuse import ...` line at the top of `_fuse` keeps only what the sparse (Fast) branch and the merge still use.

- [ ] **Step 4: Run the whole photo suite**

Run: `uv run pytest tests/test_photo_pool.py tests/test_photo_products.py tests/test_photo_dense.py tests/test_photo_chain.py tests/test_replace_over_callers.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add python/src/aio_pipelines/photo/pool.py python/src/aio_pipelines/photo/products.py python/tests/test_photo_pool.py
git commit -m "feat(photo): fusion of several photos at once"
```

### Task 5: Docs, checks and hand-off

**Files:**

- Modify: `docs/architecture/data-conventions.md` (the "Memory" bullet of the photo jobs, section 21)
- Modify: `docs/plans/2026-10-10-gpu-acceleration.md` (record the founder's 11 Oct decision and that WP1 is built)
- Modify: `docs/KNOWN-LIMITS.md` only if a line there is now wrong (the "CPU only" line stays true)

- [ ] **Step 1: `data-conventions.md`**, after the "Memory" bullet, add:

```markdown
- **Workers**: `photo.products` makes depth maps and fuses them for several photos at once, in worker processes: as many as fit 80 % of that memory cap (about 300 bytes per pixel of the matching size for a depth map, 250 for fusion), a third of the logical cores and eight; one, in the job's own process, for photos under 2 MP at the matching size. `AIO_PHOTO_WORKERS` forces the number (tests and support; `1` is one photo at a time). The files are the same for any number, and a worker that stops makes the stage finish one photo at a time with a warning.
```

- [ ] **Step 2: the GPU plan**, at the end of "What this changes in the plan", add:

```markdown
> **Decided, 11 Oct 2026.** The founder accepted the recommendations of this section: one add-on that carries cuBLAS, with a budget of 1,200 MB installed (item 4, option a), delivered as a file beside the installer and the pipeline pack and installed in Settings, Processing tools, never inside the installer and with no automatic download until a download host is decided. The first item of WP1 and its process pool are built (`docs/plans/2026-10-11-photo-dense-pool.md`); the array-module seam moved to the package that puts the array code on the card.
```

- [ ] **Step 3: Checks**

Run from the worktree root: `pnpm check`. Then, from `python/`, time the gain once on the small set with the pool forced and not forced (`AIO_PHOTO_WORKERS=1` and unset) and put both numbers in the hand-off message. No long runs on the founder's workstation without a time window.

- [ ] **Step 4: Commit and hand off**

```bash
git add docs
git commit -m "docs: photo products on several cores, and the add-on decision of 11 Oct"
node tools/agent/finish-task.mjs
```

Send the printed hand-off message to the Orchestrator.
