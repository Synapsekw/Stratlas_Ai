"""An activity meter for an ODM run: when did it last show a sign of life?

ODM goes quiet for minutes while it works (matching, reconstruction), so log lines alone would
raise false alarms. Besides lines and counts (``touch``), ``poll`` folds in the CPU time of the
process tree over a short window and new files in the project's work folders.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

from .. import proctree

BUSY_EVERY_S = 5.0
BUSY_NOW_SHARE = 0.25  # share of one core over the last sample that counts as busy now
# Relative to the ODM project folder; a folder's mtime changes when a file is created in it.
WATCH_DIRS = (
    "",
    "opensfm",
    "opensfm/features",
    "opensfm/matches",
    "opensfm/undistorted",
    "opensfm/undistorted/images",
)


def _stat_mtime(path: Path) -> float | None:
    try:
        return path.stat().st_mtime
    except OSError:
        return None


def iso_at(t: float) -> str:
    """UTC ISO time with milliseconds and a ``Z``, e.g. ``2026-10-16T16:46:13.380Z``."""
    return datetime.fromtimestamp(t, UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


class Liveness:
    def __init__(
        self,
        work_dir: Path,
        *,
        clock: Callable[[], float] = time.time,
        cpu: Callable[[int], float] | None = None,
        mtime: Callable[[Path], float | None] | None = None,
        every: float = BUSY_EVERY_S,
    ) -> None:
        self.work_dir = work_dir
        self.clock = clock
        self.cpu = cpu or proctree.TreeCpu().sample
        self.mtime = mtime or _stat_mtime
        self.every = every
        self.last_at = clock()
        self._sampled_at: float | None = None
        self._used = 0.0
        self._seen: dict[str, float] = {}

    def touch(self, at: float | None = None) -> None:
        """A line or a count arrived (at ``at``, default now); ``last_at`` never moves back."""
        self.last_at = max(self.last_at, self.clock() if at is None else at)

    def poll(self, pid: int) -> None:
        now = self.clock()
        if self._sampled_at is not None and now - self._sampled_at < self.every:
            return
        used = self.cpu(pid)
        busy = False
        if self._sampled_at is not None:  # the first sample is only a baseline
            busy = used - self._used >= BUSY_NOW_SHARE * (now - self._sampled_at)
        for rel in WATCH_DIRS:
            m = self.mtime(self.work_dir / rel if rel else self.work_dir)
            if m is None:
                continue
            before = self._seen.get(rel)
            self._seen[rel] = m
            if before is not None and m > before:
                busy = True
        self._sampled_at, self._used = now, used
        if busy:
            self.touch(now)
