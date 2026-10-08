"""Contours of a height (or difference) grid: minor and major lines as GeoJSON with Z (M11 G5).

A grid here is heights at cell centres, rows going north (row 0 the southernmost), ``NaN`` where
there is no data: the prepared tiles' layout (data-conventions section 26). Contours are traced by
marching squares (scikit-image ``find_contours``) between the cell centres, so a line is exact for
the bilinear surface along cell edges. A contour that stays inside the data comes back as a closed
ring (its first and last points the same); one that runs into the edge of the data stays open.

Levels are the multiples of the minor interval inside the data's range; a level is **major** when
it is also a multiple of the major interval, which must itself be a whole multiple of the minor.
The label index lists, for every major line, one anchor (the middle vertex) and the angle of the
line there, for the map to place a label.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from typing import Any

import numpy as np

from ..runtime import JobError

#: The most contour levels one overlay draws (a smaller minor interval is refused).
MAX_LEVELS = 2000
#: Points per contour line at most (longer lines are thinned evenly).
MAX_POINTS = 20000


def check_intervals(minor: float, major: float) -> None:
    if not (isinstance(minor, int | float) and math.isfinite(minor) and minor > 0):
        raise JobError("The minor contour interval must be a positive number of metres.")
    if not (isinstance(major, int | float) and math.isfinite(major) and major > 0):
        raise JobError("The major contour interval must be a positive number of metres.")
    k = major / minor
    if k < 1 - 1e-9 or abs(k - round(k)) > 1e-6:
        raise JobError(
            f"The major interval ({major:g} m) must be a whole multiple of the minor interval ({minor:g} m)."
        )


def is_major(level: float, major: float) -> bool:
    k = level / major
    return abs(k - round(k)) < 1e-6


def levels_of(lo: float, hi: float, minor: float) -> list[float]:
    k0, k1 = math.ceil(lo / minor - 1e-9), math.floor(hi / minor + 1e-9)
    n = k1 - k0 + 1
    if n > MAX_LEVELS:
        need = (hi - lo) / MAX_LEVELS
        raise JobError(
            f"A {minor:g} m interval would draw {n} contour levels here; use a minor interval of at "
            f"least {need:.2g} m."
        )
    # rounded so 0.1 steps read 101.3, not 101.30000000000001
    return [round(k * minor, 9) for k in range(k0, k1 + 1)]


def contour_lines(
    z: np.ndarray,
    origin_e: float,
    origin_n: float,
    cell: float,
    minor: float,
    major: float,
    check: Callable[[], None] = lambda: None,
) -> list[dict[str, Any]]:
    """GeoJSON ``LineString`` features (E, N, Z in the grid's CRS) of every level in the data."""
    from skimage import measure

    check_intervals(minor, major)
    ok = np.isfinite(z)
    if ok.sum() < 4:
        return []
    lo, hi = float(z[ok].min()), float(z[ok].max())
    filled = np.where(ok, z, lo - 1.0)
    feats: list[dict[str, Any]] = []
    for level in levels_of(lo, hi, minor):
        check()
        for line in measure.find_contours(filled, level, mask=ok):
            if len(line) < 2:
                continue
            closed = bool(np.allclose(line[0], line[-1], rtol=0, atol=1e-9)) and len(line) > 3
            if closed:
                line[-1] = line[0]
            if len(line) > MAX_POINTS:
                keep = np.unique(np.linspace(0, len(line) - 1, MAX_POINTS).round().astype(int))
                line = line[keep]
            es = origin_e + (line[:, 1] + 0.5) * cell
            ns = origin_n + (line[:, 0] + 0.5) * cell
            coords = [[round(float(e), 4), round(float(n), 4), level] for e, n in zip(es, ns, strict=True)]
            if closed:
                coords[-1] = list(coords[0])
            feats.append(
                {
                    "type": "Feature",
                    "properties": {"levelM": level, "major": is_major(level, major), "closed": closed},
                    "geometry": {"type": "LineString", "coordinates": coords},
                }
            )
    return feats


def label_index(features: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One label anchor per major line: the middle vertex and the line's angle there (degrees
    counter-clockwise from east, kept within -90 to 90 so labels read upright)."""
    out = []
    for i, f in enumerate(features):
        if not f["properties"]["major"]:
            continue
        c = f["geometry"]["coordinates"]
        if len(c) < 2:
            continue
        m = len(c) // 2
        a, b = c[max(0, m - 1)], c[min(len(c) - 1, m + 1)]
        ang = math.degrees(math.atan2(b[1] - a[1], b[0] - a[0]))
        if ang > 90:
            ang -= 180
        elif ang < -90:
            ang += 180
        out.append({"feature": i, "levelM": f["properties"]["levelM"], "at": c[m], "angleDeg": round(ang, 2)})
    return out


__all__ = ["MAX_LEVELS", "check_intervals", "contour_lines", "is_major", "label_index", "levels_of"]
