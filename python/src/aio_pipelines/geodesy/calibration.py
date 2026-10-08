"""geo.calibration: a controller file, a 12d transform or point pairs to a site calibration.

G0 stub (M11 stream G1 builds it): parameters as ``GeoCalibrationParams`` in packages/schema/src/jobs.ts.
"""

from __future__ import annotations

from typing import Any

from ..stub import NotBuiltYet, exactly_one


class GeoCalibration(NotBuiltYet):
    name = "geo.calibration"
    title = "Site calibration"
    description = (
        "A Trimble JobXML or .dc, a 12d transform or point pairs to a site calibration with residuals."
    )
    keys = frozenset({"src", "format", "pairs", "crs", "verticalDatum", "geoid"})
    required = frozenset({"crs"})
    choices = {  # noqa: RUF012 - read only, as the base class declares
        "format": frozenset({"jobxml", "dc", "12d", "cal", "pairs"}),
    }

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        out = super().validate(params)
        exactly_one(
            params.get("src") is not None,
            params.get("pairs") is not None,
            "Give a file or point pairs, not both.",
        )
        return out
