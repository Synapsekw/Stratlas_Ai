"""Compose and fill of ``pano.stitch`` (spec section 2; P0 findings, 13 Oct 2026).

Every frame is warped onto the equirect canvas as one piece, or two when it crosses the 180 degree
meridian, or the full width when it holds a pole. Exposure is evened with OpenCV's ``GAIN``
compensator and seams are found by dynamic programming on colour and gradient, both on a small
copy; a multi-band blender writes the canvas. A full sphere's sky above the top row is a heavily
smoothed gradient, written strip by strip so a 16K canvas never has a float copy; a wide panorama
is cropped to what it covers instead.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass

import cv2
import numpy as np

from .geometry import equirect_dirs, principal

#: Frames are scaled to this many times the canvas's pixels per degree (P0: 1.4).
COMPOSE_OVERSAMPLE = 1.4
#: Footprints are found on a grid of this many canvas pixels.
FOOTPRINT_STEP = 8
#: Canvas rows warped at a time (bounds the float32 ray buffer).
WARP_STRIP_ROWS = 512
#: Seams and exposure gains are found on a copy at this scale (P0: 0.25 up to 8K, 0.125 above).
SEAM_SCALE_8K = 0.25
SEAM_SCALE_16K = 0.125
#: Sky fill: rows sampled under the top edge per 8192 px of width, and the box blur width as a
#: share of the canvas width (P0: a heavy blur, or the fill streaks).
FILL_BAND_PER_8K = 12
FILL_BLUR_SHARE = 1 / 12
#: The zenith is this much brighter than the mean top edge colour.
ZENITH_GAIN = 1.05
#: The fill fades into the image over this many degrees of latitude below the top edge.
FILL_FEATHER_DEG = 4.0
#: Pixels of sky computed at a time (bounds the float32 work arrays).
FILL_STRIP_PIXELS = 1 << 17
#: A canvas whose covered columns are fewer than this share is a wide panorama.
FULL_COVERAGE_SHARE = 0.995
THUMB_SIZE = (512, 256)


@dataclass
class Piece:
    image: np.ndarray  # (h, w, 3) uint8
    mask: np.ndarray  # (h, w) uint8
    corner: tuple[int, int]  # (x, y) on the canvas


def frame_scale(focal: float, canvas_width: int) -> float:
    """How much to shrink a frame for a canvas: its pixels per degree to 1.4 times the canvas's."""
    ppd_canvas = canvas_width / 360.0
    ppd_frame = focal * math.pi / 180.0
    return min(1.0, COMPOSE_OVERSAMPLE * ppd_canvas / ppd_frame)


def _project(d: np.ndarray, rot: np.ndarray, f: float, w: int, h: int, margin: float):
    q = d @ rot.astype(np.float32)  # R^T d per ray
    z = q[..., 2]
    cx, cy = principal(w, h)
    with np.errstate(divide="ignore", invalid="ignore"):
        u = f * q[..., 0] / z + cx
        v = f * q[..., 1] / z + cy
    ok = (z > 1e-6) & (u >= -margin) & (u <= w - 1 + margin) & (v >= -margin) & (v <= h - 1 + margin)
    return u.astype(np.float32), v.astype(np.float32), ok


def footprint(rot: np.ndarray, f: float, w: int, h: int, cw: int, ch: int) -> list[tuple[int, int, int, int]]:
    """Canvas boxes (x0, y0, x1, y1) a frame lands in: one, two across the wrap, or full width."""
    s = FOOTPRINT_STEP
    gw, gh = math.ceil(cw / s), math.ceil(ch / s)
    d = equirect_dirs(gw, gh, 0, 0, gw, gh)
    _, _, ok = _project(d, rot, f, w, h, margin=2 * s)
    if not ok.any():
        return []
    rows = np.where(ok.any(axis=1))[0]
    y0, y1 = max(0, rows.min() * s - 2 * s), min(ch, rows.max() * s + 3 * s)
    cols = ok.any(axis=0)
    if cols.all() or ok[0].any() or ok[-1].any():
        return [(0, y0, cw, y1)]
    if cols[0] and cols[-1]:
        gap = np.where(~cols)[0]
        return [(0, y0, min(cw, gap.min() * s + s), y1), (max(0, gap.max() * s), y0, cw, y1)]
    idx = np.where(cols)[0]
    return [(max(0, idx.min() * s - 2 * s), y0, min(cw, idx.max() * s + 3 * s), y1)]


def warp(img: np.ndarray, rot: np.ndarray, f: float, cw: int, ch: int) -> list[Piece]:
    """The pieces of one frame on a cw x ch canvas."""
    h, w = img.shape[:2]
    out = []
    for x0, y0, x1, y1 in footprint(rot, f, w, h, cw, ch):
        mx = np.empty((y1 - y0, x1 - x0), np.float32)
        my = np.empty_like(mx)
        for r0 in range(y0, y1, WARP_STRIP_ROWS):
            r1 = min(y1, r0 + WARP_STRIP_ROWS)
            u, v, ok = _project(equirect_dirs(cw, ch, x0, r0, x1, r1), rot, f, w, h, margin=-1)
            u[~ok] = -1
            v[~ok] = -1
            mx[r0 - y0 : r1 - y0], my[r0 - y0 : r1 - y0] = u, v
        valid = (mx >= 0).astype(np.uint8) * 255
        valid = cv2.erode(valid, np.ones((3, 3), np.uint8))
        if not valid.any():
            continue
        piece = cv2.remap(img, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
        out.append(Piece(piece, valid, (x0, y0)))
    return out


def seam_scale(width: int) -> float:
    return SEAM_SCALE_8K if width <= 8192 else SEAM_SCALE_16K


def wrap_pad(width: int) -> int:
    """Columns copied across the 180 degree meridian on each side, so the blend sees the canvas
    as the closed ring it is and its two edges meet without a step."""
    return max(32, width // 32)


def _wrapped(pieces: list[Piece], cw: int, pad: int) -> list[Piece]:
    """Pieces on a canvas widened by `pad` on both sides, with copies of those near an edge."""
    out = []
    for p in pieces:
        x, y = p.corner
        w = p.image.shape[1]
        out.append(Piece(p.image, p.mask, (x + pad, y)))
        if x < pad:
            out.append(Piece(p.image, p.mask, (x + cw + pad, y)))
        if x + w > cw - pad:
            out.append(Piece(p.image, p.mask, (x - cw + pad, y)))
    return [q for q in out if q.corner[0] + q.image.shape[1] > 0 and q.corner[0] < cw + 2 * pad]


def blend(pieces: list[Piece], cw: int, ch: int, check: Callable[[], None] = lambda: None):
    """Exposure, seams and the multi-band blend: the canvas (uint8) and its coverage mask."""
    pad = wrap_pad(cw)
    pieces = [_clip(p, cw + 2 * pad) for p in _wrapped(pieces, cw, pad)]
    full_w = cw + 2 * pad
    ss = seam_scale(cw)
    small = [cv2.resize(p.image, None, fx=ss, fy=ss, interpolation=cv2.INTER_AREA) for p in pieces]
    smask = [
        cv2.resize(p.mask, (s.shape[1], s.shape[0]), interpolation=cv2.INTER_NEAREST)
        for p, s in zip(pieces, small, strict=True)
    ]
    scorn = [(round(p.corner[0] * ss), round(p.corner[1] * ss)) for p in pieces]
    comp = cv2.detail.ExposureCompensator_createDefault(cv2.detail.ExposureCompensator_GAIN)
    comp.feed(corners=scorn, images=[cv2.UMat(s) for s in small], masks=[cv2.UMat(m) for m in smask])
    check()
    seams = cv2.detail_DpSeamFinder("COLOR_GRAD").find(
        [cv2.UMat(s.astype(np.float32)) for s in small], scorn, [cv2.UMat(m) for m in smask]
    )
    check()
    blender = cv2.detail_MultiBandBlender()
    blender.setNumBands(max(1, int(math.log2(max(cw / 8, 1)) - 4)))
    blender.prepare((0, 0, full_w, ch))
    for k, p in enumerate(pieces):
        check()
        # a copy: the wrap duplicates share their image, and apply writes into it
        img = comp.apply(k, p.corner, p.image.copy(), p.mask)
        sm = seams[k].get() if isinstance(seams[k], cv2.UMat) else seams[k]
        # dilate at seam scale, as OpenCV's stitcher does, so neighbours still meet after the resize
        sm = cv2.dilate(sm, np.ones((3, 3), np.uint8))
        sm = cv2.resize(sm, (p.mask.shape[1], p.mask.shape[0]), interpolation=cv2.INTER_LINEAR)
        blender.feed(np.asarray(img).astype(np.int16), cv2.bitwise_and(sm, p.mask), p.corner)
    res, mask = blender.blend(None, None)
    res = res.get() if isinstance(res, cv2.UMat) else res
    mask = mask.get() if isinstance(mask, cv2.UMat) else mask
    pano = np.clip(res[:, pad : pad + cw], 0, 255).astype(np.uint8)
    return pano, np.ascontiguousarray(mask[:, pad : pad + cw])


def _clip(p: Piece, width: int) -> Piece:
    """A piece cut to the canvas columns [0, width)."""
    x, y = p.corner
    a = max(0, -x)
    b = min(p.image.shape[1], width - x)
    if a == 0 and b == p.image.shape[1]:
        return p
    return Piece(p.image[:, a:b], p.mask[:, a:b], (x + a, y))


def _edges(covered: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    any_col = covered.any(axis=0)
    h = covered.shape[0]
    top = np.where(any_col, covered.argmax(axis=0), h // 2)
    bottom = np.where(any_col, h - 1 - covered[::-1].argmax(axis=0), h // 2)
    return any_col, top, bottom


def coverage_deg(covered: np.ndarray) -> tuple[float, float]:
    """Degrees above and below the horizon that real pixels reach (median over covered columns)."""
    any_col, top, bottom = _edges(covered > 0)
    h = covered.shape[0]
    if not any_col.any():
        return 0.0, 0.0
    t = float(np.median(top[any_col]))
    b = float(np.median(bottom[any_col]))
    return round(90 - (t + 0.5) / h * 180, 2), round((b + 0.5) / h * 180 - 90, 2)


def fill_sky(pano: np.ndarray, covered: np.ndarray) -> None:
    """In place: above each column's top edge, a gradient from a heavily smoothed edge colour to a
    zenith colour; holes below the top edge take a blurred copy of their surroundings."""
    h, w = covered.shape
    cov = covered > 0
    any_col, top, _ = _edges(cov)
    if not any_col.any():
        return
    band = FILL_BAND_PER_8K * w // 8192 + 4
    edge = np.empty((w, 3), np.float32)
    for x in range(w):
        t = int(top[x])
        edge[x] = np.median(pano[t : t + band, x], axis=0) if any_col[x] else np.nan
    edge[~any_col] = np.nanmean(edge[any_col], axis=0)
    k = int(w * FILL_BLUR_SHARE) // 2 * 2 + 1
    padded = np.concatenate([edge[-k:], edge, edge[:k]])
    edge = cv2.blur(padded[None], (k, 1))[0][k:-k]
    zenith = edge.mean(axis=0) * ZENITH_GAIN
    topf = np.maximum(top.astype(np.float32), 1.0)
    step = max(1, FILL_STRIP_PIXELS // w)
    span = (edge - zenith[None]).astype(np.float32)
    feather = max(1.0, FILL_FEATHER_DEG / 180 * h)
    for r0 in range(0, min(h, int(top.max() + feather) + 1), step):
        r1 = min(h, r0 + step)
        yy = np.arange(r0, r1, dtype=np.float32)[:, None]
        a = np.clip(yy / topf[None], 0, 1)
        sky = a[..., None] * span[None]
        sky += zenith
        np.clip(sky, 0, 255, out=sky)
        # 1 above the top edge, fading to 0 over the feather band below it
        wgt = np.clip(1 - (yy - top[None]) / feather, 0, 1)
        wgt[(yy >= top[None]) & ~any_col[None]] = 0
        sel = wgt > 0
        cur = pano[r0:r1][sel].astype(np.float32)
        w1 = wgt[sel][:, None]
        pano[r0:r1][sel] = np.rint(sky[sel] * w1 + cur * (1 - w1)).astype(np.uint8)
    _fill_holes(pano, cov, top)


def _fill_holes(pano: np.ndarray, cov: np.ndarray, top: np.ndarray) -> None:
    """Uncovered pixels below the top edge take a blurred copy of their surroundings."""
    h, w = cov.shape
    holes = ~cov
    holes[np.arange(h)[:, None] < top[None]] = False
    if holes.any():
        small = cv2.resize(pano, (max(1, w // 16), max(1, h // 16)), interpolation=cv2.INTER_AREA)
        smask = cv2.resize(
            holes.astype(np.uint8) * 255, (small.shape[1], small.shape[0]), interpolation=cv2.INTER_NEAREST
        )
        small = cv2.inpaint(small, smask, 3, cv2.INPAINT_TELEA)
        up = cv2.resize(small, (w, h), interpolation=cv2.INTER_LINEAR)
        pano[holes] = up[holes]


def fill_wide(pano: np.ndarray, covered: np.ndarray) -> None:
    """In place: a wide panorama's uncovered corners take a blurred copy of their surroundings."""
    cov = covered > 0
    _fill_holes(pano, cov, np.zeros(cov.shape[1], np.int64))


def wide_crop(covered: np.ndarray) -> tuple[int, int, int, int] | None:
    """For a canvas whose horizon band (30 degrees either side) is not covered all round: the
    shift that brings the covered run of columns to the left edge, and the box (shift, top,
    bottom, width) to keep after it; None for a full sphere. The nadir frame covers every column
    near the bottom, so only the band decides."""
    cov = covered > 0
    h = cov.shape[0]
    cols = cov[h // 3 : 2 * h // 3].any(axis=0)
    if cols.mean() >= FULL_COVERAGE_SHARE:
        return None
    w = cols.size
    # start of the longest circular run of covered columns
    doubled = np.concatenate([cols, cols])
    best_len, best_start, run = 0, 0, 0
    for i, c in enumerate(doubled):
        run = run + 1 if c else 0
        if run > best_len:
            best_len, best_start = run, i - run + 1
    best_len = min(best_len, w)
    shift = best_start % w
    kept = np.roll(cov, -shift, axis=1)[:, :best_len]
    _, top, bottom = _edges(kept)
    return shift, int(np.median(top)), int(np.median(bottom)) + 1, best_len


def apply_wide_crop(img: np.ndarray, crop: tuple[int, int, int, int]) -> np.ndarray:
    shift, y0, y1, width = crop
    rolled = np.roll(img, -shift, axis=1)
    return np.ascontiguousarray(rolled[y0:y1, :width])


def yaw_range_deg(crop: tuple[int, int, int, int], canvas_width: int) -> tuple[float, float]:
    """Yaw (clockwise from north) of a wide crop's left and right edges."""
    shift, _, _, width = crop
    left = shift / canvas_width * 360 - 180
    return round(left, 3), round(left + width / canvas_width * 360, 3)


def lat_range_deg(crop: tuple[int, int, int, int], canvas_height: int) -> tuple[float, float]:
    """Degrees above (top) and below (bottom) the horizon of a wide crop's edges."""
    _, y0, y1, _ = crop
    return round(90 - y0 / canvas_height * 180, 3), round(y1 / canvas_height * 180 - 90, 3)


def thumbnail(img: np.ndarray) -> np.ndarray:
    return cv2.resize(img, THUMB_SIZE, interpolation=cv2.INTER_AREA)
