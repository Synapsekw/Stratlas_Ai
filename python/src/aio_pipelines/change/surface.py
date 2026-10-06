"""change.surface: two DSMs or point clouds to cut and fill regions with volumes.

C0 stub (M8 stream C2 builds it): parameters as ``ChangeSurfaceParams`` in ``@aio/schema``.
"""

from __future__ import annotations

from ..stub import NotBuiltYet


class ChangeSurface(NotBuiltYet):
    name = "change.surface"
    title = "Surface change"
    description = "Two DSMs or point clouds: DEM of difference, cut and fill regions, site total."
    keys = frozenset({"from", "to", "captures", "cellM", "minDepthM", "minAreaM2", "areas", "out"})
