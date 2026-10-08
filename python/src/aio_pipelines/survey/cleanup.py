"""survey.cleanup: cleanups, crops and DTM filters as a new derived surface.

G0 stub (M11 stream G8 builds it): parameters as ``SurveyCleanupParams`` in packages/schema/src/jobs.ts.
"""

from __future__ import annotations

from typing import Any

from ..stub import NotBuiltYet, exactly_one


class SurveyCleanup(NotBuiltYet):
    name = "survey.cleanup"
    title = "Terrain cleanup"
    description = (
        "Cleanups, crops and DTM filters as a new derived surface; the delivered surface is never changed."
    )
    keys = frozenset({"surface", "edits", "dtmFilter", "out"})

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        out = super().validate(params)
        exactly_one(
            params.get("surface") is not None and params.get("edits") is not None,
            params.get("dtmFilter") is not None,
            "Give a surface with edits, or a DTM filter.",
        )
        return out
