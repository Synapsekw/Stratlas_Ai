"""Co-registration check of two dates on a common grid (M8 C2).

Two rasters of the same area (orthos, or the slope of two DSMs) are compared tile by tile with a
phase correlation on their high-passed log brightness, which is blind to exposure and shade. The
median shift of the tiles with enough texture is the shift between the dates; a comparison refuses
to run beyond its tolerance (``maxShiftPx``, founder default 2 px) and otherwise moves the later
date back by it, so a small misalignment never shows as change everywhere.
"""

from __future__ import annotations

from typing import Any

import numpy as np

TILE = 128
#: A tile needs this much high-passed texture (standard deviation of log brightness).
MIN_TEXTURE = 0.01
UPSAMPLE = 20


def highpass(lum: np.ndarray, sigma: float = 2.0) -> np.ndarray:
    """High-passed log brightness: shade and exposure (multiplicative) become a slow offset, removed."""
    from scipy import ndimage as ndi

    log = np.log(np.clip(lum, 1e-3, None))
    return log - ndi.gaussian_filter(log, sigma)


def estimate_shift(a: np.ndarray, b: np.ndarray, valid: np.ndarray, tile: int = TILE) -> dict[str, Any]:
    """The shift (rows, columns) that moves ``b`` onto ``a``, the median of textured tiles.

    ``a`` and ``b`` are brightness (or slope) grids of the same shape; ``valid`` marks cells both
    dates cover. Returns ``dy``, ``dx``, ``px`` (length), ``tiles`` (tiles used) and ``spread``
    (median distance of the tile shifts from the result, a confidence measure).
    """
    from skimage.registration import phase_cross_correlation

    ha, hb = highpass(a), highpass(b)
    h, w = a.shape
    step = tile if min(h, w) >= 2 * tile else max(32, min(h, w) // 2)
    shifts: list[tuple[float, float]] = []
    for r in range(0, h - step + 1, step):
        for c in range(0, w - step + 1, step):
            if not valid[r : r + step, c : c + step].all():
                continue
            ta, tb = ha[r : r + step, c : c + step], hb[r : r + step, c : c + step]
            if ta.std() < MIN_TEXTURE or tb.std() < MIN_TEXTURE:
                continue
            win = np.outer(np.hanning(step), np.hanning(step))
            s, _, _ = phase_cross_correlation(
                ta * win, tb * win, upsample_factor=UPSAMPLE, normalization=None
            )
            if abs(s[0]) < step / 3 and abs(s[1]) < step / 3:
                shifts.append((float(s[0]), float(s[1])))
    if not shifts:
        return {"dy": 0.0, "dx": 0.0, "px": 0.0, "tiles": 0, "spread": 0.0}
    arr = np.array(shifts)
    dy, dx = np.median(arr[:, 0]), np.median(arr[:, 1])
    spread = float(np.median(np.hypot(arr[:, 0] - dy, arr[:, 1] - dx)))
    return {
        "dy": round(float(dy), 3),
        "dx": round(float(dx), 3),
        "px": round(float(np.hypot(dy, dx)), 3),
        "tiles": len(shifts),
        "spread": round(spread, 3),
    }


def registration(shift: dict[str, Any], cell: float, max_px: float) -> dict[str, Any]:
    """The change set's ``registration`` block for a measured shift."""
    ok = shift["px"] <= max_px + 1e-9
    out: dict[str, Any] = {
        "ok": bool(ok),
        "shiftPx": round(shift["px"], 2),
        "shiftM": round(shift["px"] * cell, 3),
        "tolerancePx": max_px,
        "toleranceM": round(max_px * cell, 3),
    }
    if shift["tiles"] == 0:
        out["message"] = "Too little texture to measure the alignment; assumed aligned."
    elif ok:
        out["message"] = f"The dates line up within {shift['px']:.1f} px ({shift['px'] * cell:.2f} m)."
    else:
        out["message"] = refusal(shift["px"], cell, max_px)
    return out


def refusal(px: float, cell: float, max_px: float) -> str:
    return (
        f"The two dates are {px:.1f} px ({px * cell:.2f} m) apart; the largest shift allowed is "
        f"{max_px:g} px. Align the layers first, or allow a larger shift."
    )
