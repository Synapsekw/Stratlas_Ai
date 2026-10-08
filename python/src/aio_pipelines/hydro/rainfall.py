"""hydro.rainfall: water depth over time from a rainfall hyetograph (simplified 2D model).

G0 stub (M11 stream G10 builds it): parameters as ``HydroRainfallParams`` in packages/schema/src/jobs.ts.
"""

from __future__ import annotations

from typing import Any

from ..runtime import JobError
from ..stub import NotBuiltYet

#: The grid cells the model runs on, metres (decision 3).
CELLS_M = (0.5, 1, 2)


class HydroRainfall(NotBuiltYet):
    name = "hydro.rainfall"
    title = "Direct rainfall"
    description = "Water depth over time from a rainfall hyetograph (simplified 2D model)."
    keys = frozenset(
        {
            "surface",
            "hyetograph",
            "manningN",
            "infiltrationMmPerH",
            "cellM",
            "durationMin",
            "region",
            "run",
        }
    )
    required = frozenset({"surface", "hyetograph", "manningN", "infiltrationMmPerH", "cellM"})

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        out = super().validate(params)
        cell = params["cellM"]
        if isinstance(cell, bool) or not isinstance(cell, int | float) or cell not in CELLS_M:
            raise JobError("cellM must be one of: 0.5, 1, 2.")
        return out
