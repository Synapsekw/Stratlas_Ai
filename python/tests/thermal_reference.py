"""An independent, deliberately plain FLIR raw-to-temperature reference.

Written pixel by pixel in plain Python floats from the published FLIR formula (the one ExifTool's
documentation and the usual R and MATLAB ports use), with the external IR window omitted
(transmission 1, no window or window-reflection terms). It must never import
``aio_pipelines.thermal.physics``: the tests compare that module against this one.
"""

from __future__ import annotations

import math


def reference_celsius(
    raw: float,
    *,
    r1: float,
    r2: float,
    b: float,
    f: float,
    o: float,
    alpha1: float,
    alpha2: float,
    beta1: float,
    beta2: float,
    x: float,
    emissivity: float,
    distance_m: float,
    air_c: float,
    humidity_pct: float,
    reflected_c: float,
) -> float:
    """Object temperature in °C for one raw value."""
    # water vapour content of the air from relative humidity and air temperature
    rh = humidity_pct / 100.0
    h2o = rh * math.exp(1.5587 + 0.06939 * air_c - 0.00027816 * air_c**2 + 0.00000068455 * air_c**3)
    # the path is split in two halves around the (omitted) window, as FLIR does
    half = math.sqrt(distance_m / 2.0)
    tau1 = x * math.exp(-half * (alpha1 + beta1 * math.sqrt(h2o))) + (1.0 - x) * math.exp(
        -half * (alpha2 + beta2 * math.sqrt(h2o))
    )
    tau2 = tau1
    ir_window_t = 1.0

    raw_refl1 = r1 / (r2 * (math.exp(b / (reflected_c + 273.15)) - f)) - o
    raw_refl1_attn = (1.0 - emissivity) / emissivity * raw_refl1
    raw_atm1 = r1 / (r2 * (math.exp(b / (air_c + 273.15)) - f)) - o
    raw_atm1_attn = (1.0 - tau1) / emissivity / tau1 * raw_atm1
    raw_atm2 = raw_atm1
    raw_atm2_attn = (1.0 - tau2) / emissivity / tau1 / ir_window_t / tau2 * raw_atm2

    raw_obj = raw / emissivity / tau1 / ir_window_t / tau2 - raw_atm1_attn - raw_atm2_attn - raw_refl1_attn
    return b / math.log(r1 / (r2 * (raw_obj + o)) + f) - 273.15


def reference_field(raw_rows, planck, atmos, settings) -> list[list[float]]:
    """The reference over a 2-D raw field (any nested sequence of numbers)."""
    reflected = settings.air_c if settings.reflected_c is None else settings.reflected_c
    out: list[list[float]] = []
    for row in raw_rows:
        out.append(
            [
                reference_celsius(
                    float(v),
                    r1=planck.r1,
                    r2=planck.r2,
                    b=planck.b,
                    f=planck.f,
                    o=planck.o,
                    alpha1=atmos.alpha1,
                    alpha2=atmos.alpha2,
                    beta1=atmos.beta1,
                    beta2=atmos.beta2,
                    x=atmos.x,
                    emissivity=settings.emissivity,
                    distance_m=settings.distance_m,
                    air_c=settings.air_c,
                    humidity_pct=settings.humidity_pct,
                    reflected_c=reflected,
                )
                for v in row
            ]
        )
    return out
