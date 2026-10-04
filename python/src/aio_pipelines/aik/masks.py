"""Class-index masks: statistics and coloured overlays. Ported from Asset Inspection Kit ``kit/masks.py``."""

from __future__ import annotations

import numpy as np
from PIL import Image


def load(path):
    with Image.open(path) as im:
        if im.mode not in ("L", "P"):
            im = im.convert("L")
        return np.array(im)


def hex_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))


def class_sets(profile):
    fin = [c["id"] for c in profile["classes"] if not c.get("uncertain")]
    unc = [c["id"] for c in profile["classes"] if c.get("uncertain")]
    return fin, unc


def stats(arr, profile):
    fin, unc = class_sets(profile)
    n = arr.size
    counts = np.bincount(arr.ravel(), minlength=256)
    f = int(sum(counts[i] for i in fin))
    u = int(sum(counts[i] for i in unc))
    ys, xs = np.nonzero(np.isin(arr, fin))
    bbox = [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1] if len(xs) else None
    sev = 0
    for c in profile["classes"]:
        if c.get("severity") and counts[c["id"]] > 0:
            sev = max(sev, c["severity"])
    return {
        "coverage": 100.0 * f / n,
        "uncertain": 100.0 * u / n,
        "bbox": bbox,
        "mask_severity": sev,
        "counts": {int(i): int(counts[i]) for i in np.nonzero(counts)[0]},
        "width": arr.shape[1],
        "height": arr.shape[0],
    }


def overlay(arr, profile, uncertain=False, alpha=255):
    """RGBA overlay of the finding (or uncertain) classes; transparent elsewhere."""
    rgba = np.zeros((*arr.shape, 4), np.uint8)
    for c in profile["classes"]:
        if bool(c.get("uncertain")) != uncertain:
            continue
        m = arr == c["id"]
        if not m.any():
            continue
        rgba[m, :3] = hex_rgb(c.get("color", "#ff7a2d"))
        rgba[m, 3] = alpha
    return Image.fromarray(rgba, "RGBA")


def region_coverage(arr, profile, bbox):
    fin, _ = class_sets(profile)
    x0, y0, x1, y1 = (int(v) for v in bbox)
    sub = arr[max(0, y0) : y1, max(0, x0) : x1]
    return 100.0 * float(np.isin(sub, fin).sum()) / arr.size
