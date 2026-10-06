"""change.raster: two orthos of the same area to a change heat map, polygons and region items.

C0 stub (M8 stream C2 builds it): parameters as ``ChangeRasterParams`` in ``@aio/schema``.
"""

from __future__ import annotations

from ..stub import NotBuiltYet


class ChangeRaster(NotBuiltYet):
    name = "change.raster"
    title = "Imagery change"
    description = "Two orthos: co-registration check, illumination-robust difference, heat map and polygons."
    keys = frozenset(
        {
            "from",
            "to",
            "layerFrom",
            "layerTo",
            "method",
            "threshold",
            "minAreaM2",
            "maxShiftPx",
            "mask",
            "ignore",
            "out",
        }
    )
