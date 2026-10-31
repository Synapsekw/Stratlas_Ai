"""Hot spots in a temperature raster (thermal plan task 3.3; vision audit 3.14).

``find_hotspots`` takes one photo's °C raster (float32, NaN where unknown) and returns the regions
that stand out:

- rule ``delta``: pixels at least ``threshold_c`` above the local background (the 75th percentile
  of a wide window, worked out on a 4x smaller grid, so a hot object filling a fifth of the frame
  and a cold sky edge do not move it);
- rule ``absolute``: pixels at or above ``threshold_c``.

Regions closer than ``merge_px`` are one hot spot. Each region needs ``min_area_px`` known pixels,
so a sun glint of a pixel or two is dropped. Its reference is the median of a ring ``ring_px`` wide
around its box, without any region's pixels, NaN, or pixels as cold as the coldest tenth of the
photo and well below its median (sky). ΔT is the peak minus the reference; under the ``delta``
rule a region whose ΔT falls short of the threshold is dropped. At most ``max_per_photo`` regions
are kept, highest ΔT first.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import numpy as np

DOWN = 4  # background grid cell, in pixels
BG_WINDOW = 31  # background window, in cells
BG_PERCENTILE = 75
COLD_PERCENTILE = 10
MAX_REGIONS = 200  # regions looked at per photo, hottest first


@dataclass(frozen=True)
class Candidate:
    box: tuple[int, int, int, int]  # x, y, w, h in raster pixels
    peak_c: float
    mean_c: float
    peak_at: tuple[int, int]  # x, y
    reference_c: float
    delta_c: float


def _background(c: np.ndarray, fill: float) -> np.ndarray:
    from scipy import ndimage

    h, w = c.shape
    ph, pw = -h % DOWN, -w % DOWN
    a = np.pad(np.where(np.isfinite(c), c, fill), ((0, ph), (0, pw)), mode="edge")
    small = a.reshape(a.shape[0] // DOWN, DOWN, a.shape[1] // DOWN, DOWN).mean(axis=(1, 3))
    bg = ndimage.percentile_filter(small, BG_PERCENTILE, size=BG_WINDOW, mode="nearest")
    return np.repeat(np.repeat(bg, DOWN, axis=0), DOWN, axis=1)[:h, :w]


def find_hotspots(
    c: np.ndarray,
    rule: Literal["absolute", "delta"],
    threshold_c: float,
    min_area_px: int = 4,
    ring_px: int = 8,
    merge_px: int = 6,
    max_per_photo: int = 20,
) -> list[Candidate]:
    from scipy import ndimage

    c = np.asarray(c, dtype=np.float64)
    finite = np.isfinite(c)
    if not finite.any():
        return []
    median = float(np.median(c[finite]))
    cold = float(np.percentile(c[finite], COLD_PERCENTILE))
    with np.errstate(invalid="ignore"):
        if rule == "absolute":
            mask = finite & (c >= threshold_c)
        else:
            mask = finite & (c - _background(c, median) >= threshold_c)
    if not mask.any():
        return []
    square = np.ones((3, 3), bool)
    iterations = max(1, merge_px // 2)
    h, w = c.shape

    def reference_of(region: np.ndarray, taken: np.ndarray) -> float:
        ys, xs = np.nonzero(region)
        ry0, ry1 = max(0, int(ys.min()) - ring_px), min(h, int(ys.max()) + 1 + ring_px)
        rx0, rx1 = max(0, int(xs.min()) - ring_px), min(w, int(xs.max()) + 1 + ring_px)
        ring = c[ry0:ry1, rx0:rx1][~taken[ry0:ry1, rx0:rx1] & finite[ry0:ry1, rx0:rx1]]
        if rule == "delta":  # sky: as cold as the coldest tenth and well under the photo's median
            warm = ring[~((ring <= cold) & (ring < median - max(threshold_c, 1.0)))]
            if len(warm):
                ring = warm
        return float(np.median(ring)) if len(ring) else median

    def groups(m: np.ndarray) -> tuple[list[np.ndarray], np.ndarray]:
        """Regions of ``m`` with those closer than ``merge_px`` joined, and the joined mask."""
        joined = ndimage.binary_dilation(m, square, iterations=iterations)
        labels, n = ndimage.label(joined, square)
        if n == 0:
            return [], joined
        ids = np.arange(1, n + 1)
        ids = ids[np.asarray(ndimage.sum(m, labels, ids)) >= min_area_px]
        if len(ids) > MAX_REGIONS:  # a noisy photo: only the hottest are worth a look
            peaks = np.asarray(ndimage.maximum(np.where(m, c, -np.inf), labels, ids))
            ids = ids[np.argsort(-peaks)[:MAX_REGIONS]]
        return [(labels == k) & m for k in ids], joined

    seeds, joined = groups(mask)
    if rule == "delta":
        # a seed grows into everything around it at least the threshold above its own surroundings,
        # so a hot object larger than the background window is one region, not its rim
        grown = np.zeros_like(mask)
        for s in seeds:
            hot = finite & (c >= reference_of(s, joined) + threshold_c)
            labels, _ = ndimage.label(hot | s, square)
            grown |= np.isin(labels, np.unique(labels[s]))
        regions, joined = groups(grown)
    else:
        regions = seeds
    out: list[Candidate] = []
    for region in regions:
        if int(region.sum()) < min_area_px:
            continue
        ys, xs = np.nonzero(region)
        y0, x0, y1, x1 = int(ys.min()), int(xs.min()), int(ys.max()) + 1, int(xs.max()) + 1
        vals = c[region]
        i = int(np.argmax(vals))
        peak = float(vals[i])
        peak_at = (int(xs[i]), int(ys[i]))
        reference = reference_of(region, joined)
        delta = peak - reference
        if rule == "delta" and delta < threshold_c:
            continue
        out.append(
            Candidate(
                box=(x0, y0, x1 - x0, y1 - y0),
                peak_c=round(peak, 2),
                mean_c=round(float(vals.mean()), 2),
                peak_at=peak_at,
                reference_c=round(reference, 2),
                delta_c=round(delta, 2),
            )
        )
    out.sort(key=lambda h: -h.delta_c)
    return out[:max_per_photo]
