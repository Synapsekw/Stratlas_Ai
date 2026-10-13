"""``stitch.json`` (``aio.pano-stitch/1``): the run record of ``pano.stitch``.

The TypeScript schema is the contract (``packages/schema/src/panoStitch.ts`` ``PanoStitchFile``);
``check_record`` is a Python copy of its field set and types, run on every record before it is
written and tested against the shared fixture ``__fixtures__/pano/stitch.synthetic.json``.
"""

from __future__ import annotations

import re
from typing import Any

SCHEMA = "aio.pano-stitch/1"
PANO_ID = re.compile(r"^[a-z0-9][a-z0-9-]*$")
#: Caps of ``PanoStitchFile.frames`` (used, dropped) and of a dropped frame's reason text.
MAX_FRAMES = 200
KEYS = {
    "schema",
    "run",
    "layer",
    "pano",
    "createdAt",
    "engine",
    "quality",
    "shape",
    "size",
    "frames",
    "aligned",
    "residualPx",
    "maxDriftDeg",
    "focalScale",
    "coverage",
    "timings",
    "warnings",
}


def _num(v: Any) -> bool:
    return isinstance(v, int | float) and not isinstance(v, bool)


def _frame_name(v: Any) -> bool:
    return isinstance(v, str) and 1 <= len(v) <= 260 and "/" not in v and "\\" not in v


def check_record(doc: Any) -> None:
    """Raise ValueError naming the first field that ``PanoStitchFile`` would refuse."""

    def bad(field: str) -> ValueError:
        return ValueError(f"stitch.json: {field} is not what aio.pano-stitch/1 allows")

    if not isinstance(doc, dict) or set(doc) != KEYS:
        raise bad("the set of fields")
    if doc["schema"] != SCHEMA:
        raise bad("schema")
    if not isinstance(doc["run"], str) or not 1 <= len(doc["run"]) <= 128:
        raise bad("run")
    for key in ("layer", "pano"):
        if not isinstance(doc[key], str) or not 1 <= len(doc[key]) <= 80 or not PANO_ID.match(doc[key]):
            raise bad(key)
    if not isinstance(doc["createdAt"], str) or not re.match(
        r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d", doc["createdAt"]
    ):
        raise bad("createdAt")
    eng = doc["engine"]
    if (
        not isinstance(eng, dict)
        or not isinstance(eng.get("version"), str)
        or not 1 <= len(eng["version"]) <= 40
    ):
        raise bad("engine")
    if doc["quality"] not in ("standard", "high"):
        raise bad("quality")
    if doc["shape"] not in ("sphere", "wide"):
        raise bad("shape")
    size = doc["size"]
    if not isinstance(size, dict) or not all(
        isinstance(size.get(k), int) and size[k] > 0 for k in ("width", "height")
    ):
        raise bad("size")
    fr = doc["frames"]
    if (
        not isinstance(fr, dict)
        or not isinstance(fr.get("used"), list)
        or len(fr["used"]) > MAX_FRAMES
        or not all(_frame_name(n) for n in fr["used"])
        or not isinstance(fr.get("dropped"), list)
        or len(fr["dropped"]) > MAX_FRAMES
        or not all(
            isinstance(d, dict)
            and _frame_name(d.get("file"))
            and isinstance(d.get("reason"), str)
            and 1 <= len(d["reason"]) <= 200
            for d in fr["dropped"]
        )
    ):
        raise bad("frames")
    if doc["aligned"] not in ("features", "metadata"):
        raise bad("aligned")
    for key in ("residualPx", "maxDriftDeg"):
        if doc[key] is not None and (not _num(doc[key]) or doc[key] < 0):
            raise bad(key)
    if not _num(doc["focalScale"]) or doc["focalScale"] <= 0:
        raise bad("focalScale")
    cov = doc["coverage"]
    if not isinstance(cov, dict) or not all(
        _num(cov.get(k)) and -90 <= cov[k] <= 90 for k in ("topDeg", "bottomDeg")
    ):
        raise bad("coverage")
    if not set(cov) <= {"topDeg", "bottomDeg", "leftDeg", "rightDeg"} or any(
        k in cov and not _num(cov[k]) for k in ("leftDeg", "rightDeg")
    ):
        raise bad("coverage")
    if not isinstance(doc["timings"], dict) or not all(_num(v) and v >= 0 for v in doc["timings"].values()):
        raise bad("timings")
    w = doc["warnings"]
    if not isinstance(w, list) or len(w) > 50 or not all(isinstance(s, str) and len(s) <= 400 for s in w):
        raise bad("warnings")
