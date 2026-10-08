"""survey.compare: cut, fill, net and total between two surfaces, per measurement or the whole site.

G0 stub (M11 stream G2 builds it): parameters as ``SurveyCompareParams`` in packages/schema/src/jobs.ts.
"""

from __future__ import annotations

from typing import Any

from ..stub import NotBuiltYet, exactly_one


class SurveyCompare(NotBuiltYet):
    name = "survey.compare"
    title = "Compare surfaces"
    description = (
        "Cut, fill, net and total between any two surfaces or a base, "
        "for many measurements at once or the whole site."
    )
    keys = frozenset({"items", "site", "out"})

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        out = super().validate(params)
        exactly_one(
            params.get("items") is not None,
            params.get("site") is not None,
            "Give items or site, not both.",
        )
        return out
