"""Path-loss models (spec D14, D17), vectorised over the horizontal distance d2D.

The twin of ``packages/rf/src/propagation.ts``; the conventions are the golden file's
(``packages/rf/fixtures/golden/propagation.json``):

- d2D is clamped to at least 10 m in every model; d3D = sqrt(d2D^2 + (hBS - hUT)^2).
- 38.901 Table 7.4.1-1 with c = 3.0e8; the UMa and UMi breakpoint uses h' = h - 1 m. A UE below the
  scenario's range (UMa and UMi 1.5 m, RMa 1 m) is clamped up to it, with a warning, never refused.
  LOS probability from Table 7.4.2-1, mixed in the dB domain: P_LOS PL_LOS + (1 - P_LOS) PL_NLOS.
- Okumura-Hata and COST-231 Hata are floored at free space over d3D; a(hm) for the large city
  switches at 300 MHz; COST-231 ``open`` takes the Okumura-Hata open-area correction.
- Free space: 20 log10(4 pi d3D f / c) with the exact speed of light.

Out-of-range frequencies and heights with no effective height are refused with the range in the
reason (``PathLossRefused``); distances only ever warn.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np

from ..runtime import JobError

SPEED_OF_LIGHT_38901 = 3.0e8
SPEED_OF_LIGHT = 299_792_458.0
MIN_DISTANCE_2D_M = 10.0
EFFECTIVE_ENV_HEIGHT_M = 1.0
TR38901_MIN_UE_HEIGHT_M = {"uma": 1.5, "umi": 1.5, "rma": 1.0}
TR38901_MAX_UE_HEIGHT_M = {"uma": 22.5, "umi": 22.5, "rma": 10.0}
RMA_BUILDING_HEIGHT_M = 5.0
RMA_STREET_WIDTH_M = 20.0
HATA_RANGE_MHZ = (150.0, 1500.0)
COST231_RANGE_MHZ = (1500.0, 2000.0)
TR38901_RANGE_MHZ = {"uma": (500.0, 100_000.0), "umi": (500.0, 100_000.0), "rma": (500.0, 30_000.0)}
HATA_AREA_OF_ENVIRONMENT = {"uma": "urban", "umi": "urban", "rma": "open"}
MODELS = ("tr38901", "okumura-hata", "cost231-hata", "free-space")
ENVIRONMENTS = ("uma", "umi", "rma")
HATA_AREAS = ("urban-large", "urban", "suburban", "open")
MODEL_LABEL = {
    "tr38901": "3GPP TR 38.901",
    "okumura-hata": "Okumura-Hata",
    "cost231-hata": "COST-231 Hata",
    "free-space": "Free space",
}


@dataclass(frozen=True)
class Setup:
    model: str
    environment: str
    frequency_mhz: float
    #: antenna height above the tower-base ground, metres
    h_bs_m: float
    #: UE height above the same ground, metres
    h_ut_m: float
    #: Hata area; None follows the environment (HATA_AREA_OF_ENVIRONMENT)
    hata_area: str | None = None


class PathLossRefused(JobError):
    """A setup the model cannot compute; ``refusal`` holds the code and range."""

    def __init__(self, refusal: dict[str, Any]):
        super().__init__(refusal["message"])
        self.refusal = refusal


def _fmt(x: float) -> str:
    return f"{x:g}"


def refusal(s: Setup) -> dict[str, Any] | None:
    """Why a setup cannot be computed, or None (``pathLossRefusal`` in propagation.ts)."""
    f = s.frequency_mhz
    if not (isinstance(f, int | float) and math.isfinite(f) and f > 0):
        return {
            "code": "frequency",
            "model": s.model,
            "rangeMHz": None,
            "message": "The frequency must be more than 0 MHz.",
        }
    rng: tuple[float, float] | None = None
    if s.model == "okumura-hata":
        rng = HATA_RANGE_MHZ
    elif s.model == "cost231-hata":
        rng = COST231_RANGE_MHZ
    elif s.model == "tr38901":
        rng = TR38901_RANGE_MHZ[s.environment]
    if rng is not None and not (rng[0] <= f <= rng[1]):
        return {
            "code": "frequency",
            "model": s.model,
            "rangeMHz": [rng[0], rng[1]],
            "message": f"{MODEL_LABEL[s.model]} covers {_fmt(rng[0])} to {_fmt(rng[1])} MHz; {_fmt(f)} MHz is outside it. "
            "Pick another model for this band.",
        }
    ok = all(isinstance(h, int | float) and math.isfinite(h) and h > 0 for h in (s.h_bs_m, s.h_ut_m))
    if not ok:
        return {
            "code": "height",
            "model": s.model,
            "rangeMHz": None,
            "message": "Antenna and UE heights must be above the ground.",
        }
    if s.model == "tr38901" and s.environment != "rma" and s.h_bs_m <= EFFECTIVE_ENV_HEIGHT_M:
        return {
            "code": "height",
            "model": s.model,
            "rangeMHz": None,
            "message": f"{MODEL_LABEL[s.model]} {s.environment.upper()} needs the antenna above {_fmt(EFFECTIVE_ENV_HEIGHT_M)} m.",
        }
    return None


def warnings(s: Setup, max_distance_m: float) -> list[str]:
    """Validated-range notes for a study out to ``max_distance_m``; they never stop a run."""
    out: list[str] = []
    name = MODEL_LABEL[s.model]
    if s.model == "tr38901":
        if max_distance_m > 5000:
            out.append(f"{name} is validated to 5 km; beyond it the result is extrapolated.")
        if s.environment == "rma" and not 10 <= s.h_bs_m <= 150:
            out.append(f"{name} RMa is validated for antennas 10 to 150 m high.")
        lo, hi = TR38901_MIN_UE_HEIGHT_M[s.environment], TR38901_MAX_UE_HEIGHT_M[s.environment]
        if s.h_ut_m < lo:
            out.append(f"UE height below the model range, {_fmt(lo)} m used")
        elif s.h_ut_m > hi:
            out.append(f"{name} is validated for UE heights {_fmt(lo)} to {_fmt(hi)} m.")
    elif s.model in ("okumura-hata", "cost231-hata"):
        out.append(f"{name} is validated from 1 km; nearer the mast it is floored at free space.")
        if max_distance_m > 20_000:
            out.append(f"{name} is validated to 20 km; beyond it the result is extrapolated.")
        if not 30 <= s.h_bs_m <= 200:
            out.append(f"{name} is validated for antennas 30 to 200 m high.")
        if not 1 <= s.h_ut_m <= 10:
            out.append(f"{name} is validated for UE heights 1 to 10 m.")
    return out


def _d3(d2: np.ndarray, hbs: float, hut: float) -> np.ndarray:
    return np.sqrt(d2 * d2 + (hbs - hut) ** 2)


def free_space_db(frequency_mhz: float, d3d_m: np.ndarray) -> np.ndarray:
    return 20 * np.log10(4 * math.pi * d3d_m * frequency_mhz * 1e6 / SPEED_OF_LIGHT)


def los_probability(env: str, d2d_m: np.ndarray, h_ut_m: float) -> np.ndarray:
    """TR 38.901 Table 7.4.2-1 on d2D (clamped to 10 m)."""
    d = np.maximum(d2d_m, MIN_DISTANCE_2D_M)
    if env == "rma":
        return np.where(d <= 10, 1.0, np.exp(-(d - 10) / 1000))
    k = 63.0 if env == "uma" else 36.0
    p = 18 / d + np.exp(-d / k) * (1 - 18 / d)
    if env == "uma" and h_ut_m > 13:
        c = ((h_ut_m - 13) / 10) ** 1.5
        p = p * (1 + c * 1.25 * (d / 100) ** 3 * np.exp(-d / 150))
    return np.where(d <= 18, 1.0, p)


def tr38901(s: Setup, d2d_m: np.ndarray) -> dict[str, Any]:
    """LOS, NLOS (max with LOS), P_LOS and the expected path loss, dB; breakpoint and UE height used."""
    env = s.environment
    hut = max(float(s.h_ut_m), TR38901_MIN_UE_HEIGHT_M[env])
    hbs = float(s.h_bs_m)
    f = float(s.frequency_mhz)
    fc = f / 1000.0
    lg_fc = math.log10(fc)
    d2 = np.maximum(np.asarray(d2d_m, dtype=np.float64), MIN_DISTANCE_2D_M)
    dd = _d3(d2, hbs, hut)
    lg_dd = np.log10(dd)
    if env in ("uma", "umi"):
        bp = (
            4
            * (hbs - EFFECTIVE_ENV_HEIGHT_M)
            * (hut - EFFECTIVE_ENV_HEIGHT_M)
            * f
            * 1e6
            / SPEED_OF_LIGHT_38901
        )
        if env == "uma":
            a, b1, k = 28.0, 22.0, 9.0
            nlos_p = 13.54 + 39.08 * lg_dd + 20 * lg_fc - 0.6 * (hut - 1.5)
        else:
            a, b1, k = 32.4, 21.0, 9.5
            nlos_p = 35.3 * lg_dd + 22.4 + 21.3 * lg_fc - 0.3 * (hut - 1.5)
        pl1 = a + b1 * lg_dd + 20 * lg_fc
        pl2 = a + 40 * lg_dd + 20 * lg_fc - k * math.log10(bp * bp + (hbs - hut) ** 2)
        los = np.where(d2 <= bp, pl1, pl2)
    else:
        h, w = RMA_BUILDING_HEIGHT_M, RMA_STREET_WIDTH_M
        bp = 2 * math.pi * hbs * hut * f * 1e6 / SPEED_OF_LIGHT_38901
        ca = min(0.03 * h**1.72, 10)
        cb = min(0.044 * h**1.72, 14.77)
        cc = 0.002 * math.log10(h)

        def pl1_of(d):
            return 20 * np.log10(40 * math.pi * d * fc / 3) + ca * np.log10(d) - cb + cc * d

        los = np.where(d2 <= bp, pl1_of(dd), pl1_of(bp) + 40 * np.log10(dd / bp))
        nlos_p = (
            161.04
            - 7.1 * math.log10(w)
            + 7.5 * math.log10(h)
            - (24.37 - 3.7 * (h / hbs) ** 2) * math.log10(hbs)
            + (43.42 - 3.1 * math.log10(hbs)) * (lg_dd - 3)
            + 20 * lg_fc
            - (3.2 * math.log10(11.75 * hut) ** 2 - 4.97)
        )
    nlos = np.maximum(los, nlos_p)
    p = los_probability(env, d2, hut)
    return {
        "los": los,
        "nlos": nlos,
        "pLos": p,
        "expected": p * los + (1 - p) * nlos,
        "breakpointM": float(bp),
        "hUtUsedM": hut,
    }


def _a_hm(f: float, hm: float, area: str) -> float:
    if area == "urban-large":
        if f < 300:
            return 8.29 * math.log10(1.54 * hm) ** 2 - 1.1
        return 3.2 * math.log10(11.75 * hm) ** 2 - 4.97
    return (1.1 * math.log10(f) - 0.7) * hm - (1.56 * math.log10(f) - 0.8)


def hata(s: Setup, d2d_m: np.ndarray) -> np.ndarray:
    """Okumura-Hata or COST-231 Hata, floored at free space over d3D (setup already checked)."""
    f, hb, hm = float(s.frequency_mhz), float(s.h_bs_m), float(s.h_ut_m)
    area = s.hata_area or HATA_AREA_OF_ENVIRONMENT[s.environment]
    lg_f = math.log10(f)
    d2 = np.maximum(np.asarray(d2d_m, dtype=np.float64), MIN_DISTANCE_2D_M)
    slope = (44.9 - 6.55 * math.log10(hb)) * np.log10(d2 / 1000)
    if s.model == "okumura-hata":
        base = 69.55 + 26.16 * lg_f - 13.82 * math.log10(hb) - _a_hm(f, hm, area)
    else:
        base = (
            46.3
            + 33.9 * lg_f
            - 13.82 * math.log10(hb)
            - _a_hm(f, hm, area)
            + (3.0 if area == "urban-large" else 0.0)
        )
    if area == "suburban" and s.model == "okumura-hata":
        base -= 2 * math.log10(f / 28) ** 2 + 5.4
    elif area == "open":
        base += -4.78 * lg_f**2 + 18.33 * lg_f - 40.94
    return np.maximum(base + slope, free_space_db(f, _d3(d2, hb, hm)))


def check(s: Setup) -> None:
    if s.model not in MODELS:
        raise JobError(f'"{s.model}" is not a propagation model ({", ".join(MODELS)}).')
    if s.environment not in ENVIRONMENTS:
        raise JobError(f'"{s.environment}" is not an environment ({", ".join(ENVIRONMENTS)}).')
    if s.hata_area is not None and s.hata_area not in HATA_AREAS:
        raise JobError(f'"{s.hata_area}" is not a Hata area ({", ".join(HATA_AREAS)}).')
    r = refusal(s)
    if r is not None:
        raise PathLossRefused(r)


def path_loss_db(s: Setup, d2d_m: np.ndarray) -> np.ndarray:
    """Path loss at each horizontal distance, dB. Raises PathLossRefused for a refused setup."""
    check(s)
    d2 = np.asarray(d2d_m, dtype=np.float64)
    if s.model == "tr38901":
        return tr38901(s, d2)["expected"]
    if s.model in ("okumura-hata", "cost231-hata"):
        return hata(s, d2)
    return free_space_db(float(s.frequency_mhz), _d3(np.maximum(d2, MIN_DISTANCE_2D_M), s.h_bs_m, s.h_ut_m))
