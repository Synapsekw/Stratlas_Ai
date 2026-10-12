"""Which frames of a walk become stills, and the sinks that save them (walk.process, step ``frames``).

- **SfM stills** (decision 8): ``per_s`` a second over the whole video; inside a standing stretch
  only the first and the last are kept (a still camera adds no baseline, only matching time).
  Saved at half the output size (at least 1024 px wide when the output is wider), JPEG, named
  ``still_000000.jpg`` in walk order so COLMAP's sequential matching sees them in order.
- **Map stills**: a subset of the SfM stills, about one metre apart by step count (``stride_m``
  per step), never closer than one second; without motion data one a second. Saved at full size
  (the output is at most 3840 x 1920), JPEG quality 88.

A still's number ``n`` is its output frame index: ``t = n / fps``. ``raw-path.json`` lists the
stills by ``n`` and ``stills/<n>.jpg`` (``n`` zero-padded to 5 digits) holds the kept ones.
"""

from __future__ import annotations

import bisect
import math
from collections.abc import Callable, Sequence
from pathlib import Path

import numpy as np

from ..runtime import atomic_write_bytes

MAP_SPACING_M = 1.0  # map stills about this far apart by step count
MAP_MIN_GAP_S = 1.0  # and never more than one per second
SFM_MIN_WIDTH = 1024  # SfM stills are half size, but not narrower than this (when the output is wider)
SFM_QUALITY = 92
MAP_QUALITY = 88


def pick_sfm_times(duration: float, per_s: float, standing: Sequence[tuple[float, float]]) -> list[float]:
    """Still times (s) every ``1 / per_s`` from 0 to before ``duration``; inside each standing
    stretch ``(from, to)`` only the first and the last still are kept."""
    if duration <= 0 or per_s <= 0:
        return []
    step = 1.0 / per_s
    n = max(1, math.ceil(duration / step - 1e-9))
    times = [k * step for k in range(n)]
    drop: set[int] = set()
    for a, b in standing:
        inside = [k for k, t in enumerate(times) if a <= t <= b]
        drop.update(inside[1:-1])
    return [t for k, t in enumerate(times) if k not in drop]


def steps_counter(step_times: Sequence[float]) -> Callable[[float], float]:
    """Cumulative step count at time t (steps at or before t)."""
    ts = sorted(float(s) for s in step_times)
    return lambda t: float(bisect.bisect_right(ts, t))


def pick_map_stills(
    times: Sequence[float],
    steps_at: Callable[[float], float] | None,
    stride_m: float,
    spacing_m: float = MAP_SPACING_M,
    min_gap_s: float = MAP_MIN_GAP_S,
) -> list[int]:
    """Indices into ``times`` (sorted) of the map stills: the first, then each later one at least
    ``spacing_m`` further by step count (``stride_m`` per step) and ``min_gap_s`` later than the
    last kept. Without ``steps_at`` (no motion data) only the time gap counts."""
    out: list[int] = []
    last_t = -math.inf
    last_steps = 0.0
    for i, t in enumerate(times):
        if out and t - last_t < min_gap_s - 1e-6:
            continue
        s = steps_at(t) if steps_at is not None else 0.0
        if out and steps_at is not None and (s - last_steps) * stride_m < spacing_m - 1e-9:
            continue
        out.append(i)
        last_t, last_steps = t, s
    return out


def sfm_size(width: int, height: int) -> tuple[int, int]:
    """The SfM still size for a ``width`` x ``height`` output (2:1): half, at least 1024 wide."""
    w = max(width // 2, min(width, SFM_MIN_WIDTH))
    w -= w % 2
    return w, max(1, round(w * height / width))


def write_jpeg(path: Path, bgr: np.ndarray, quality: int) -> None:
    """A JPEG through ``imencode`` (``imwrite`` refuses non-ASCII paths on Windows), written atomically."""
    import cv2  # on use: importing the pipelines must not load OpenCV

    ok, buf = cv2.imencode(".jpg", bgr, [cv2.IMWRITE_JPEG_QUALITY, int(quality)])
    if not ok:
        raise OSError(f"could not encode {path.name}")
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_bytes(path, buf.tobytes())


def still_name(k: int) -> str:
    """The SfM still file of the k-th still in walk order."""
    return f"still_{k:06d}.jpg"


def map_name(n: int) -> str:
    """The map still file of frame n (under ``stills/``)."""
    return f"{n:05d}.jpg"


class StillSaver:
    """A ``FrameSink`` callback that saves the frames whose index is in ``names`` (frame index to
    file name) into ``folder``, resized to ``size`` when given."""

    def __init__(
        self, folder: Path, names: dict[int, str], quality: int, size: tuple[int, int] | None = None
    ):
        self.folder = Path(folder)
        self.names = names
        self.quality = quality
        self.size = size
        self.saved: dict[int, str] = {}

    def __call__(self, i: int, t: float, bgr: np.ndarray) -> None:
        import cv2  # on use: importing the pipelines must not load OpenCV

        name = self.names.get(i)
        if name is None:
            return
        img = bgr
        if self.size is not None and (bgr.shape[1], bgr.shape[0]) != self.size:
            img = cv2.resize(bgr, self.size, interpolation=cv2.INTER_AREA)
        write_jpeg(self.folder / name, img, self.quality)
        self.saved[i] = name
