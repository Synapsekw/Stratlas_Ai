"""A synthetic site surveyed twice, with known changes, for the Globe's processed outputs (M10).

Two aligned photo runs of the same fictional site (``products_synth``), flown on the same camera
layout (same seed and spacing) two weeks apart:

- ``c1`` (7 Oct 2026) is the default scene: a box building and a stockpile 4 m high;
- ``c2`` (21 Oct 2026) has the stockpile 6 m high (same footprint) and a new 3 m shed on open ground.

``write_project`` writes one project (one manifest with both captures, photos in ``photos-c1/`` and
``photos-c2/``, one run under ``photogrammetry/`` per capture) and ``truth.json`` with what changed.
The app then runs ``photo.products`` on each run with its ``capture``. Synthetic data only.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import products_synth as ps

RUN1 = "20261007-0915"
RUN2 = "20261021-0930"
CAPTURES = [
    {"id": "c1", "date": "2026-10-07", "label": "7 Oct 2026"},
    {"id": "c2", "date": "2026-10-21", "label": "21 Oct 2026"},
]
SHED = (9.0, 15.0, -16.0, -9.0, 3.0)  # x0, x1, y0, y1 (local east, north), height; clear of pile and box
PILE_TO = 6.0
# points on open ground, well away from the pile, the box and the shed (local east, north)
OPEN_GROUND = [(-25.0, 20.0), (-25.0, -4.0), (-3.0, -6.0), (-2.0, 20.0), (25.0, 2.0), (22.0, -4.0)]


def variants() -> tuple[ps.Variant, ps.Variant]:
    cx, cy, r, _ = ps.PILE
    return ps.DEFAULT, ps.Variant(pile=(cx, cy, r, PILE_TO), boxes=(ps.BOX, SHED))


def truth() -> dict:
    """What changed between the surveys, in the local frame (x east, z south, metres)."""
    x0, x1, y0, y1, h = SHED
    cx, cy, r, h0 = ps.PILE
    return {
        "shed": {"outlineLocal": [[x0, -y0], [x1, -y0], [x1, -y1], [x0, -y1]], "heightM": h},
        "pile": {
            "centreLocal": [cx, -cy],
            "radiusM": r,
            "heightFrom": h0,
            "heightTo": PILE_TO,
            "fillM3": math.pi * r * r * (PILE_TO - h0) / 3,
        },
        "openGround": [[x, -y] for x, y in OPEN_GROUND],
        "captures": [{"id": c["id"], "date": c["date"]} for c in CAPTURES],
    }


def write_project(root: Path, step: float = 0.05) -> dict:
    """Write the two-survey project under ``root``; returns the runs per capture, the origin and
    the truth (also written to ``<root>/truth.json``)."""
    root.mkdir(parents=True, exist_ok=True)
    before, after = variants()
    for cap, run, variant in (("c1", RUN1, before), ("c2", RUN2, after)):
        scene = ps.make_scene(step=step, variant=variant)
        ps.write_project(root, scene, run=run, photos_dir=f"photos-{cap}", captures=CAPTURES)
    t = truth()
    (root / "truth.json").write_text(json.dumps(t, indent=2), "utf-8")
    return {"runs": {"c1": RUN1, "c2": RUN2}, "origin": list(ps.ORIGIN), "truth": t}
