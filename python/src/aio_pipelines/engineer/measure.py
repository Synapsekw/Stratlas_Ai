"""The shaft measurement chain on a cropped cloud: ground, the one structure, axis, base, sections.

    split_ground -> isolate_asset -> estimate_axis -> find_base -> fit_sections -> fit_taper

Heights of the sections and the taper count from the base (the ground under the axis when it was
seen). Everything the chain excluded or doubted is returned, not only used: the dropped
neighbouring structures, the rejected slices and the sentences for the pack's warnings.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .axis import Axis, estimate_axis
from .cloud import Base, GroundSplit, find_base, isolate_asset, split_ground
from .sections import SliceFit, Taper, fit_sections, fit_taper


@dataclass
class Measurement:
    kept: np.ndarray  # the asset's points (local frame), ground and neighbours removed
    axis: Axis  # anchored at the base
    base: Base
    slices: list[SliceFit]
    taper: Taper
    ground: GroundSplit
    isolation: dict[str, Any]  # `isolate_asset` info: components, dropped structures
    rejected: dict[str, Any] = field(default_factory=dict)  # `fit_sections` report
    warnings: list[str] = field(default_factory=list)


def measure_shaft(
    xyz: np.ndarray,
    centre: tuple[float, float] | None = None,
    step: float = 2.0,
    ground_dist: float = 0.15,
    seed: int = 0,
) -> Measurement:
    """Measure a standing shaft in a cropped cloud; `centre` is the crop's plan centre (x, z)."""
    split = split_ground(xyz, ground_dist)
    kept, isolation = isolate_asset(split.kept, centre)
    warnings: list[str] = []
    if isolation["dropped"]:
        n = len(isolation["dropped"])
        warnings.append(
            f"Excluded {isolation['droppedPoints']} points of {n} other structure{'s' if n > 1 else ''} "
            "or clutter near the asset."
        )
    axis = estimate_axis(kept, seed=seed)
    base, axis = find_base(axis, kept, split)
    if base.note:
        warnings.append(base.note)
    report: dict[str, Any] = {}
    slices = fit_sections(kept, axis, step, seed=seed, report=report)
    skipped = sum(report.get("rejected", {}).values())
    if skipped:
        parts = ", ".join(f"{n} {why}" for why, n in report["rejected"].items() if n)
        warnings.append(f"Skipped {skipped} slices ({parts}).")
    return Measurement(kept, axis, base, slices, fit_taper(slices), split, isolation, report, warnings)
