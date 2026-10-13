"""photo/merge.py and the merge workers of photo/pool.py: the budgeted, parallel merge."""

from __future__ import annotations

import pickle

import numpy as np
import pytest
from shapely.geometry import box

from aio_pipelines.photo import pool as P
from aio_pipelines.photo.fuse import DENSE_RULE, OUTLIER_BLOCK, PointTiles, outlier_mask
from aio_pipelines.photo.merge import MAX_REMERGES, RegionClip, merge_cloud
from aio_pipelines.runtime import JobError

GB = 1024**3
MB = 1024**2


def _store(root, chunks, seed: int = 3, n: int = 40_000) -> PointTiles:
    """``n`` points over four 8 m tiles, as two photos' chunks per tile."""
    rng = np.random.default_rng(seed)
    xyz = np.column_stack([rng.uniform(0, 16, n), rng.uniform(0, 16, n), rng.normal(0, 0.01, n)])
    rgb = rng.integers(0, 256, (n, 3)).astype(np.uint8)
    store = PointTiles(root, 8.0, chunks=chunks)
    for k in range(2):
        store.add(f"v{k}", xyz[k::2], rgb[k::2], np.tile(np.float32([0, 0, 1]), (len(xyz[k::2]), 1)))
    return store


def _same(a: PointTiles, b: PointTiles) -> None:
    fa, fb = list(a.fused()), list(b.fused())
    assert [n for n, _ in fa] == [n for n, _ in fb] and fa
    for (_, pa), (_, pb) in zip(fa, fb, strict=True):
        for k in pa:
            np.testing.assert_array_equal(pa[k], pb[k])


@pytest.mark.parametrize(
    "tiles, largest, budget, cores, want",
    [
        (1, 100 * MB, 48 * GB, 24, 1),
        (16, 100 * MB, 48 * GB, 24, 8),  # the ceiling
        (16, 2 * GB, 16 * GB, 24, 1),  # one tile at a time fits the memory
        (16, 100 * MB, 48 * GB, 4, 2),  # half the cores
        (3, 100 * MB, 48 * GB, 24, 3),  # never more workers than tiles
    ],
)
def test_plan_merge_workers(monkeypatch, tiles, largest, budget, cores, want):
    monkeypatch.delenv(P.WORKERS_ENV, raising=False)
    assert P.plan_merge_workers(tiles, largest, budget, cores) == want


def test_the_worker_sizing_holds_the_outlier_filters_working_memory(monkeypatch):
    monkeypatch.delenv(P.WORKERS_ENV, raising=False)
    # the KD-tree query's distances (float64) and indices (int64) for one block of points
    assert OUTLIER_BLOCK * (DENSE_RULE.k + 1) * 16 <= P.MERGE_FILTER_BYTES
    # 80 % of 5 GB holds four 100 MB tiles at 10 bytes per chunk byte, three with the filter's share
    assert P.plan_merge_workers(16, 100 * MB, 5 * GB, 64) == 3


def test_the_outlier_filter_in_blocks_matches_one_query(monkeypatch):
    rng = np.random.default_rng(5)
    pts = rng.uniform(0, 4, (5000, 3)) * [1, 1, 0.05]
    pts[::97, 2] += rng.uniform(0.5, 2, len(pts[::97]))  # some floating points
    margin = rng.uniform(-0.1, 0, (300, 3))
    whole = outlier_mask(pts, margin, block=len(pts))
    assert 0 < (~whole).sum() < len(pts)
    np.testing.assert_array_equal(outlier_mask(pts, margin, block=777), whole)
    np.testing.assert_array_equal(outlier_mask(pts, margin), whole)


def test_two_workers_merge_the_tiles_of_one(tmp_path, monkeypatch):
    one, two = _store(tmp_path / "one", tmp_path / "c1"), _store(tmp_path / "two", tmp_path / "c2")
    monkeypatch.setenv(P.WORKERS_ENV, "1")
    a = merge_cloud(one, 0.1, memory=GB)
    monkeypatch.setenv(P.WORKERS_ENV, "2")
    b = merge_cloud(two, 0.1, memory=GB)
    assert (a["workers"], b["workers"]) == (1, 2) and a["points"] == b["points"] > 0
    assert a["complete"] is True and b["complete"] is True
    _same(one, two)


def test_a_region_clips_the_tiles_in_the_workers_too(tmp_path, monkeypatch):
    clip = RegionClip(box(0, 0, 10, 10).wkt, 0.0, 0.0)
    assert pickle.loads(pickle.dumps(clip)) == clip
    one, two = _store(tmp_path / "one", tmp_path / "c1"), _store(tmp_path / "two", tmp_path / "c2")
    monkeypatch.setenv(P.WORKERS_ENV, "1")
    merge_cloud(one, 0.1, keep=clip, memory=GB)
    monkeypatch.setenv(P.WORKERS_ENV, "2")
    merge_cloud(two, 0.1, keep=clip, memory=GB)
    _same(one, two)
    xyz = np.concatenate([p["xyz"] for _, p in two.fused()])
    assert xyz[:, 0].max() < 10.05 and xyz[:, 1].max() < 10.05


def test_a_region_clip_shifts_model_points_to_the_project(tmp_path):
    clip = RegionClip(box(100, 200, 110, 210).wkt, 100.0, 200.0)
    xyz = np.array([[5.0, 5.0, 0.0], [15.0, 5.0, 0.0], [-1.0, 5.0, 0.0]])
    assert clip(xyz).tolist() == [True, False, False]


def test_a_broken_pool_merges_the_rest_here(tmp_path, monkeypatch):
    monkeypatch.setenv(P.WORKERS_ENV, "2")

    def broken(*a, **k):
        raise P.PoolBroken("a worker stopped")

    monkeypatch.setattr(P, "run_pool", broken)
    logs: list[str] = []
    store = _store(tmp_path / "m", tmp_path / "c")
    info = merge_cloud(store, 0.1, memory=GB, log=lambda m, level="info": logs.append(m))
    assert info["points"] > 0 and info["complete"] is True
    assert any("merging the rest here" in m for m in logs)


def test_a_cloud_over_its_budget_is_merged_again_wider(tmp_path, monkeypatch):
    monkeypatch.setenv(P.WORKERS_ENV, "1")
    store = _store(tmp_path / "m", tmp_path / "c", n=200_000)
    logs: list[tuple[str, str]] = []
    info = merge_cloud(
        store, 0.1, budget=4000, memory=GB, log=lambda m, level="info": logs.append((m, level))
    )
    assert info["remerged"] >= 1 and info["voxel"] > 0.1
    assert info["points"] <= 1.2 * 4000
    assert store.merging_voxel() == info["voxel"] and info["complete"] is True
    assert sum("merging again" in m for m, _ in logs) == info["remerged"]


def test_a_cloud_still_over_its_budget_after_the_last_remerge_is_kept_with_a_warning(tmp_path, monkeypatch):
    monkeypatch.setenv(P.WORKERS_ENV, "1")
    monkeypatch.setattr("aio_pipelines.photo.merge.remerge_voxel", lambda v, points, budget: v * 1.01)
    store = _store(tmp_path / "m", tmp_path / "c")
    logs: list[tuple[str, str]] = []
    info = merge_cloud(store, 0.1, budget=100, memory=GB, log=lambda m, level="info": logs.append((m, level)))
    assert info["remerged"] == MAX_REMERGES == 3 and info["complete"] is True and info["points"] > 120
    assert logs[-1][1] == "warn" and "budget" in logs[-1][0]


def test_a_merge_stopped_midway_carries_on_at_its_spacing(tmp_path, monkeypatch):
    monkeypatch.setenv(P.WORKERS_ENV, "1")
    store = _store(tmp_path / "m", tmp_path / "c")
    store.begin_merge(0.2)  # a re-merge was under way when the job stopped
    assert merge_cloud(store, 0.1, memory=GB)["voxel"] == 0.2


def test_a_finished_merge_whose_chunks_are_gone_is_kept_not_emptied(tmp_path, monkeypatch):
    monkeypatch.setenv(P.WORKERS_ENV, "1")
    store = _store(tmp_path / "m", tmp_path / "c")
    first = merge_cloud(store, 0.1, memory=GB)
    assert store.drop_chunks() > 0
    again = merge_cloud(store, 0.1, memory=GB)
    assert again["points"] == first["points"] > 0 and again["complete"] is True
    assert store.merge(0.1)["points"] == first["points"] and store.info()["complete"] is True
    with pytest.raises(JobError, match="start the processing again"):
        store.merge(0.2)
    assert store.info()["points"] == first["points"] and store.merging_voxel() == 0.1


def test_merge_progress_counts_the_tiles(tmp_path, monkeypatch):
    monkeypatch.setenv(P.WORKERS_ENV, "2")
    seen: list = []
    merge_cloud(
        _store(tmp_path / "m", tmp_path / "c"), 0.1, memory=GB, progress=lambda f, m=None: seen.append(m)
    )
    assert "Merging tile 4 of 4" in seen and seen[-1] == "Cleaning tile 4 of 4"
