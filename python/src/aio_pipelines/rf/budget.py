"""Downlink link budget (spec D13); the twin of ``packages/rf/src/budget.ts`` and ``bands.ts``.

  RSRP = P_port - 10 log10(12 N_RB) - L_feeder + G_ant - patternLoss - PL - margins

RSRP is per resource element and per port, so MIMO layers do not raise it. For an AAU the gain
and pattern are the SSB or broadcast beam's. Margins: penetration by preset, body loss and the
log-normal fade margin Phi^-1(edge probability) sigma. A value at or above a class floor is in
that class.
"""

from __future__ import annotations

import math
import re
from statistics import NormalDist
from typing import Any

import numpy as np

PENETRATION_MARGIN_DB = {"outdoor": 0.0, "in-car": 7.0, "indoor": 15.0, "deep-indoor": 20.0}
DEFAULT_THRESHOLDS = {"excellentDbm": -80.0, "goodDbm": -95.0, "fairDbm": -105.0, "poorDbm": -115.0}
#: Class codes in the order ``rsrp_classes`` returns them.
CLASS_NAMES = ("excellent", "good", "fair", "poor", "none")

#: GCC bands (bands.ts): id, LTE band numbers, NR band, duplex, nominal downlink centre (MHz).
BANDS: tuple[tuple[str, tuple[int, ...], str | None, str, float], ...] = (
    ("n28", (28,), "n28", "FDD", 780.0),
    ("b20-n20", (20,), "n20", "FDD", 806.0),
    ("b8-n8", (8,), "n8", "FDD", 942.5),
    ("b3-n3", (3,), "n3", "FDD", 1842.5),
    ("b1-n1", (1,), "n1", "FDD", 2140.0),
    ("b40-n40", (40,), "n40", "TDD", 2350.0),
    ("b7", (7,), None, "FDD", 2655.0),
    ("b41-n41", (38, 41), "n41", "TDD", 2593.0),
    ("n78", (), "n78", "TDD", 3500.0),
    ("n77", (), "n77", "TDD", 3700.0),
)

#: TS 36.101 Table 5.6-1.
LTE_N_RB = {1.4: 6, 3: 15, 5: 25, 10: 50, 15: 75, 20: 100}
#: TS 38.101-1 Table 5.3.2-1 (FR1).
NR_N_RB = {
    15: {5: 25, 10: 52, 15: 79, 20: 106, 25: 133, 30: 160, 40: 216, 50: 270},
    30: {
        5: 11,
        10: 24,
        15: 38,
        20: 51,
        25: 65,
        30: 78,
        40: 106,
        50: 133,
        60: 162,
        70: 189,
        80: 217,
        90: 245,
        100: 273,
    },
}


def band_of(name: str) -> tuple[str, tuple[int, ...], str | None, str, float] | None:
    """A band row from a carrier's band name: ``B3``, ``n78`` or a band id such as ``b3-n3``."""
    key = name.strip().lower()
    for row in BANDS:
        if row[0] == key:
            return row
    m = re.fullmatch(r"b(\d+)", key)
    if m:
        return next((row for row in BANDS if int(m.group(1)) in row[1]), None)
    if re.fullmatch(r"n\d+", key):
        return next((row for row in BANDS if row[2] == key), None)
    return None


def n_rb(tech: str, bandwidth_mhz: float, scs_khz: float | None) -> int:
    if tech == "lte":
        n = LTE_N_RB.get(bandwidth_mhz)
        if n is None:
            raise ValueError(f"LTE bandwidth {bandwidth_mhz:g} MHz is not a standard channel bandwidth")
        return n
    if scs_khz is None:
        raise ValueError("NR needs a subcarrier spacing (15 or 30 kHz)")
    table = NR_N_RB.get(int(scs_khz))
    if table is None:
        raise ValueError(f"NR subcarrier spacing {scs_khz:g} kHz is not supported in FR1 here")
    n = table.get(bandwidth_mhz)  # type: ignore[call-overload]
    if n is None:
        raise ValueError(f"NR {bandwidth_mhz:g} MHz is not defined at {scs_khz:g} kHz")
    return n


def subcarriers(tech: str, bandwidth_mhz: float, scs_khz: float | None) -> int:
    """12 N_RB."""
    return 12 * n_rb(tech, bandwidth_mhz, scs_khz)


def per_re_offset_db(subcarrier_count: int) -> float:
    return 10 * math.log10(subcarrier_count)


def fade_margin_db(edge_probability: float, shadow_sigma_db: float) -> float:
    if shadow_sigma_db == 0:
        return 0.0
    return NormalDist().inv_cdf(edge_probability) * shadow_sigma_db


def margins(
    preset: str, body_loss_db: float, edge_probability: float, shadow_sigma_db: float
) -> dict[str, float]:
    pen = PENETRATION_MARGIN_DB[preset]
    fade = fade_margin_db(edge_probability, shadow_sigma_db)
    return {
        "penetrationDb": pen,
        "bodyLossDb": float(body_loss_db),
        "fadeDb": fade,
        "totalDb": pen + body_loss_db + fade,
    }


def rsrp_dbm(
    port_power_dbm: float,
    subcarrier_count: int,
    feeder_loss_db: float,
    antenna_gain_dbi: float,
    pattern_loss_db: Any,
    path_loss_db: Any,
    margin_db: float,
) -> np.ndarray:
    const = (
        port_power_dbm - per_re_offset_db(subcarrier_count) - feeder_loss_db + antenna_gain_dbi - margin_db
    )
    return const - np.asarray(pattern_loss_db, dtype=np.float64) - np.asarray(path_loss_db, dtype=np.float64)


def rsrp_classes(rsrp: Any, thresholds: dict[str, float] | None = None) -> np.ndarray:
    """Class codes (index into CLASS_NAMES); NaN is ``none``."""
    t = thresholds or DEFAULT_THRESHOLDS
    v = np.asarray(rsrp, dtype=np.float64)
    out = np.full(v.shape, 4, dtype=np.uint8)
    for code, key in ((3, "poorDbm"), (2, "fairDbm"), (1, "goodDbm"), (0, "excellentDbm")):
        out[v >= t[key]] = code
    return out
