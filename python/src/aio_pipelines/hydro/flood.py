"""hydro.flood: the area, depth and stored volume below a water level.

G0 stub (M11 stream G10 builds it): parameters as ``HydroFloodParams`` in packages/schema/src/jobs.ts.
"""

from __future__ import annotations

from ..stub import NotBuiltYet


class HydroFlood(NotBuiltYet):
    name = "hydro.flood"
    title = "Flood to level"
    description = "The area, depth and stored volume below a water level."
    keys = frozenset({"surface", "levelM", "mode", "seed", "region", "run"})
    required = frozenset({"surface", "levelM", "mode"})
    choices = {  # noqa: RUF012 - read only, as the base class declares
        "mode": frozenset({"connected", "all-below"}),
    }
