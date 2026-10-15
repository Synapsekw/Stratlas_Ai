"""The cleanup recipe over many points, in world coordinates (project CRS), with numpy. The same
rules as the viewer (packages/pointcloud/src/cleanup/evaluate.ts), pinned by the shared vectors.

Per point, in order: the starting class (the noise copy's when there is one; the caller passes
it); the regions (``w > 0`` and inside the NDC polygon: ``class`` sets the class, later regions
win; ``hide`` and ``delete`` marks accumulate, so a delete is never undone by a later hide);
outside the clip box (inside, for ``keep: outside``) or outside the height range: dropped, with
box faces and height bounds counting as inside; a hidden class: class-hidden. One outcome, the
highest code: dropped > deleted > class-hidden > hidden > kept.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

KEPT, HIDDEN, CLASS_HIDDEN, DELETED, DROPPED = 0, 1, 2, 3, 4
STATE_NAMES = ("kept", "hidden", "classHidden", "deleted", "dropped")


def in_polygon(ring: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Even-odd rule, edge by edge over all points (the TS loop pairs each vertex with the one before)."""
    inside = np.zeros(x.shape, dtype=bool)
    xj, yj = ring[-1]
    for xi, yi in ring:
        crosses = (yi > y) != (yj > y)
        with np.errstate(divide="ignore", invalid="ignore"):
            at = (xj - xi) * (y - yi) / (yj - yi) + xi
        inside ^= crosses & (x < at)
        xj, yj = xi, yi
    return inside


def _in_box(box: dict[str, Any], xyz: np.ndarray) -> np.ndarray:
    """Inside the turned box, faces included."""
    c, s = math.cos(box["yaw"]), math.sin(box["yaw"])
    d = xyz - np.asarray(box["center"], dtype=np.float64)
    sx, sy, sz = box["size"]
    u = (c * d[:, 0] + s * d[:, 1]) / sx
    v = (-s * d[:, 0] + c * d[:, 1]) / sy
    w = d[:, 2] / sz
    return (np.abs(u) <= 0.5) & (np.abs(v) <= 0.5) & (np.abs(w) <= 0.5)


def evaluate(recipe: dict[str, Any], xyz: np.ndarray, cls: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """State (uint8) and class after the regions (uint8) of each point. ``cls`` is the starting
    class: the noise copy's classes when the recipe has one, else the original's."""
    xyz = np.asarray(xyz, dtype=np.float64).reshape(-1, 3)
    n = len(xyz)
    out = np.asarray(cls, dtype=np.uint8).copy()
    hide = np.zeros(n, dtype=bool)
    dele = np.zeros(n, dtype=bool)
    if n and recipe.get("regions"):
        h = np.concatenate([xyz, np.ones((n, 1))], axis=1)
        for r in recipe["regions"]:
            m = np.asarray(r["viewProj"], dtype=np.float64).reshape(4, 4).T  # column-major
            clip = h @ m.T
            w = clip[:, 3]
            front = w > 0
            sel = np.zeros(n, dtype=bool)
            if front.any():
                nx = clip[front, 0] / w[front]
                ny = clip[front, 1] / w[front]
                sel[front] = in_polygon(np.asarray(r["polygon"], dtype=np.float64), nx, ny)
            a = r["action"]
            if a["kind"] == "class":
                out[sel] = a["value"]
            elif a["kind"] == "hide":
                hide |= sel
            else:
                dele |= sel
    drop = np.zeros(n, dtype=bool)
    height = recipe.get("height") or {}
    if height.get("min") is not None:
        drop |= xyz[:, 2] < height["min"]
    if height.get("max") is not None:
        drop |= xyz[:, 2] > height["max"]
    box = recipe.get("clipBox")
    if box:
        inside = _in_box(box, xyz)
        drop |= ~inside if box["keep"] == "inside" else inside
    hidden = np.zeros(256, dtype=bool)
    hidden[np.asarray(recipe.get("hiddenClasses") or [], dtype=np.int64)] = True
    state = np.zeros(n, dtype=np.uint8)
    state[hide] = HIDDEN
    state[hidden[out]] = CLASS_HIDDEN
    state[dele] = DELETED
    state[drop] = DROPPED
    return state, out


def kept_for_save(state: np.ndarray) -> np.ndarray:
    """Points a save or an export writes: kept, and hidden by a hide selection (view only)."""
    return state <= HIDDEN
