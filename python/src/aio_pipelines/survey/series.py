"""Volume per survey date and the spread across bases (volumetric parity W3 and W4).

**Per date** (``compare_series``): one comparison item run once per capture, with that capture as
``current`` and, as ``previous``, the capture with a prepared surface before it (the resolver's
rules, ``ProjectSurfaces(project, capture)``). A fixed side (a survey with a capture, a design, a
base) stays fixed. The ``current`` side's capture is always the date, also when the date is refused
before its surface is resolved. Results come back in the order of the captures. Only items with a
``current`` side are run as a series (``series_applies``).

**Spread across bases** (``base_spread``): for an item whose ``from`` is a base, the item run with each
of ``SPREAD_BASES`` in its place; over the ok or partial results,
``pct = (max(totalM3) - min(totalM3)) / 2 / mean(totalM3) * 100``. ``None`` when ``from`` is not a
base, fewer than two bases give a result, or the mean is 0 (below ``MEAN_ZERO_M3``).

The TypeScript executor (``@aio/survey`` ``engine/series.ts``) does the same; the shared fixtures
(``series.json``) hold the two together (ADR 0009).
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any

from .compare import ZERO, LineUp, Resolve, compare_item, is_surface

#: The bases the spread is taken over: smart, best-fit plane, mean perimeter level, lowest perimeter.
SPREAD_BASES: tuple[dict[str, Any], ...] = (
    {"kind": "smart"},
    {"kind": "fit-plane"},
    {"kind": "perimeter-mean"},
    {"kind": "reference", "mode": "perimeter-min"},
)

#: A mean total below a cubic centimetre counts as 0 (a base on flat ground leaves float noise).
MEAN_ZERO_M3 = 1e-6


def series_applies(item: dict[str, Any]) -> bool:
    """True when one side is ``current``: only then does every row carry its viewing date (an item
    whose only date side is ``previous`` is not run as a series)."""
    return item["from"].get("kind") == "current" or item["to"].get("kind") == "current"


def compare_series(
    ring: Sequence[Sequence[float]],
    item: dict[str, Any],
    resolve_at: Callable[[str], Resolve],
    captures: Sequence[str],
    site: dict[str, Any] | None = None,
    now: str | None = None,
    ring_shift: LineUp = ZERO,
    ring_current: LineUp | None = None,
    neighbours: list[Any] | None = None,
) -> list[dict[str, Any]]:
    """One ``ComparisonResult`` per capture of ``captures``, in their order (see the module)."""
    out: list[dict[str, Any]] = []
    for cap in captures:
        r = compare_item(
            ring,
            item,
            resolve_at(cap),
            site,
            now=now,
            ring_shift=ring_shift,
            ring_current=ring_current,
            neighbours=neighbours,
        )
        if item["from"].get("kind") == "current":
            r["fromCapture"] = cap
        if item["to"].get("kind") == "current":
            r["toCapture"] = cap
        out.append(r)
    return out


def base_key(spec: dict[str, Any]) -> str:
    """A base's short name in a spread: its kind, or a reference base's mode."""
    return str(spec["mode"] if spec["kind"] == "reference" else spec["kind"])


def spread_pct(totals: Sequence[float]) -> float | None:
    """``(max - min) / 2 / mean`` of ``totals`` in percent; ``None`` for fewer than 2 totals or a mean
    below ``MEAN_ZERO_M3``. Over the total volume (fill + cut), not net, on purpose: net can cross zero.
    """
    if len(totals) < 2:
        return None
    total = 0.0
    for t in totals:
        total += t
    mean = total / len(totals)
    if mean < MEAN_ZERO_M3:
        return None
    return (max(totals) - min(totals)) / 2 / mean * 100


def base_spread(
    ring: Sequence[Sequence[float]],
    item: dict[str, Any],
    resolve: Resolve,
    site: dict[str, Any] | None = None,
    now: str | None = None,
    ring_shift: LineUp = ZERO,
    ring_current: LineUp | None = None,
    neighbours: list[Any] | None = None,
) -> dict[str, Any] | None:
    """``{"pct", "nets": [{"base", "netM3"}]}`` over ``SPREAD_BASES``, or ``None`` (see the module)."""
    if is_surface(item["from"]):
        return None
    totals: list[float] = []
    nets: list[dict[str, Any]] = []
    for spec in SPREAD_BASES:
        r = compare_item(
            ring,
            {**item, "from": dict(spec)},
            resolve,
            site,
            now=now,
            ring_shift=ring_shift,
            ring_current=ring_current,
            neighbours=neighbours,
        )
        if r["status"] in ("ok", "partial"):
            totals.append(float(r["totalM3"]))
            nets.append({"base": base_key(spec), "netM3": float(r["netM3"])})
    # the spread is over totalM3, not net, on purpose: net can cross zero
    pct = spread_pct(totals)
    return None if pct is None else {"pct": pct, "nets": nets}
