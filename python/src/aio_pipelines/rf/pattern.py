"""Antenna patterns (spec D11), vectorised; the twin of ``packages/rf/src/pattern.ts`` and ``msi.ts``.

Angles come from the antenna frame (``grid.antenna_angles``): azimuth off boresight, positive
clockwise; down-elevation below the boresight plane, positive down. Losses are dB >= 0.

- Parametric, 3GPP TR 38.901 Table 7.3-1, the electrical tilt shifting the vertical cut:
  A_H = -min(12 (phi / phi3dB)^2, Am), A_V = -min(12 ((down - etilt) / theta3dB)^2, SLAv),
  loss = min(-(A_H + A_V), Am); Am is the front-to-back value, Am = SLAv = 30 dB by default.
- Two-cut (MSI / Planet), summing method: loss = min(H(phi) + V(down), cap), the cuts read by
  linear interpolation between whole degrees, angles modulo 360. The file holds its own e-tilt.
- MSI files: the horizontal angle in the file runs counter-clockwise, so internal[k] =
  file[(360 - k) mod 360]; the vertical cut is kept (0 horizon, 90 down, 270 up); a GAIN with no
  unit is dBd (+2.15 to dBi).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

import numpy as np

DEFAULT_AM_DB = 30.0
DEFAULT_SLAV_DB = 30.0
DEFAULT_H_BEAMWIDTH_DEG = 65.0
DBD_TO_DBI = 2.15


@dataclass(frozen=True)
class Parametric:
    h_beamwidth_deg: float
    v_beamwidth_deg: float
    etilt_deg: float
    am_db: float = DEFAULT_AM_DB
    slav_db: float = DEFAULT_SLAV_DB


@dataclass(frozen=True)
class TwoCut:
    horizontal_db: np.ndarray = field(repr=False)
    vertical_db: np.ndarray = field(repr=False)
    cap_db: float = DEFAULT_AM_DB


Pattern = Parametric | TwoCut


def two_cut(horizontal_db: Any, vertical_db: Any, cap_db: float) -> TwoCut:
    h = np.asarray(horizontal_db, dtype=np.float64)
    v = np.asarray(vertical_db, dtype=np.float64)
    for name, cut in (("horizontal", h), ("vertical", v)):
        if cut.shape != (360,):
            raise ValueError(f"The {name} cut needs 360 values, one per degree (got {cut.size}).")
        if not np.all(np.isfinite(cut)):
            raise ValueError(f"The {name} cut has a value that is not finite.")
    if not cap_db >= 0:
        raise ValueError("The front-to-back cap must be zero or more.")
    return TwoCut(h, v, float(cap_db))


def _cut_at(cut: np.ndarray, angle_deg: np.ndarray) -> np.ndarray:
    a = np.mod(angle_deg, 360.0)
    i0 = np.floor(a)
    t = a - i0
    i = i0.astype(np.int64) % 360
    return cut[i] + (cut[(i + 1) % 360] - cut[i]) * t


def pattern_loss_db(p: Pattern, azimuth_deg: np.ndarray, down_deg: np.ndarray) -> np.ndarray:
    """Pattern attenuation relative to the peak gain, dB >= 0."""
    az = np.asarray(azimuth_deg, dtype=np.float64)
    down = np.asarray(down_deg, dtype=np.float64)
    if isinstance(p, TwoCut):
        return np.minimum(_cut_at(p.horizontal_db, az) + _cut_at(p.vertical_db, down), p.cap_db)
    if not (p.h_beamwidth_deg > 0 and p.v_beamwidth_deg > 0):
        raise ValueError("Beamwidths must be positive.")
    phi = np.mod(az, 360.0)
    phi = np.where(phi > 180.0, phi - 360.0, phi)
    ah = np.minimum(12 * (phi / p.h_beamwidth_deg) ** 2, p.am_db)
    av = np.minimum(12 * ((down - p.etilt_deg) / p.v_beamwidth_deg) ** 2, p.slav_db)
    return np.minimum(ah + av, p.am_db)


# ---------------------------------------------------------------------------------------- MSI files

_NUM = re.compile(r"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$")


def _tokens(line: str) -> list[str]:
    return [t for t in re.split(r"[\s,]+", line.strip()) if t]


@dataclass(frozen=True)
class Msi:
    frequency_mhz: float
    gain_dbi: float
    etilt_deg: float | None
    #: 360 attenuations clockwise from boresight (engine convention)
    horizontal_db: list[float]
    #: 360 attenuations below boresight: 90 down, 270 up
    vertical_db: list[float]
    name: str | None = None


def _read_cut(lines: list[str], start: int, name: str) -> tuple[list[float], int]:
    first = _tokens(lines[start])
    if len(first) < 2 or first[1] != "360":
        raise ValueError(f'MSI: {name} must say 360 (one value per degree), found "{lines[start].strip()}"')
    values: list[float | None] = [None] * 360
    i, got = start + 1, 0
    while i < len(lines) and got < 360:
        t = _tokens(lines[i])
        if not t:
            i += 1
            continue
        if len(t) < 2 or not _NUM.match(t[0]) or not _NUM.match(t[1]):
            break
        angle = float(t[0])
        if angle != int(angle) or not 0 <= angle <= 359:
            raise ValueError(f'MSI: {name} angle "{t[0]}" is not a whole degree from 0 to 359')
        if values[int(angle)] is not None:
            raise ValueError(f"MSI: {name} angle {t[0]} appears twice")
        values[int(angle)] = float(t[1])
        got += 1
        i += 1
    if got != 360:
        raise ValueError(f"MSI: {name} has {got} values, 360 needed")
    return [float(v) for v in values if v is not None], i


def parse_msi(text: str) -> Msi:
    """Parse an MSI / Planet file; ValueError in plain words when it is unusable."""
    lines = text.splitlines()
    head: dict[str, str] = {}
    cuts: dict[str, list[float]] = {}
    i = 0
    while i < len(lines):
        raw = lines[i]
        t = _tokens(raw)
        key = t[0].upper() if t else ""
        if key in ("HORIZONTAL", "VERTICAL"):
            if key in cuts:
                raise ValueError(f"MSI: {key} appears twice")
            cuts[key], i = _read_cut(lines, i, key)
            continue
        if key and key not in head:
            head[key] = raw.strip()[len(t[0]) :].strip()
        i += 1
    if "HORIZONTAL" not in cuts:
        raise ValueError("MSI: the HORIZONTAL 360 cut is missing")
    if "VERTICAL" not in cuts:
        raise ValueError("MSI: the VERTICAL 360 cut is missing")
    ft = _tokens(head.get("FREQUENCY", ""))
    freq = float(ft[0]) if ft and _NUM.match(ft[0]) else float("nan")
    if not freq > 0:
        raise ValueError("MSI: FREQUENCY (MHz) is missing or not a number")
    gm = re.match(r"^([+-]?\d*\.?\d+)\s*(dBi|dBd)?", head.get("GAIN", ""), re.I)
    if not gm:
        raise ValueError("MSI: GAIN is missing or not a number")
    gain = float(gm.group(1)) + (0.0 if (gm.group(2) or "dBd").lower() == "dbi" else DBD_TO_DBI)
    tilt_text = head.get("TILT", head.get("ELECTRICAL_TILT"))
    tilt = next((float(x) for x in _tokens(tilt_text or "") if _NUM.match(x)), None)
    fh = cuts["HORIZONTAL"]
    return Msi(
        frequency_mhz=freq,
        gain_dbi=gain,
        etilt_deg=tilt,
        horizontal_db=[fh[(360 - k) % 360] for k in range(360)],
        vertical_db=cuts["VERTICAL"],
        name=head.get("NAME") or None,
    )


def pick_nearest(refs: list[dict[str, Any]], frequency_mhz: float, etilt_deg: float) -> dict[str, Any] | None:
    """The pattern reference nearest in frequency, then in e-tilt; ties go to the lower e-tilt."""
    if not refs:
        return None
    best_f = min(abs(float(r["frequencyMhz"]) - frequency_mhz) for r in refs)
    same = [r for r in refs if abs(abs(float(r["frequencyMhz"]) - frequency_mhz) - best_f) < 1e-9]
    return min(same, key=lambda r: (round(abs(float(r["etiltDeg"]) - etilt_deg), 9), float(r["etiltDeg"])))
