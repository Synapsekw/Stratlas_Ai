"""The budgeted, parallel merge of the fused tiles (``photo.products`` step ``fuse``).

``merge_cloud`` runs ``PointTiles.merge``'s two passes in worker processes (``pool``) when there
are several tiles and the memory for them: as many as fit 80 % of the memory budget at the
largest tile's chunk bytes. A worker that stops makes the pass finish here. When the cloud ends
above 1.2 x its point budget it is merged again, wider, from the chunks (at most three times;
past that it is kept with a warning), and the merge is marked complete only then.
"""

from __future__ import annotations

import functools
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import numpy as np

from . import pool
from .budget import needs_remerge, remerge_voxel
from .fuse import DENSE_RULE, MergeRule, PointTiles, filter_tile, merge_tile

#: Merges again, wider, at most this often. Widening the voxel also loosens the seen-twice count
#: filter (more voxels hold two points), so one step can land above the budget again.
MAX_REMERGES = 3


@functools.lru_cache(maxsize=8)
def _polygon(wkt: str):
    import shapely

    geom = shapely.from_wkt(wkt)
    shapely.prepare(geom)
    return geom


@dataclass(frozen=True)
class RegionClip:
    """The processing region as a test for model points that worker processes can be sent: the
    polygon's WKT in the project CRS and the model-to-project shift (``dx``, ``dy``)."""

    wkt: str
    dx: float
    dy: float

    def __call__(self, xyz: np.ndarray) -> np.ndarray:
        import shapely

        return shapely.contains_xy(_polygon(self.wkt), xyz[:, 0] + self.dx, xyz[:, 1] + self.dy)


def _chunk_bytes(store: PointTiles, name: str) -> int:
    return sum(p.stat().st_size for p in (store.chunks_dir / name).glob("*.npz"))


#: The share of the progress bar the first attempt takes; each re-merge takes this share of what
#: is left, so the bar never steps back however many attempts it takes.
FIRST_SHARE = 0.8


def _here(store, kind: str, todo: list[str], v: float, r: MergeRule, k, check, got) -> None:
    for name in todo:
        check()
        got(name, merge_tile(store, name, v, r, k) if kind == "merge" else filter_tile(store, name, v, r))


def _merge_once(store, voxel, rule, keep, memory, check, progress, log, state) -> tuple[dict, int]:
    """One merge at ``voxel``. ``state["broken"]`` is set once a pool breaks: every pass after
    that, in this attempt and the next, runs here."""
    names = store.chunk_tiles()
    largest = max((_chunk_bytes(store, n) for n in names), default=0)
    workers = 1 if state["broken"] else pool.plan_merge_workers(len(names), largest, memory)
    if workers <= 1:
        return store.merge(voxel, keep, check, progress, rule), 1
    log(f"Merging {len(names)} tiles, {workers} at a time.")

    def run_tiles(kind: str, todo: list[str], v: float, r: MergeRule, k, done) -> None:
        if state["broken"]:
            _here(store, kind, todo, v, r, k, check, done)
            return
        finished: set[str] = set()

        def got(name: str, res: dict) -> None:
            finished.add(name)
            done(name, res)

        task = pool.merge_task if kind == "merge" else pool.filter_task
        args = (str(store.root), str(store.chunks_dir), store.tile, v, r, k, pool.worker_threads(workers))
        try:
            pool.run_pool(workers, pool.init_merge, args, task, todo, check, got)
        except pool.PoolBroken:
            state["broken"] = True
            log("A worker process stopped; merging the rest here.", "warn")
            _here(store, kind, [n for n in todo if n not in finished], v, r, k, check, got)

    return store.merge(voxel, keep, check, progress, rule, run_tiles), workers


def merge_cloud(
    store: PointTiles,
    voxel: float,
    *,
    rule: MergeRule = DENSE_RULE,
    keep: Callable[[np.ndarray], np.ndarray] | None = None,
    budget: int = 0,
    memory: int,
    check: Callable[[], None] = lambda: None,
    progress: Callable[[float, str | None], None] = lambda f, m=None: None,
    log: Callable[..., None] = lambda message, level="info": None,
) -> dict[str, Any]:
    """Merge the tiles at ``voxel`` (or at the spacing a stopped merge was at), in parallel when
    it fits ``memory``, again wider when the cloud ends above 1.2 x ``budget``; then mark it
    complete. Answers the index plus ``workers`` and ``remerged`` (the re-merges of the whole
    merge, across resumes; also kept in the index). A complete merge is answered as it is
    (``workers`` 0). Raises ``fuse.ChunksDropped`` when the chunks it needs were deleted after an
    earlier merge (the photos must be fused again)."""
    done = store.info()
    if done.get("complete"):
        return {**done, "workers": 0, "remerged": int(done.get("remerged", 0))}
    v = store.merging_voxel() or voxel
    remerged = int(store.merge_state().get("remerged", 0))
    state = {"broken": False}
    last: list = [None]

    def share(k: int) -> Callable[[float, str | None], None]:
        lo = 1 - (1 - FIRST_SHARE) ** k
        hi = 1 - (1 - FIRST_SHARE) ** (k + 1)

        def report(f: float, m: str | None = None) -> None:
            last[0] = m
            progress(lo + (hi - lo) * f, m)

        return report

    while True:
        info, workers = _merge_once(store, v, rule, keep, memory, check, share(remerged), log, state)
        if not needs_remerge(info["points"], budget):
            break
        if remerged >= MAX_REMERGES:
            log(
                f"The cloud still has {info['points']:,} points after {remerged} wider merges, more "
                f"than 1.2 x its budget of {budget:,}; keeping it at {v * 100:.1f} cm.",
                "warn",
            )
            break
        v = remerge_voxel(v, info["points"], budget)
        remerged += 1
        log(
            f"The cloud has {info['points']:,} points, more than its budget of {budget:,}; "
            f"merging again at {v * 100:.1f} cm."
        )
        store.begin_merge(v, remerged=remerged)
    progress(1.0, last[0])
    return {**store.finish_merge(remerged=remerged), "workers": workers, "remerged": remerged}
