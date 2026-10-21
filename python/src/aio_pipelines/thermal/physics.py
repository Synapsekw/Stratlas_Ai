"""Raw thermal counts to degrees Celsius: the standard FLIR radiometric formula.

The camera records ``raw = E * tau * S(T_obj) + (1 - E) * tau * S(T_refl) + (1 - tau) * S(T_atm)``
where ``S(T) = R1 / (R2 * (exp(B / T) - F)) - O`` is the Planck curve fitted for that camera
and ``tau`` the atmospheric transmission over the object distance (split in two halves around
an IR window, as FLIR does; the window itself is omitted, i.e. transmission 1). Inverting it
gives the object temperature ``B / ln(R1 / (R2 * (S_obj + O)) + F) - 273.15``.

All work is vectorised in float64; the result is cast to float32 at the end. Pixels whose raw
value falls outside the invertible range come out NaN, never a plausible-looking number.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

KELVIN = 273.15


@dataclass(frozen=True)
class ThermalSettingsPy:
    """Per-photo measurement settings (mirror of the TypeScript ``ThermalSettings``).

    ``reflected_c`` None means "same as the air temperature".
    """

    emissivity: float
    distance_m: float
    air_c: float
    humidity_pct: float
    reflected_c: float | None


@dataclass(frozen=True)
class Planck:
    """Camera calibration constants (FLIR CameraInfo PlanckR1, R2, B, F, O)."""

    r1: float
    r2: float
    b: float
    f: float
    o: float


@dataclass(frozen=True)
class Atmos:
    """Atmospheric transmission constants (FLIR AtmosphericTransAlpha1/2, Beta1/2, X)."""

    alpha1: float
    alpha2: float
    beta1: float
    beta2: float
    x: float


def validate_settings(settings: ThermalSettingsPy) -> None:
    """Raise ``ValueError`` for settings the formula cannot use."""
    e = settings.emissivity
    if not (math.isfinite(e) and 0.0 < e <= 1.0):
        raise ValueError(f"emissivity must be in (0, 1], got {e}")
    if not (math.isfinite(settings.distance_m) and settings.distance_m >= 0.0):
        raise ValueError(f"distance must be 0 m or more, got {settings.distance_m}")
    if not (math.isfinite(settings.humidity_pct) and 0.0 <= settings.humidity_pct <= 100.0):
        raise ValueError(f"humidity must be 0 to 100 %, got {settings.humidity_pct}")
    temps = [settings.air_c] + ([] if settings.reflected_c is None else [settings.reflected_c])
    for t in temps:
        if not (math.isfinite(t) and t > -KELVIN):
            raise ValueError(f"temperature out of range: {t}")


def transmission(atmos: Atmos, distance_m: float, air_c: float, humidity_pct: float) -> float:
    """Transmission of one half of the path (the formula applies it twice)."""
    ta = air_c
    h2o = (humidity_pct / 100.0) * math.exp(
        1.5587 + 0.06939 * ta - 0.00027816 * ta**2 + 0.00000068455 * ta**3
    )
    sqrt_h2o = math.sqrt(h2o)
    half = math.sqrt(distance_m / 2.0)
    return atmos.x * math.exp(-half * (atmos.alpha1 + atmos.beta1 * sqrt_h2o)) + (1.0 - atmos.x) * math.exp(
        -half * (atmos.alpha2 + atmos.beta2 * sqrt_h2o)
    )


def checked_transmission(atmos: Atmos, settings: ThermalSettingsPy) -> float:
    """Half-path transmission for these settings; ``ValueError`` unless it is in (0, 1]."""
    tau = transmission(atmos, settings.distance_m, settings.air_c, settings.humidity_pct)
    if not (math.isfinite(tau) and 0.0 < tau <= 1.0):
        raise ValueError(f"atmospheric transmission must be in (0, 1], got {tau}")
    return tau


def planck_raw(t_c: float, planck: Planck) -> float:
    """The raw signal a black body at ``t_c`` °C produces."""
    return planck.r1 / (planck.r2 * (math.exp(planck.b / (t_c + KELVIN)) - planck.f)) - planck.o


def to_celsius(raw: np.ndarray, planck: Planck, atmos: Atmos, settings: ThermalSettingsPy) -> np.ndarray:
    """Object temperature in °C (float32, same shape as ``raw``)."""
    validate_settings(settings)
    e = settings.emissivity
    reflected = settings.air_c if settings.reflected_c is None else settings.reflected_c
    tau1 = checked_transmission(atmos, settings)
    tau2 = tau1
    raw_refl = planck_raw(reflected, planck)
    raw_atm = planck_raw(settings.air_c, planck)

    r = np.asarray(raw, dtype=np.float64)
    obj = (
        r / (e * tau1 * tau2)
        - (1.0 - tau1) / (e * tau1) * raw_atm
        - (1.0 - tau2) / (e * tau1 * tau2) * raw_atm
        - (1.0 - e) / e * raw_refl
    )
    with np.errstate(divide="ignore", invalid="ignore"):
        arg = planck.r1 / (planck.r2 * (obj + planck.o)) + planck.f
        t = planck.b / np.log(arg) - KELVIN
    t = np.where((obj + planck.o > 0) & (arg > 1.0) & np.isfinite(t), t, np.nan)
    return t.astype(np.float32)
