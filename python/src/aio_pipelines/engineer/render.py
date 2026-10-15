"""Evidence images from a cloud: orthographic splats, a plan view of one slice, detail crops and a
colour summary. Numpy z-buffer and Pillow only; every image is square (at most `px` wide) and is
written atomically. Views name the side the camera stands on and look at the asset: `north` sees
the north face (east is on the left), `east` the east face (north on the right), `top` is a plan
with north up.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any, Literal

import numpy as np
from PIL import Image, ImageDraw

from ..runtime import replace_over
from .axis import Axis
from .members import MemberGroup
from .sections import Taper

View = Literal["north", "east", "south", "west", "top"]
BACKGROUND = 255
MARGIN = 0.04


def _project(xyz: np.ndarray, view: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(u right, v down, near) of each point for a view; larger `near` is closer to the camera."""
    x, y, z = xyz[:, 0], xyz[:, 1], xyz[:, 2]
    if view == "north":
        return -x, -y, -z
    if view == "south":
        return x, -y, z
    if view == "east":
        return -z, -y, x
    if view == "west":
        return z, -y, -x
    if view == "top":
        return x, z, y
    raise ValueError(f"unknown view {view!r}")


def render_ortho(xyz: np.ndarray, rgb: np.ndarray | None, view: View, px: int) -> Image.Image:
    """A `px` by `px` orthographic image of the points: 2 px splats, nearest point wins, scaled to
    fit the longer side. With `rgb` (uint8, or 16-bit as LAS stores it) the points keep their
    colour, otherwise they are shaded by depth (near dark, far light) on white."""
    px = int(px)
    img = np.full((px, px, 3), BACKGROUND, dtype=np.uint8)
    if len(xyz) == 0:
        return Image.fromarray(img, "RGB")
    u, v, near = _project(np.asarray(xyz, dtype=np.float64), view)
    ext = max(float(np.ptp(u)), float(np.ptp(v)), 1e-9)
    s = px * (1 - 2 * MARGIN) / ext
    col = ((u - (u.min() + u.max()) / 2) * s + px / 2).astype(np.int64)
    row = ((v - (v.min() + v.max()) / 2) * s + px / 2).astype(np.int64)
    if rgb is not None:
        c = np.asarray(rgb)
        if c.dtype != np.uint8:
            c = (c >> 8).astype(np.uint8) if c.max() > 255 else c.astype(np.uint8)
    else:
        t = (near - near.min()) / max(float(np.ptp(near)), 1e-9)
        c = np.repeat((30 + 150 * (1 - t)).astype(np.uint8)[:, None], 3, axis=1)
    order = np.argsort(near, kind="stable")  # far first, so the nearest is written last
    col, row, c = col[order], row[order], c[order]
    for dc in (0, 1):
        for dr in (0, 1):
            cc, rr = col + dc, row + dr
            ok = (cc >= 0) & (cc < px) & (rr >= 0) & (rr < px)
            img[rr[ok], cc[ok]] = c[ok]
    return Image.fromarray(img, "RGB")


def render_slice(slice_points: np.ndarray, fit: Any, px: int) -> Image.Image:
    """A plan view of one slice: its points as dark dots and the fitted circle (`fit.centre` local
    x, z and `fit.r`) in red, scaled so the circle and the points fit."""
    px = int(px)
    im = Image.new("RGB", (px, px), (BACKGROUND,) * 3)
    d = ImageDraw.Draw(im)
    cx, cz = fit.centre
    half = max(float(fit.r) * 1.25, 1e-6)
    if len(slice_points):
        half = max(half, float(np.abs(slice_points[:, [0, 2]] - [cx, cz]).max()) * 1.05)
    s = px / 2 / half

    def at(x: float, z: float) -> tuple[float, float]:
        return (x - cx) * s + px / 2, (z - cz) * s + px / 2

    for x, z in np.asarray(slice_points)[:, [0, 2]] if len(slice_points) else []:
        a, b = at(float(x), float(z))
        d.rectangle([a - 1, b - 1, a + 1, b + 1], fill=(40, 40, 40))
    a, b = at(cx - fit.r, cz - fit.r)
    e, f = at(cx + fit.r, cz + fit.r)
    d.ellipse([a, b, e, f], outline=(200, 30, 30), width=2)
    m = px / 2
    d.line([m - 6, m, m + 6, m], fill=(200, 30, 30))
    d.line([m, m - 6, m, m + 6], fill=(200, 30, 30))
    return im


def crop_views(
    xyz: np.ndarray,
    axis: Axis,
    taper: Taper,
    members: list[MemberGroup],
    px: int,
    rgb: np.ndarray | None = None,
) -> list[tuple[str, Image.Image]]:
    """Detail crops: `crown` (plan of the top 8 percent), `base` (south side view of the lowest
    8 percent) and one plan view for each light level (a 3 m band). Names are stable."""
    if len(xyz) == 0:
        return []
    _, _, h = axis.to_frame(xyz)
    top = float(h.max())
    band = max(0.08 * top, 2.0)
    out: list[tuple[str, Image.Image]] = []

    def pick(mask: np.ndarray, view: View) -> Image.Image:
        return render_ortho(xyz[mask], None if rgb is None else rgb[mask], view, px)

    out.append(("crown", pick(h > top - band, "top")))
    out.append(("base", pick(h < band, "south")))
    levels = sorted({lv for g in members if g.kind == "light-candidate" for lv in g.levels})
    for i, lv in enumerate(levels, 1):
        sel = np.abs(h - lv) <= 1.5
        if sel.sum() > 20:
            out.append((f"level-{i}", pick(sel, "top")))
    return out


def colour_bands(
    xyz: np.ndarray, rgb: np.ndarray | None, axis: Axis, step: float, tolerance: float = 30.0
) -> list[dict[str, Any]]:
    """The median colour per `step` metres of height above the base, adjacent bands whose colours
    are within `tolerance` (RGB distance) merged. `[{y0, y1, rgb}]`, 8-bit channels."""
    if rgb is None or len(xyz) == 0 or step <= 0:
        return []
    c = np.asarray(rgb)
    if c.dtype != np.uint8:
        c = (c >> 8).astype(np.uint8) if c.max() > 255 else c.astype(np.uint8)
    _, _, h = axis.to_frame(xyz)
    top = float(h.max())
    bands: list[dict[str, Any]] = []
    for i in range(int(top // step) + 1):
        y0, y1 = i * step, min((i + 1) * step, top)
        sel = (h >= y0) & (h < y1 + (1e-9 if i == int(top // step) else 0))
        if sel.sum() < 20:
            continue
        med = [int(v) for v in np.median(c[sel], axis=0)]
        last = bands[-1] if bands else None
        if (
            last
            and abs(last["y1"] - y0) < 1e-6
            and float(np.linalg.norm(np.subtract(last["rgb"], med))) <= tolerance
        ):
            n = last["_n"]
            last["rgb"] = [round((a * n + b) / (n + 1)) for a, b in zip(last["rgb"], med, strict=True)]
            last["y1"], last["_n"] = float(y1), n + 1
        else:
            bands.append({"y0": float(y0), "y1": float(y1), "rgb": med, "_n": 1})
    for b in bands:
        del b["_n"]
    return bands[:64]


def write_png(image: Image.Image, path: Path) -> Path:
    """Write a PNG atomically (a temp file in the same folder, then a rename)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    image.save(tmp, format="PNG")
    replace_over(tmp, path)
    return path


def write_images(
    images: list[tuple[str, str, str, Image.Image]],
    out_dir: Path,
    rel_dir: str,
    max_images: int,
    max_px: int,
) -> list[dict[str, Any]]:
    """Write `(id, kind, view, image)` entries as PNG files in `out_dir`, at most `max_images` of
    them (the first ones) and none wider than `max_px`; returns the pack's `EvidenceImage` dicts
    (`file` is `rel_dir/<id>.png`)."""
    out: list[dict[str, Any]] = []
    for ident, kind, view, im in images[: max(0, int(max_images))]:
        if max(im.size) > max_px:
            im = im.copy()
            im.thumbnail((max_px, max_px), Image.LANCZOS)
        path = write_png(im, out_dir / f"{ident}.png")
        data = path.read_bytes()
        out.append(
            {
                "id": ident,
                "file": f"{rel_dir}/{ident}.png",
                "kind": kind,
                "view": view,
                "w": im.width,
                "h": im.height,
                "bytes": len(data),
                "sha1": hashlib.sha1(data).hexdigest(),
            }
        )
    return out
