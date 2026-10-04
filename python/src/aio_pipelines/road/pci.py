"""ASTM D6433 PCI for asphalt sample units: deduct values, corrected deduct value, PCI.

Ported line for line from the road builder of the 1st Ring Road review
(``Road Review/_build/pci/grid_pci.py``, functions ``deduct``, ``cdv`` and ``pci``), so a rebuilt
road gives the delivered numbers.

Source of the curves: ``pci_curves.json`` is that build's ``pci_observed.json``, the ASTM D6433
deduct-value curves (one per distress and severity, density on a log axis) and the corrected
deduct value curves (q = 1 to 10) as digitised in the MIT-licensed ``pavement_condition_index``
Ruby gem (Andy Monroe, 2017; ``PCI_CURVES_LICENSE.txt``), which tabulates points read off the
ASTM D6433 charts. Between tabulated points a deduct value is interpolated linearly in log10 of
the density, the corrected deduct value linearly in the total deduct value.
"""

from __future__ import annotations

import json
import math
from functools import cache
from pathlib import Path
from typing import Any

SEVERITIES = ("low", "medium", "high")
FT2 = 10.7639104  # square feet per square metre
FT = 3.2808399  # feet per metre


@cache
def curves() -> dict[str, Any]:
    return json.loads((Path(__file__).with_name("pci_curves.json")).read_text("utf-8"))


def distresses() -> list[str]:
    return sorted(curves()["deduct"])


def deduct(key: str, sev: str, dens_pct: float) -> float:
    """Deduct value of one distress at one severity for a density in percent of the unit."""
    cur = curves()["deduct"][key]
    xs = cur["x_values"]
    ys = cur["expected_y_values"][sev]
    if dens_pct <= 0:
        return 0.0
    if dens_pct < xs[0]:
        return max(0.0, ys[0] * dens_pct / xs[0])
    if dens_pct >= xs[-1]:
        return float(ys[-1])
    lx = math.log10(dens_pct)
    for k in range(len(xs) - 1):
        if xs[k] <= dens_pct <= xs[k + 1]:
            f = (lx - math.log10(xs[k])) / (math.log10(xs[k + 1]) - math.log10(xs[k]))
            return max(0.0, ys[k] + f * (ys[k + 1] - ys[k]))
    return float(ys[-1])


def cdv(q: int, tdv: float) -> float:
    """Corrected deduct value for q deducts above 2 and a total deduct value."""
    cx = curves()["cdv_x"]
    ys = curves()["cdv"][f"q{min(q, 10)}"]
    if tdv <= cx[0]:
        return tdv if q == 1 else ys[0] * tdv / cx[0]
    if tdv >= cx[-1]:
        return float(ys[-1])
    for k in range(len(cx) - 1):
        if cx[k] <= tdv <= cx[k + 1]:
            return ys[k] + (tdv - cx[k]) / (cx[k + 1] - cx[k]) * (ys[k + 1] - ys[k])
    return float(ys[-1])


def pci(dvs: list[float]) -> tuple[float, float]:
    """PCI and the maximum corrected deduct value of a unit's deduct values (ASTM D6433 sec. 10).

    The allowable number of deducts is ``m = 1 + 9/98 (100 - HDV)`` (at most 10); deducts beyond
    ``int(m)`` drop, the next one counts by the fraction of ``m``. The CDV is iterated from q (the
    deducts above 2.0) down to 1, setting the smallest above 2.0 to 2.0 each time; the largest CDV
    gives PCI = 100 - CDV.
    """
    dvs = sorted([d for d in dvs if d > 0], reverse=True)
    if not dvs:
        return 100.0, 0.0
    hdv = dvs[0]
    m = min(10.0, 1 + 9 / 98 * (100 - hdv))
    keep = dvs[: int(m)]
    if len(dvs) > int(m):
        keep.append(dvs[int(m)] * (m - int(m)))
    q = sum(1 for d in keep if d > 2.0)
    best = 0.0
    if q == 0:
        best = sum(keep)
    for qq in range(q, 0, -1):
        adj = [d if n < qq else min(d, 2.0) for n, d in enumerate(keep)]
        best = max(best, cdv(qq, sum(adj)))
    best = min(best, 100.0)
    return round(100 - best, 1), round(best, 1)


def unit_pci(quantities: dict[str, float], pavement_m2: float) -> tuple[list[float], list[list[Any]]]:
    """PCI of a sample unit under the Low, Medium and High severity assumptions, and the deducts.

    ``quantities`` are per ASTM distress in imperial units (ft2, ft or a count), as the delivered
    builder summed them; density is ``100 qty / (pavement ft2)``. The deducts returned are those of
    the Medium assumption, largest first, at most six (``[distress, density %, deduct]``).
    """
    res: list[float] = []
    det: list[list[Any]] = []
    for sev in SEVERITIES:
        dvs = []
        for k2, v in quantities.items():
            dp = 100 * v / (pavement_m2 * FT2)
            dv = deduct(k2, sev, dp)
            dvs.append(dv)
            if sev == "medium":
                det.append([k2, round(dp, 2), round(dv, 1)])
        res.append(pci(dvs)[0])
    det.sort(key=lambda x: -x[2])
    return res, det[:6]


def weighted(units: list[dict[str, Any]], sev: int) -> float | None:
    """Pavement-weighted mean PCI of units (``wavg`` of the delivered builder)."""
    a = sum(u["pavementM2"] for u in units)
    return round(sum(u["pavementM2"] * u["pci"][sev] for u in units) / a, 1) if a else None


# Rating classes of ASTM D6433 (PCI 0 to 100), highest first: the delivered review's colours.
RATINGS = [
    {"min": 86, "label": "Good", "color": "#1f9d55"},
    {"min": 71, "label": "Satisfactory", "color": "#8bc34a"},
    {"min": 56, "label": "Fair", "color": "#f2c94c"},
    {"min": 41, "label": "Poor", "color": "#f2994a"},
    {"min": 26, "label": "Very Poor", "color": "#eb5757"},
    {"min": 11, "label": "Serious", "color": "#b0232a"},
    {"min": 0, "label": "Failed", "color": "#6d6d6d"},
]
