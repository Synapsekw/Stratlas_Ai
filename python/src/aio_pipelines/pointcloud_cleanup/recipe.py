"""Checks of a cleanup recipe as it arrives in job params (the app validated it with zod first;
this keeps the pipeline safe on its own). Messages are sentences a person can act on."""

from __future__ import annotations

import math
from typing import Any

from ..runtime import JobError

SCHEMA = "aio.pccleanup/1"
MAX_REGIONS = 200
MAX_LASSO = 256
NOISE_CLASS = 7
NOISE_DIR = "edits/pointcloud/"


def _num(v: Any) -> bool:
    return isinstance(v, int | float) and not isinstance(v, bool) and math.isfinite(v)


def _vec(v: Any, n: int) -> bool:
    return isinstance(v, list) and len(v) == n and all(_num(x) for x in v)


def _class(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= 255


def validate_recipe(raw: Any, layer_id: str | None = None) -> dict[str, Any]:
    if not isinstance(raw, dict) or raw.get("schema") != SCHEMA:
        raise JobError(f"The cleanup is not an {SCHEMA} recipe.")
    if layer_id is not None and raw.get("layerId") != layer_id:
        raise JobError("The cleanup belongs to another layer.")
    regions = raw.get("regions")
    if not isinstance(regions, list) or len(regions) > MAX_REGIONS:
        raise JobError(f"A cleanup holds at most {MAX_REGIONS} selections.")
    for r in regions:
        if not isinstance(r, dict) or r.get("shape") not in ("box", "lasso"):
            raise JobError("A selection is a box or a lasso.")
        if not _vec(r.get("viewProj"), 16):
            raise JobError("A selection's view matrix is 16 numbers.")
        poly = r.get("polygon")
        if not isinstance(poly, list) or not all(_vec(p, 2) for p in poly):
            raise JobError("A selection's outline is a list of points.")
        if r["shape"] == "box" and len(poly) != 4:
            raise JobError("A box selection has 4 corners.")
        if not 3 <= len(poly) <= MAX_LASSO:
            raise JobError(f"A lasso has 3 to {MAX_LASSO} points.")
        a = r.get("action")
        kind = a.get("kind") if isinstance(a, dict) else None
        if kind not in ("hide", "delete", "class"):
            raise JobError("A selection hides, deletes or sets a class: hide, delete or class.")
        if kind == "class" and not _class(a.get("value")):
            raise JobError("A class is a number from 0 to 255.")
    hidden = raw.get("hiddenClasses")
    if not isinstance(hidden, list) or not all(_class(c) for c in hidden):
        raise JobError("Hidden classes are numbers from 0 to 255.")
    h = raw.get("height")
    if h is not None:
        if not isinstance(h, dict):
            raise JobError("A height range has a lowest and a highest height.")
        lo, hi = h.get("min"), h.get("max")
        if any(v is not None and not _num(v) for v in (lo, hi)):
            raise JobError("A height is a number.")
        if lo is not None and hi is not None and lo > hi:
            raise JobError("The lowest height is above the highest.")
    box = raw.get("clipBox")
    if box is not None:
        if not (
            isinstance(box, dict)
            and _vec(box.get("center"), 3)
            and _vec(box.get("size"), 3)
            and _num(box.get("yaw"))
        ):
            raise JobError("A clip box has a centre, a size and a turn.")
        if any(s <= 0 for s in box["size"]):
            raise JobError("A clip box size is above 0 m.")
        if box.get("keep") not in ("inside", "outside"):
            raise JobError("A clip box keeps what is inside or outside.")
    noise = raw.get("noise")
    if noise is not None:
        path = noise.get("path") if isinstance(noise, dict) else None
        if not (
            isinstance(path, str)
            and path.startswith(NOISE_DIR)
            and path.endswith(".copc.laz")
            and ".." not in path
        ):
            raise JobError("A noise working copy lives in edits/pointcloud.")
    return raw
