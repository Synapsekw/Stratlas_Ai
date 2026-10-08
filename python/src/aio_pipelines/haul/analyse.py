"""haul.analyse: width, gradient, cross fall, superelevation and berm height along a haul road.

G0 stub (M11 stream G11 builds it): parameters as ``HaulAnalyseParams`` in packages/schema/src/jobs.ts.
"""

from __future__ import annotations

from ..stub import NotBuiltYet


class HaulAnalyse(NotBuiltYet):
    name = "haul.analyse"
    title = "Haul-road compliance"
    description = (
        "Width, gradient, cross fall, superelevation and berm height along a haul road against site limits."
    )
    keys = frozenset({"surface", "centreline", "intervalM", "limits", "run"})
    required = frozenset({"surface", "centreline", "intervalM", "limits"})
