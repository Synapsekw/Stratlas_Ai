"""Volume rate and forecast across survey dates (intelligence review I2, study item 5.4).

The Python twin of ``packages/insights/src/trend.ts``, step for step; both reproduce
``packages/schema/src/__fixtures__/survey/trend.json`` (``python/tests/test_survey_trend.py`` and
``trend.parity.test.ts``).

- The rate is the least-squares slope, m3 per day, over the last ``TREND_WINDOW`` dates with a
  figure. It needs ``TREND_MIN_DATES`` dates on at least two days; with fewer the status is
  ``not-enough-dates``, and two dates still give the plain rate between them, never a forecast.
- The forecast is linear from the last figure: the days until it reaches 0 while it falls
  (``daysToEmpty``, ``emptyOn``) and the figure 30 days on, never below 0.
- ``lastRateZ`` scores the last rate against the earlier ones with a robust z (median and MAD);
  it needs ``TREND_MIN_EARLIER`` earlier rates and a MAD above 0.
"""

from __future__ import annotations

import math
from datetime import date as _date
from datetime import timedelta
from typing import Any, TypedDict

TREND_WINDOW = 5
TREND_MIN_DATES = 3
TREND_MIN_EARLIER = 3
_MAD_SCALE = 1.4826


class TrendPoint(TypedDict):
    capture: str
    date: str
    valueM3: float


def _day(d: str) -> int:
    return _date.fromisoformat(d[:10]).toordinal()


def _median(xs: list[float]) -> float:
    s = sorted(xs)
    mid = len(s) // 2
    return s[mid] if len(s) % 2 == 1 else (s[mid - 1] + s[mid]) / 2


def _valid(p: TrendPoint) -> bool:
    try:
        _day(p["date"])
    except ValueError:
        return False
    v = p["valueM3"]
    return isinstance(v, (int, float)) and math.isfinite(v)


def volume_trend(points: list[TrendPoint]) -> dict[str, Any]:
    """The trend of a figure over survey dates, as ``volumeTrend`` gives it (camelCase keys)."""
    pts = sorted((p for p in points if _valid(p)), key=lambda p: (p["date"][:10], p["capture"]))
    n = len(pts)
    last = pts[-1] if n >= 1 else None
    prev = pts[-2] if n >= 2 else None
    out: dict[str, Any] = {
        "status": "not-enough-dates",
        "dates": n,
        "window": 0,
        "lastCapture": last["capture"] if last else None,
        "lastDate": last["date"][:10] if last else None,
        "lastM3": last["valueM3"] if last else None,
        "lastChangeM3": None,
        "rateM3PerDay": None,
        "r2": None,
        "daysToEmpty": None,
        "emptyOn": None,
        "in30DaysM3": None,
        "lastRateZ": None,
    }
    if last is None or prev is None:
        return out

    out["lastChangeM3"] = last["valueM3"] - prev["valueM3"]
    last_days = _day(last["date"]) - _day(prev["date"])
    last_rate = out["lastChangeM3"] / last_days if last_days > 0 else None

    rates: list[float] = []
    for i in range(1, n - 1):
        a, b = pts[i - 1], pts[i]
        d = _day(b["date"]) - _day(a["date"])
        if d > 0:
            rates.append((b["valueM3"] - a["valueM3"]) / d)
    if last_rate is not None and len(rates) >= TREND_MIN_EARLIER:
        m = _median(rates)
        mad = _median([abs(r - m) for r in rates])
        if mad > 0:
            out["lastRateZ"] = (last_rate - m) / (_MAD_SCALE * mad)

    win = pts[-TREND_WINDOW:]
    day0 = _day(win[0]["date"])
    xs = [float(_day(p["date"]) - day0) for p in win]
    ys = [float(p["valueM3"]) for p in win]
    span = xs[-1] - xs[0]
    if len(win) < TREND_MIN_DATES or span <= 0:
        out["rateM3PerDay"] = last_rate if n == 2 else None
        return out
    k = len(win)
    xbar = sum(xs) / k
    ybar = sum(ys) / k
    sxx = sxy = syy = 0.0
    for x, y in zip(xs, ys, strict=True):
        dx, dy = x - xbar, y - ybar
        sxx += dx * dx
        sxy += dx * dy
        syy += dy * dy
    slope = sxy / sxx
    intercept = ybar - slope * xbar
    ss_res = 0.0
    for x, y in zip(xs, ys, strict=True):
        r = y - (intercept + slope * x)
        ss_res += r * r
    out["status"] = "ok"
    out["window"] = k
    out["rateM3PerDay"] = slope
    out["r2"] = max(0.0, 1 - ss_res / syy) if syy > 0 else 1
    out["in30DaysM3"] = max(0, last["valueM3"] + 30 * slope)
    if slope < 0 and last["valueM3"] > 0:
        days = last["valueM3"] / -slope
        out["daysToEmpty"] = days
        out["emptyOn"] = (
            _date.fromisoformat(last["date"][:10]) + timedelta(days=math.ceil(days))
        ).isoformat()
    return out
