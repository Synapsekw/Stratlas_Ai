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
#: The fine level reads at most this many tiles: the most textured in each cell of a
#: ``SPREAD_CELLS`` square grid over the overlap, then the most textured of the rest.
MAX_FINE_TILES = 48
SPREAD_CELLS = 6
#: On a small overlap the fine tiles shrink, to no less than ``MIN_FINE_TILE`` px, so that its
#: short side holds ``FINE_ACROSS`` of them: 500 px hold only 3 x 3 tiles of ``TILE`` px, too few
#: for a fit once flat or changed ground leaves some out. The shift is then found first with tiles
#: of ``TILE`` px, so the smaller tiles search no less far.
FINE_ACROSS = 8
MIN_FINE_TILE = 64
#: Rounds of leaving out tiles that disagree with the fitted similarity (real change).
FIT_ROUNDS = 3
#: The least a fitted turn and scale must move some corner of the overlap, px, to be kept: below
#: it they are noise on a plain shift.
TURN_MIN_PX = 0.5
#: A measurement is trusted with at least this many fine tiles (inliers of the fit) ...
MIN_TILES = 6
#: ... whose shifts lie within this of the fitted similarity (the median residual).
MAX_SPREAD_PX = 1.0
#: A line-up turns at most this far and scales within 1 +- ``MAX_SCALE_DEV`` ...
MAX_ROTATION_DEG = 1.0
MAX_SCALE_DEV = 0.01
#: ... and moves no point of the overlap further than this.
MAX_MOVE_M = 500.0
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


def _fine_step(h: int, w: int) -> int:
    """The fine level's tile size for a grid of ``h`` x ``w``: ``TILE``, smaller on a small grid
    (``FINE_ACROSS``, ``MIN_FINE_TILE``), half the short side on a grid under two ``TILE``."""
    short = min(h, w)
    if short < 2 * TILE:
        return max(32, short // 2)
    return max(MIN_FINE_TILE, min(TILE, short // FINE_ACROSS))


def _downsample(x: np.ndarray, valid: np.ndarray, f: int) -> tuple[np.ndarray, np.ndarray]:
    """Block means of ``f`` x ``f`` cells; a block is valid when all its cells are."""
    h, w = (x.shape[0] // f) * f, (x.shape[1] // f) * f
    xs = x[:h, :w].reshape(h // f, f, w // f, f).mean(axis=(1, 3))
    vs = valid[:h, :w].reshape(h // f, f, w // f, f).all(axis=(1, 3))
    return xs, vs


def measure_line_up(
    a: np.ndarray, b: np.ndarray, valid: np.ndarray, cell: float, log: bool = True
) -> dict[str, Any]:
    """The similarity (shift, small turn and scale) that moves ``b`` onto ``a``, coarse to fine.

    A coarse level (``_coarse_level``, a power of two) finds shifts of up to ``COARSE_SEARCH_M``;
    then, with ``b`` moved by that answer, at most ``MAX_FINE_TILES`` full-resolution tiles spread
    over the overlap (``_spread_tiles``) are measured, and a similarity is fitted to their centres
    and shifts (``fit_similarity``). ``a``, ``b`` and ``valid`` as ``estimate_shift``. Returns
    ``dy``, ``dx`` (the move of the fit's centroid, rows south and columns east) and ``px``,
    ``tiles`` (tiles measured), ``spread`` (the fit's median residual), ``fit``, ``centres`` (the
    measured tiles' centres, row and column) and ``coarse`` (the factor).
    """
    a = np.asarray(a, np.float64)
    b = np.asarray(b, np.float64)
    h, w = a.shape
    f = _coarse_level(h, w, cell)
    step = _fine_step(h, w)
    dy0 = dx0 = 0
    if f > 1:
        ac, vc = _downsample(a, valid, f)
        bc, _ = _downsample(b, valid, f)
        c = estimate_shift(ac, bc, vc, log=log)
        if c["tiles"]:
            dy0, dx0 = round(c["dy"] * f), round(c["dx"] * f)
    elif step < TILE:
        # small fine tiles search less far: the shift first, with tiles of TILE px
        c = estimate_shift(a, b, valid, log=log)
        if c["tiles"]:
            dy0, dx0 = round(c["dy"]), round(c["dx"])
    ha, hb = highpass(a, log=log), highpass(b, log=log)
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
    centres: list[tuple[float, float]] = []
    shifts: list[tuple[float, float]] = []
    for r, col in _spread_tiles(found, step):
        ta = ha[r : r + step, col : col + step]
        tb = hb[r - dy0 : r - dy0 + step, col - dx0 : col - dx0 + step]
        s = _tile_shift(ta, tb)
        if s is not None:
            centres.append((r + (step - 1) / 2, col + (step - 1) / 2))
            shifts.append((s[0] + dy0, s[1] + dx0))
    if not shifts:
        out = _median_shift([], float(dy0), float(dx0))
        out["fit"] = {**_identity_fit(), "ty": float(dy0), "tx": float(dx0)}
    else:
        fit = fit_similarity(np.array(centres), np.array(shifts), shape=(h, w))
        dy, dx = fit["ty"], fit["tx"]
        out = {
            "dy": round(dy, 3),
            "dx": round(dx, 3),
            "px": round(float(np.hypot(dy, dx)), 3),
            "tiles": len(shifts),
            "spread": fit["residual"],
            "fit": fit,
        }
    out["centres"] = [[round(float(r), 3), round(float(c), 3)] for r, c in centres]
    out["coarse"] = f
    return out


def _spread_tiles(found: list[tuple[float, int, int]], step: int) -> list[tuple[int, int]]:
    """At most ``MAX_FINE_TILES`` of the candidate tiles (texture, row, column), spread over the
    overlap: the most textured in each cell of a ``SPREAD_CELLS`` square grid over the candidates,
    then the most textured of the rest."""
    if not found:
        return []
    found = sorted(found, key=lambda t: -t[0])
    rows = [r for _, r, _ in found]
    cols = [c for _, _, c in found]
    r0, c0 = min(rows), min(cols)
    hr = (max(rows) + step - r0) / SPREAD_CELLS
    hc = (max(cols) + step - c0) / SPREAD_CELLS
    best: dict[tuple[int, int], int] = {}
    for i, (_, r, c) in enumerate(found):
        key = (
            min(SPREAD_CELLS - 1, int((r + step / 2 - r0) // hr)),
            min(SPREAD_CELLS - 1, int((c + step / 2 - c0) // hc)),
        )
        best.setdefault(key, i)
    picked = sorted(best.values())[:MAX_FINE_TILES]
    chosen = set(picked)
    for i in range(len(found)):
        if len(picked) >= MAX_FINE_TILES:
            break
        if i not in chosen:
            picked.append(i)
    return [(found[i][1], found[i][2]) for i in picked]


def _turn_reach(
    a: float, b: float, c: np.ndarray, centres: np.ndarray, shape: tuple[int, int] | None
) -> float:
    """How far, px, the turn and scale part alone (``S - I`` about ``c``) moves the farthest corner
    of the overlap: the grid (``shape``) when given, else the box of the tile centres."""
    if shape is not None:
        lo, hi = np.zeros(2), np.array(shape, np.float64)
    else:
        lo, hi = centres.min(axis=0), centres.max(axis=0)
    corners = np.array([[lo[0], lo[1]], [lo[0], hi[1]], [hi[0], lo[1]], [hi[0], hi[1]]]) - c
    # (row, column) offsets u: the move is ((a-1) ux - b uy, b ux + (a-1) uy) in (x, y)
    ux, uy = corners[:, 1], corners[:, 0]
    return float(np.hypot((a - 1) * ux - b * uy, b * ux + (a - 1) * uy).max())


def _identity_fit() -> dict[str, Any]:
    return {
        "a": 1.0,
        "b": 0.0,
        "ty": 0.0,
        "tx": 0.0,
        "cy": 0.0,
        "cx": 0.0,
        "residual": 0.0,
        "inliers": 0,
        "turned": False,
    }


def fit_similarity(
    centres: np.ndarray, shifts: np.ndarray, shape: tuple[int, int] | None = None
) -> dict[str, Any]:
    """A similarity fitted, robustly, to tile ``shifts`` (dy, dx) measured at tile ``centres``
    (row, column), both in grid pixels: the map ``p = c + S (q - c) + t`` that takes a tile's
    content in ``b`` (at ``q = p - shift``) to where it sits in ``a`` (at ``p``).

    In (column x, row y) ``S`` is ``[[a, -b], [b, a]]``: with rows running south, a positive ``b``
    turns clockwise as seen on the ground. ``t`` is (``ty``, ``tx``), the move of the centroid
    ``c`` (``cy``, ``cx``) of the inlier centres. Least squares, then up to ``FIT_ROUNDS`` rounds
    leave out tiles whose residual exceeds ``max(3 * 1.4826 * MAD, 0.5)`` px, the MAD being the
    median of the residuals (their absolute deviation from the fit), and refit.

    When the inlier centres span less than a third of the grid (``shape``, rows and columns) on
    either axis, the turn and scale can't be trusted: the shift alone is fitted (their median) and
    ``turned`` is false. So it is when the fitted turn and scale alone move no corner of the
    overlap by more than ``TURN_MIN_PX``: the shift is then their median. Returns ``a``, ``b``, ``ty``, ``tx``, ``cy``, ``cx``, ``residual`` (the
    median residual of the inliers, px), ``inliers`` and ``turned``.
    """
    p = np.asarray(centres, np.float64).reshape(-1, 2)
    d = np.asarray(shifts, np.float64).reshape(-1, 2)
    if len(p) == 0:
        return _identity_fit()
    q = p - d

    def turnable(mask: np.ndarray) -> bool:
        if mask.sum() < 3:
            return False
        if shape is None:
            return True
        span = p[mask].max(axis=0) - p[mask].min(axis=0)
        return bool(span[0] >= shape[0] / 3 and span[1] >= shape[1] / 3)

    def solve(mask: np.ndarray) -> tuple[float, float, float, float, np.ndarray, bool]:
        c = p[mask].mean(axis=0)
        if not turnable(mask):
            t = np.median(d[mask], axis=0)
            return 1.0, 0.0, float(t[0]), float(t[1]), c, False
        u = q[mask] - c
        m = int(mask.sum())
        A = np.zeros((2 * m, 4))
        y = np.zeros(2 * m)
        # x' - cx = a ux - b uy + tx ; y' - cy = b ux + a uy + ty  (unknowns a, b, ty, tx)
        A[:m] = np.column_stack([u[:, 1], -u[:, 0], np.zeros(m), np.ones(m)])
        y[:m] = p[mask, 1] - c[1]
        A[m:] = np.column_stack([u[:, 0], u[:, 1], np.ones(m), np.zeros(m)])
        y[m:] = p[mask, 0] - c[0]
        sol = np.linalg.lstsq(A, y, rcond=None)[0]
        return float(sol[0]), float(sol[1]), float(sol[2]), float(sol[3]), c, True

    def residuals(a: float, b: float, ty: float, tx: float, c: np.ndarray) -> np.ndarray:
        u = q - c
        px = c[1] + a * u[:, 1] - b * u[:, 0] + tx
        py = c[0] + b * u[:, 1] + a * u[:, 0] + ty
        return np.hypot(px - p[:, 1], py - p[:, 0])

    mask = np.ones(len(p), bool)
    a, b, ty, tx, c, turned = solve(mask)
    for _ in range(FIT_ROUNDS):
        r = residuals(a, b, ty, tx, c)
        limit = max(3 * 1.4826 * float(np.median(r[mask])), 0.5)
        keep = r <= limit
        if keep.sum() < 2 or (keep == mask).all():
            break
        mask = keep
        a, b, ty, tx, c, turned = solve(mask)
    if turned and _turn_reach(a, b, c, p[mask], shape) <= TURN_MIN_PX:
        # the turn and scale move no corner of the overlap by half a pixel: noise on a plain
        # shift, which is reported as the shift alone (the median, as for clustered tiles)
        t = np.median(d[mask], axis=0)
        a, b, ty, tx, turned = 1.0, 0.0, float(t[0]), float(t[1]), False
    r = residuals(a, b, ty, tx, c)
    return {
        "a": round(a, 9),
        "b": round(b, 9),
        "ty": round(ty, 4),
        "tx": round(tx, 4),
        "cy": round(float(c[0]), 3),
        "cx": round(float(c[1]), 3),
        "residual": round(float(np.median(r[mask])), 3),
        "inliers": int(mask.sum()),
        "turned": turned,
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
