"""Co-registration check of two dates on a common grid (M8 C2).

Two rasters of the same area (orthos, or the slope of two DSMs) are compared tile by tile with a
phase correlation on their high-passed log brightness, which is blind to exposure and shade. The
median shift of the tiles with enough texture is the shift between the dates; a comparison refuses
to run beyond its tolerance (``maxShiftPx``, founder default 2 px) and otherwise moves the later
date back by it, so a small misalignment never shows as change everywhere.

``measure_line_up`` measures larger gaps (tens of metres) coarse to fine for ``change.lineup``.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from ..runtime import JobError

TILE = 128
#: A tile needs this much high-passed texture (standard deviation of log brightness).
MIN_TEXTURE = 0.01
UPSAMPLE = 20
#: A tile whose correlation is this poor (scikit-image's error, 0 good to 1 none) is left out.
MAX_ERROR = 0.8


def highpass(lum: np.ndarray, sigma: float = 2.0, log: bool = True) -> np.ndarray:
    """High-passed log brightness: shade and exposure (multiplicative) become a slow offset, removed.

    With ``log`` false the grid (heights) is high-passed as it is.
    """
    from scipy import ndimage as ndi

    x = np.log(np.clip(lum, 1e-3, None)) if log else np.asarray(lum, np.float64)
    return x - ndi.gaussian_filter(x, sigma)


def estimate_shift(
    a: np.ndarray,
    b: np.ndarray,
    valid: np.ndarray,
    tile: int = TILE,
    log: bool = True,
    min_texture: float = MIN_TEXTURE,
) -> dict[str, Any]:
    """The shift (rows, columns) that moves ``b`` onto ``a``, the median of textured tiles.

    ``a`` and ``b`` are brightness (or slope) grids of the same shape; ``valid`` marks cells both
    dates cover; ``log`` false for heights. Returns ``dy``, ``dx``, ``px`` (length), ``tiles`` (tiles used) and ``spread``
    (median distance of the tile shifts from the result, a confidence measure).
    """
    ha, hb = highpass(a, log=log), highpass(b, log=log)
    h, w = a.shape
    step = tile if min(h, w) >= 2 * tile else max(32, min(h, w) // 2)
    shifts: list[tuple[float, float]] = []
    for r in range(0, h - step + 1, step):
        for c in range(0, w - step + 1, step):
            if not valid[r : r + step, c : c + step].all():
                continue
            ta, tb = ha[r : r + step, c : c + step], hb[r : r + step, c : c + step]
            if ta.std() < min_texture or tb.std() < min_texture:
                continue
            s = _tile_shift(ta, tb)
            if s is not None:
                shifts.append(s)
    return _median_shift(shifts)


def _tile_shift(ta: np.ndarray, tb: np.ndarray) -> tuple[float, float] | None:
    """The shift (rows, columns) moving tile ``tb`` onto ``ta`` (square, high-passed), or None
    when the correlation is poor or the answer is beyond a third of the tile."""
    from skimage.registration import phase_cross_correlation

    step = ta.shape[0]
    win = np.outer(np.hanning(step), np.hanning(step))
    s, error, _ = phase_cross_correlation(ta * win, tb * win, upsample_factor=UPSAMPLE, normalization=None)
    if error < MAX_ERROR and abs(s[0]) < step / 3 and abs(s[1]) < step / 3:
        return float(s[0]), float(s[1])
    return None


def _median_shift(shifts: list[tuple[float, float]], dy0: float = 0.0, dx0: float = 0.0) -> dict[str, Any]:
    """The median of the tile shifts (plus ``dy0``, ``dx0``) and their spread around it."""
    if not shifts:
        dy, dx = float(dy0), float(dx0)
        return {
            "dy": round(dy, 3),
            "dx": round(dx, 3),
            "px": round(float(np.hypot(dy, dx)), 3),
            "tiles": 0,
            "spread": 0.0,
        }
    arr = np.array(shifts)
    dy, dx = np.median(arr[:, 0]), np.median(arr[:, 1])
    spread = float(np.median(np.hypot(arr[:, 0] - dy, arr[:, 1] - dx)))
    dy, dx = float(dy) + dy0, float(dx) + dx0
    return {
        "dy": round(dy, 3),
        "dx": round(dx, 3),
        "px": round(float(np.hypot(dy, dx)), 3),
        "tiles": len(shifts),
        "spread": round(spread, 3),
    }


# ------------------------------------------------------------------------------ line up dates

#: The coarse level is the first power of two at which a tile's search (a third of it) spans this.
COARSE_SEARCH_M = 60.0
#: The fine level reads at most this many tiles, the ones with the most texture.
MAX_FINE_TILES = 48
#: A measurement is trusted with at least this many fine tiles ...
MIN_TILES = 6
#: ... whose shifts lie within this of their median (the spread).
MAX_SPREAD_PX = 1.0
#: Dates whose common footprint is under this share of the smaller one's are not measured.
MIN_OVERLAP = 0.3


def slope(heights: np.ndarray, cell: float) -> np.ndarray:
    """The slope (rise over run) of a height grid of ``cell`` metres; NaN where a height is."""
    gy, gx = np.gradient(np.asarray(heights, np.float64), cell)
    return np.hypot(gx, gy)


def _coarse_level(h: int, w: int, cell: float) -> int:
    """The power of two at which ``COARSE_SEARCH_M`` fits in a tile's search, no coarser than
    leaves two tiles across the grid; 1 when the full resolution already spans it."""
    f = 1
    while TILE / 3 * cell * f < COARSE_SEARCH_M and min(h, w) // (2 * f) >= 2 * TILE:
        f *= 2
    return f


def _downsample(x: np.ndarray, valid: np.ndarray, f: int) -> tuple[np.ndarray, np.ndarray]:
    """Block means of ``f`` x ``f`` cells; a block is valid when all its cells are."""
    h, w = (x.shape[0] // f) * f, (x.shape[1] // f) * f
    xs = x[:h, :w].reshape(h // f, f, w // f, f).mean(axis=(1, 3))
    vs = valid[:h, :w].reshape(h // f, f, w // f, f).all(axis=(1, 3))
    return xs, vs


def measure_line_up(
    a: np.ndarray, b: np.ndarray, valid: np.ndarray, cell: float, log: bool = True
) -> dict[str, Any]:
    """The shift (rows, columns) that moves ``b`` onto ``a``, measured coarse to fine.

    A coarse level (``_coarse_level``, a power of two) finds shifts of up to ``COARSE_SEARCH_M``;
    then, with ``b`` moved by that answer, at most ``MAX_FINE_TILES`` full-resolution tiles of the
    most texture refine it. ``a``, ``b`` and ``valid`` as ``estimate_shift``. Returns ``dy``,
    ``dx``, ``px``, ``tiles`` and ``spread`` of the fine level, and ``coarse`` (the factor).
    """
    a = np.asarray(a, np.float64)
    b = np.asarray(b, np.float64)
    h, w = a.shape
    f = _coarse_level(h, w, cell)
    dy0 = dx0 = 0
    if f > 1:
        ac, vc = _downsample(a, valid, f)
        bc, _ = _downsample(b, valid, f)
        c = estimate_shift(ac, bc, vc, log=log)
        if c["tiles"]:
            dy0, dx0 = round(c["dy"] * f), round(c["dx"] * f)
    ha, hb = highpass(a, log=log), highpass(b, log=log)
    step = TILE if min(h, w) >= 2 * TILE else max(32, min(h, w) // 2)
    # b moved by the coarse answer: a(r, c) is b(r - dy0, c - dx0)
    found: list[tuple[float, int, int]] = []
    for r in range(0, h - step + 1, step):
        rb = r - dy0
        if rb < 0 or rb + step > h:
            continue
        for col in range(0, w - step + 1, step):
            cb = col - dx0
            if cb < 0 or cb + step > w:
                continue
            if not (
                valid[r : r + step, col : col + step].all() and valid[rb : rb + step, cb : cb + step].all()
            ):
                continue
            texture = min(ha[r : r + step, col : col + step].std(), hb[rb : rb + step, cb : cb + step].std())
            if texture >= MIN_TEXTURE:
                found.append((float(texture), r, col))
    found.sort(key=lambda t: -t[0])
    shifts: list[tuple[float, float]] = []
    for _, r, col in found[:MAX_FINE_TILES]:
        ta = ha[r : r + step, col : col + step]
        tb = hb[r - dy0 : r - dy0 + step, col - dx0 : col - dx0 + step]
        s = _tile_shift(ta, tb)
        if s is not None:
            shifts.append(s)
    out = _median_shift(shifts, float(dy0), float(dx0))
    out["coarse"] = f
    return out


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
        f"{max_px:g} px. Line up the dates first."
    )


def misaligned(shift: dict[str, Any], cell: float, max_px: float, from_c: str, to_c: str) -> JobError:
    """The refusal of a pair beyond its tolerance, coded so the app can offer to line up the dates.

    ``eastM`` and ``northM`` say where the later date's content sits relative to the earlier one
    (content 2 m east gives ``eastM`` about +2): ``shift`` moves the later grid back, columns east
    and rows south, so it is the opposite east and the same north.
    """
    return JobError(
        refusal(shift["px"], cell, max_px),
        code="misaligned",
        data={
            "from": from_c,
            "to": to_c,
            "shiftM": round(shift["px"] * cell, 3),
            "shiftPx": round(shift["px"], 2),
            "eastM": round(-shift["dx"] * cell, 3) + 0.0,
            "northM": round(shift["dy"] * cell, 3) + 0.0,
        },
    )
