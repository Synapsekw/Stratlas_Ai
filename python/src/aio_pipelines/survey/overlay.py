"""survey.overlay: contours, slope, elevation ramp or shaded relief of a surface or a difference.

G0 stub (M11 stream G5 builds it): parameters as ``SurveyOverlayParams`` in packages/schema/src/jobs.ts.
"""

from __future__ import annotations

from typing import Any

from ..stub import NotBuiltYet, exactly_one


class SurveyOverlay(NotBuiltYet):
    name = "survey.overlay"
    title = "Terrain overlay"
    description = "Contours, slope, elevation ramp or shaded relief of a surface or a difference."
    keys = frozenset({"id", "surface", "comparison", "kind", "options"})
    required = frozenset({"kind"})
    choices = {  # noqa: RUF012 - read only, as the base class declares
        "kind": frozenset({"contours", "slope", "elevation", "relief"}),
    }

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        out = super().validate(params)
        exactly_one(
            params.get("surface") is not None,
            params.get("comparison") is not None,
            "Give a surface or a comparison, not both.",
        )
        return out
