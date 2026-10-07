"""tiles.cloud: a COPC point cloud to a 3D Tiles points tileset following its hierarchy.

G0 stub (M10 stream G7 builds it): parameters as ``TilesCloudParams`` in ``@aio/schema``.
"""

from __future__ import annotations

from ..stub import NotBuiltYet


class TilesCloud(NotBuiltYet):
    name = "tiles.cloud"
    title = "Point cloud to 3D Tiles"
    description = "A COPC point cloud to a 3D Tiles points tileset, for the Globe."
    keys = frozenset({"layer", "id", "name", "maxPointsPerTile"})
    required = frozenset({"layer"})
