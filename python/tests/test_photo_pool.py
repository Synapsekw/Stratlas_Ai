"""photo/pool.py: how many workers, and the pool that runs the per-photo stages."""

from __future__ import annotations

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
