"""hydro.flow: flow paths from a drop point, catchments of outlets and the stream network.

G0 stub (M11 stream G10 builds it): parameters as ``HydroFlowParams`` in packages/schema/src/jobs.ts.
"""

from __future__ import annotations

from ..stub import NotBuiltYet


class HydroFlow(NotBuiltYet):
    name = "hydro.flow"
    title = "Runoff and catchments"
    description = "Flow paths from a drop point, catchments of outlets and the stream network."
    keys = frozenset(
        {"surface", "mode", "drop", "outlets", "method", "depressions", "streamAreaM2", "region", "run"}
    )
    required = frozenset({"surface", "mode"})
    choices = {  # noqa: RUF012 - read only, as the base class declares
        "mode": frozenset({"runoff", "catchment", "streams"}),
        "method": frozenset({"d8", "dinf"}),
        "depressions": frozenset({"fill", "breach"}),
    }
