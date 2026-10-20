"""Follow the OpenSfM sub-steps of ODM's photo alignment from the lines it prints.

ODM's ``opensfm`` stage is one long step with no progress of its own. Its console
output does name every sub-step and, for three of them, shows one line per photo or
per photo pair, so the stage can be followed without touching ODM's files. The
patterns come from ODM 3.6.2 (``opendm/osfm.py``) and a 1,003-photo run on
16 Oct 2026; the weights are that run's minutes per sub-step, rounded to a hundred.
"""

from __future__ import annotations

import bisect
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class SubStep:
    key: str
    label: str
    unit: str | None
    weight: float
    eta: bool


SUBSTEPS: tuple[SubStep, ...] = (
    SubStep("setup", "Getting the photos ready", None, 2, False),
    SubStep("features", "Finding features", "photos", 4, True),
    SubStep("matching", "Matching photos", "pairs", 25, True),
    SubStep("tracks", "Linking the matches", None, 3, False),
    # No estimate for the reconstruction: its pace is not steady (long silent
    # adjustments between bursts of photos).
    SubStep("reconstruct", "Building the 3D model", "photos placed", 52, False),
    SubStep("statistics", "Checking the model", None, 5, False),
    SubStep("geocoords", "Placing the model on the map", None, 1, False),
    SubStep("undistort", "Preparing the photos for the maps", "photos", 8, True),
)

_INDEX = {step.key: i for i, step in enumerate(SUBSTEPS)}

_STAGE_START = re.compile(r"Running opensfm stage")
_RUNNING = re.compile(
    r'running\s+"[^"]*"\s+(detect_features|match_features|create_tracks|reconstruct|export_geocoords)\b'
)
_RUNNING_KEY = {
    "detect_features": "features",
    "match_features": "matching",
    "create_tracks": "tracks",
    "reconstruct": "reconstruct",
    "export_geocoords": "geocoords",
}
_STATS_START = re.compile(r"Export reconstruction stats")
_UNDISTORT_START = re.compile(r"Undistorting .+ \.\.\.")
_ALREADY_DONE = (
    (re.compile(r"already exists, not rerunning OpenSfM setup"), "setup"),
    (re.compile(r"Detect features already done"), "features"),
    (re.compile(r"Match features already done"), "matching"),
    (re.compile(r"Found a valid OpenSfM tracks file"), "tracks"),
    (re.compile(r"Found a valid OpenSfM reconstruction file"), "reconstruct"),
    (re.compile(r"Found existing reconstruction stats"), "statistics"),
    (re.compile(r"Already undistorted"), "undistort"),
)
_FEATURE = re.compile(r"Extracting \S+ features for image (\S+)")
_PAIRS_TOTAL = re.compile(r"INFO: Matching (\d+) image pairs")
_PAIR = re.compile(r"DEBUG: Matching \S+ and \S+\.\s+Matcher:")
_SEED = re.compile(r"Starting reconstruction with (\S+) and (\S+)")
_ADDED = re.compile(r"Adding (\S+) to the reconstruction")

# Estimate gates: how long, how much growth and how steady before a time is shown.
_ETA_MIN_SECONDS = 60.0
_ETA_MIN_GROWTH = 20
_ETA_MIN_GROWTH_SHARE = 0.05
_ETA_RECENT_WINDOW_S = 60.0
_ETA_RECENT_MIN_SPAN_S = 20.0
_ETA_STEADY_LOW = 0.75
_ETA_STEADY_HIGH = 1.33
# A missing image list is looked for again at most this often (it is asked for on every line).
_COUNT_RETRY_S = 1.0
# Samples older than the recent window are dropped once this many have gathered.
_TRIM_BATCH = 256


def _time(sample: tuple[float, int]) -> float:
    return sample[0]


def photo_count(project_dir: Path) -> int | None:
    """Photos OpenSfM was set up with: the non-empty lines of its image list."""
    try:
        text = (project_dir / "opensfm" / "image_list.txt").read_text(encoding="utf-8")
    except OSError:
        return None
    return sum(1 for line in text.splitlines() if line.strip())


class SfmProgress:
    def __init__(
        self,
        photo_count: Callable[[], int | None],
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._photo_count = photo_count
        self._clock = clock
        self._photos_total: int | None = None
        self._count_tried_at: float | None = None
        self._index: int | None = None  # index of the current sub-step
        self._finished = False
        self._floor = 0.0
        self._names: set[str] = set()  # distinct photos seen in the current sub-step
        self._count = 0  # pairs or undistorted files in the current sub-step
        self._pairs_total: int | None = None
        self._samples: list[tuple[float, int]] = []
        self.step_started_at: float | None = None

    @property
    def current(self) -> str | None:
        if self._finished or self._index is None or self._index >= len(SUBSTEPS):
            return None
        return SUBSTEPS[self._index].key

    def _enter(self, index: int) -> None:
        """Start a sub-step: every earlier one is complete and its count restarts."""
        self._index = index
        self._names = set()
        self._count = 0
        self._pairs_total = None
        self._samples = []
        self.step_started_at = self._clock() if index < len(SUBSTEPS) else None

    def _skip_to(self, key: str) -> None:
        """A sub-step that was already done: the next one is the first that runs."""
        target = _INDEX[key] + 1
        if self._index is None or target > self._index:
            self._enter(target)

    def _done(self) -> int:
        return len(self._names) if self.current in ("features", "reconstruct") else self._count

    def _record(self) -> None:
        now = self._clock()
        self._samples.append((now, self._done()))
        # only the first sample (the overall rate) and the last window (the recent rate) are used:
        # the list stays bounded however many pairs are matched (trimmed in batches: cheap per line)
        cut = bisect.bisect_left(self._samples, now - _ETA_RECENT_WINDOW_S, lo=1, key=_time)
        if cut > _TRIM_BATCH:
            del self._samples[1:cut]

    def feed(self, line: str) -> bool:
        line = line.strip()
        if _STAGE_START.search(line):
            self._enter(0)
            return True
        match = _RUNNING.search(line)
        if match:
            self._enter(_INDEX[_RUNNING_KEY[match.group(1)]])
            return True
        if _STATS_START.search(line):
            self._enter(_INDEX["statistics"])
            return True
        if _UNDISTORT_START.search(line):
            self._enter(_INDEX["undistort"])
            return True
        for pattern, key in _ALREADY_DONE:
            if pattern.search(line):
                self._skip_to(key)
                return True
        current = self.current
        if current == "features":
            found = _FEATURE.search(line)
            if found and found.group(1) not in self._names:
                self._names.add(found.group(1))
                self._record()
                return True
        elif current == "matching":
            found = _PAIRS_TOTAL.search(line)
            if found:
                self._pairs_total = int(found.group(1))
                return True
            if _PAIR.search(line):
                self._count += 1
                self._record()
                return True
        elif current == "reconstruct":
            seed = _SEED.search(line)
            added = _ADDED.search(line)
            fresh = {name for name in (seed.groups() if seed else ()) if name not in self._names}
            if added and added.group(1) not in self._names:
                fresh.add(added.group(1))
            if fresh:
                self._names |= fresh
                self._record()
                return True
        return False

    def set_undistorted(self, n: int) -> bool:
        if self.current != "undistort" or n <= self._count:
            return False
        self._count = n
        self._record()
        return True

    def _total(self) -> int | None:
        step = self.current
        if step is None:
            return None
        if step == "matching":
            return self._pairs_total
        if SUBSTEPS[_INDEX[step]].unit is None:
            return None
        now = self._clock()
        if self._photos_total is None and (
            self._count_tried_at is None or now - self._count_tried_at >= _COUNT_RETRY_S
        ):
            self._count_tried_at = now
            self._photos_total = self._photo_count()
        return self._photos_total

    def fraction(self) -> float:
        if self._finished:
            return 1.0
        if self._index is None:
            return self._floor
        done_weight = sum(step.weight for step in SUBSTEPS[: self._index])
        step = self.current
        within = 0.0
        if step is not None and SUBSTEPS[_INDEX[step]].unit is not None:
            total = self._total()
            if total:
                within = min(self._done() / total, 0.99)
            done_weight += SUBSTEPS[_INDEX[step]].weight * within
        self._floor = max(self._floor, done_weight / 100)
        return self._floor

    def detail(self) -> dict[str, Any] | None:
        step = self.current
        if step is None:
            return None
        sub = SUBSTEPS[_INDEX[step]]
        info: dict[str, Any] = {"label": sub.label}
        if sub.unit is not None:
            info["done"] = self._done()
            total = self._total()
            if total is not None:
                info["total"] = total
            info["unit"] = sub.unit
        return info

    def eta_seconds(self) -> float | None:
        step = self.current
        if step is None or not SUBSTEPS[_INDEX[step]].eta or not self._samples:
            return None
        total = self._total()
        done = self._done()
        if not total or done >= total:
            return None
        first_t, first_done = self._samples[0]
        last_t, last_done = self._samples[-1]
        now = self._clock()
        if now - first_t < _ETA_MIN_SECONDS:
            return None
        if last_done - first_done < max(_ETA_MIN_GROWTH, _ETA_MIN_GROWTH_SHARE * total):
            return None
        if last_t <= first_t:
            return None
        rate_all = (last_done - first_done) / (last_t - first_t)
        i = bisect.bisect_left(self._samples, now - _ETA_RECENT_WINDOW_S, key=_time)
        if len(self._samples) - i < 2:
            return None
        (t0, done0), (t1, done1) = self._samples[i], self._samples[-1]
        if t1 - t0 < _ETA_RECENT_MIN_SPAN_S:
            return None
        rate_recent = (done1 - done0) / (t1 - t0)
        if rate_all <= 0 or not _ETA_STEADY_LOW <= rate_recent / rate_all <= _ETA_STEADY_HIGH:
            return None
        return float(round((total - done) / rate_all))

    def finish(self) -> None:
        self._finished = True
        self._floor = 1.0
