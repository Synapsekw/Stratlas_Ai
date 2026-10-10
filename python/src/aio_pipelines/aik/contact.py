"""Contact sheets and zoom views for a visual detection pass by a person or a vision model.

Ported from Asset Inspection Kit ``kit/contact.py`` (sheets, grid, crop) and the DAMAC job's
``tools/sheetpx.py`` (a box drawn on a sheet -> review-copy pixels of the photo under it):

  sheets  photos tiled 4 across, ``per`` to a sheet, ``width`` px wide, photo ids burned in
  grid    a review copy with a 10 x 10 pixel-coordinate grid, to read off box coordinates
  crop    a zoom crop in review-copy pixels
  sheet_to_photo  sheet pixels -> (photo, review-copy bbox), using the layout ``sheets`` returns

The layout and drawing maths are the kit's; what changed is that sheets take a photo list and an
output folder (instead of a job.yaml), skip sheets already written (resume), report each cell's
rectangle (the kit's DAMAC ``sheet_layout.json``) and call ``check`` / ``progress`` hooks.
"""

from __future__ import annotations

import math
import os
from collections.abc import Callable
from typing import Any

from PIL import Image, ImageDraw, ImageFont

from ..runtime import replace_over


def _font(n):
    for name in ("DejaVuSans-Bold.ttf", "arialbd.ttf", "Arial Bold.ttf"):
        try:
            return ImageFont.truetype(name, n)
        except OSError:
            continue
    return ImageFont.load_default()


def _thumb_size(w: int, h: int, bw: int, bh: int) -> tuple[int, int]:
    """The size ``Image.thumbnail((bw, bh))`` gives a ``w`` x ``h`` image (Pillow's rounding)."""
    if bw >= w and bh >= h:
        return w, h
    aspect = w / h
    x, y = bw, bh

    def round_aspect(number, key):
        return max(min(math.floor(number), math.ceil(number), key=key), 1)

    if x / y >= aspect:
        x = round_aspect(y * aspect, key=lambda n: abs(aspect - n / y))
    else:
        y = round_aspect(x / aspect, key=lambda n: 0 if n == 0 else abs(aspect - x / n))
    return x, y


def sheet_layout(photos: list[dict[str, Any]], per=12, width=1800) -> list[dict[str, Any]]:
    """Where each photo goes: sheets of ``per`` cells, 4 columns, cells 2:3 (the kit's grid).

    ``photos`` items need ``id`` and the review-copy size ``pw``, ``ph``. A cell's ``x, y, w, h``
    is the pasted thumbnail (the kit's ``thumbnail(tw - 4, th - 4)`` at ``x + 2, y + 2``).
    """
    cols = 4
    rows = math.ceil(per / cols)
    tw = width // cols
    th = int(tw * 2 / 3)
    out = []
    for n, s in enumerate(range(0, len(photos), per)):
        cells = []
        for k, p in enumerate(photos[s : s + per]):
            x, y = (k % cols) * tw, (k // cols) * th
            w, h = _thumb_size(p["pw"], p["ph"], tw - 4, th - 4)
            cells.append({**p, "x": x + 2, "y": y + 2, "w": w, "h": h})
        out.append({"name": f"sheet-{n:02d}", "size": [cols * tw, rows * th], "cells": cells})
    return out


def sheets(
    layout: list[dict[str, Any]],
    out_dir: str,
    check: Callable[[], None] = lambda: None,
    progress: Callable[[float, str | None], None] = lambda f, m=None: None,
) -> list[str]:
    """Draw the sheets of ``layout`` (cells carry ``path``, the review copy) into ``out_dir``."""
    os.makedirs(out_dir, exist_ok=True)
    written = []
    for i, sheet in enumerate(layout):
        check()
        fn = os.path.join(out_dir, sheet["name"] + ".jpg")
        written.append(fn)
        if os.path.exists(fn):
            progress((i + 1) / len(layout), sheet["name"])
            continue
        sh = Image.new("RGB", tuple(sheet["size"]), (20, 20, 20))
        d = ImageDraw.Draw(sh)
        f = _font(22)
        for c in sheet["cells"]:
            with Image.open(c["path"]) as src:
                src.draft("RGB", (c["w"], c["h"]))
                im = src.convert("RGB")
            im.thumbnail((c["w"], c["h"]))
            if im.size != (c["w"], c["h"]):  # draft decoding can shift the rounding by a pixel
                im = im.resize((c["w"], c["h"]), Image.LANCZOS)
            sh.paste(im, (c["x"], c["y"]))
            label = c["id"]
            d.rectangle((c["x"], c["y"], c["x"] + 12 * len(label) + 16, c["y"] + 28), fill=(0, 0, 0))
            d.text((c["x"] + 6, c["y"] + 2), label, fill=(255, 220, 0), font=f)
        tmp = fn + ".partial.jpg"
        sh.save(tmp, quality=80)
        replace_over(tmp, fn)
        progress((i + 1) / len(layout), sheet["name"])
    return written


def grid(src: str, out: str) -> tuple[int, int]:
    """A review copy with a 10 x 10 grid labelled in pixels (the kit's ``grid`` command)."""
    im = Image.open(src).convert("RGB")
    W, H = im.size
    d = ImageDraw.Draw(im)
    f = _font(max(14, W // 90))
    for i in range(1, 10):
        x = W * i // 10
        y = H * i // 10
        d.line((x, 0, x, H), fill=(255, 255, 0), width=1)
        d.line((0, y, W, y), fill=(255, 255, 0), width=1)
        d.text((x + 3, 3), str(x), fill=(255, 255, 0), font=f)
        d.text((3, y + 3), str(y), fill=(255, 255, 0), font=f)
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    im.save(out, quality=82)
    return W, H


def crop(src: str, box, out: str) -> None:
    """A zoom crop in review-copy pixels, at most 1400 px (the kit's ``crop`` command)."""
    im = Image.open(src).convert("RGB")
    x0, y0, x1, y1 = (int(v) for v in box)
    c = im.crop((x0, y0, x1, y1))
    c.thumbnail((1400, 1400))
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    c.save(out, quality=85)


def sheet_to_photo(sheet: dict[str, Any], box, points=None) -> dict[str, Any] | None:
    """A box drawn on a sheet in review-copy pixels of the photo under its centre (DAMAC ``sheetpx.py``).

    Returns ``{"image": id, "bbox": [...], "size": [pw, ph]}`` (plus ``polygon`` for extra points),
    or None when the box centre is not on a photo.
    """
    x0, y0, x1, y1 = (float(v) for v in box)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    cell = next(
        (c for c in sheet["cells"] if c["x"] <= cx <= c["x"] + c["w"] and c["y"] <= cy <= c["y"] + c["h"]),
        None,
    )
    if not cell:
        return None
    sx = cell["pw"] / cell["w"]
    sy = cell["ph"] / cell["h"]

    def f(x, y):
        return [
            round(min(max((x - cell["x"]) * sx, 0), cell["pw"]), 1),
            round(min(max((y - cell["y"]) * sy, 0), cell["ph"]), 1),
        ]

    a = f(x0, y0)
    b = f(x1, y1)
    out: dict[str, Any] = {
        "image": cell["id"],
        "bbox": [a[0], a[1], b[0], b[1]],
        "size": [cell["pw"], cell["ph"]],
    }
    if points:
        out["polygon"] = [f(*p) for p in points]
    return out
