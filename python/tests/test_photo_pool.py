"""photo/pool.py: how many workers, and the pool that runs the per-photo stages."""

from __future__ import annotations

import json
import threading
import time

import numpy as np
import pytest

import pool_tasks as T
import products_synth as ps
from aio_pipelines.photo import pool as P
from aio_pipelines.photo.products import PhotoProducts
from aio_pipelines.runtime import Cancelled, Job, JobError
from conftest import Recorder

GB = 1024**3


@pytest.mark.parametrize(
    "photos, pixels, budget, cores, want",
    [
        (200, 20_900_000, 48 * GB, 24, 6),  # by memory: 0.8 * 48 GB over 6.3 GB each
        (200, 5_200_000, 48 * GB, 24, 8),  # by the ceiling
        (200, 5_200_000, 48 * GB, 8, 2),  # by cores: the matcher's threads need them too
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


# ------------------------------------------------------------------ photo.products through the pool

RUN = ps.RUN
PARAMS = {"run": RUN, "products": ["dsm"], "preset": "standard"}


def _after(step: str):
    """An emit function that cancels the job once ``step`` has finished, and the event it sets:
    the job stops before its next step."""
    cancel = threading.Event()

    def emit(m, p):
        if m == "progress" and p.get("step") == step and p.get("stepFraction") == 1.0:
            cancel.set()

    return emit, cancel


def _step(root, job: str, name: str) -> dict:
    return json.loads((root / "jobs" / job / "steps" / name).read_text("utf-8"))["outputs"]


def _depth(root):
    d = next((root / "photogrammetry" / RUN / "work" / "products").glob("*/depth"))
    return {p.name: np.load(p) for p in sorted(d.glob("*.npy"))}


def _dense_only(name: str, monkeypatch, workers: str):
    monkeypatch.setenv(P.WORKERS_ENV, workers)
    root = ps.project(name)
    emit, cancel = _after("dense")
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
    assert _step(root, "d1", "02-dense.json")["workers"] == 2


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
    emit2, cancel2 = _after("dense")
    with pytest.raises(Cancelled):
        Job("c1", PhotoProducts(), root, PARAMS, emit2, cancel2).run()
    assert _step(root, "c1", "02-dense.json")["resumed"] >= 3


def test_a_broken_pool_finishes_in_process(monkeypatch):
    monkeypatch.setenv(P.WORKERS_ENV, "2")

    def broken(*a, **k):
        raise P.PoolBroken("a worker stopped")

    monkeypatch.setattr(P, "run_pool", broken)
    root = ps.project("pool-broken")
    seen = Recorder()
    after, cancel = _after("dense")

    def emit(m, p):
        seen(m, p)
        after(m, p)

    with pytest.raises(Cancelled):
        Job("b1", PhotoProducts(), root, PARAMS, emit, cancel).run()
    assert len(_depth(root)) > 4
    assert any("one photo at a time" in p.get("message", "") for p in seen.of("log"))
