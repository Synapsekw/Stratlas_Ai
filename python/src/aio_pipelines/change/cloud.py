"""change.cloud: cloud-to-cloud distance as a COPC with a Distance field, and change regions.

C0 stub (M8 stream C3 builds it): parameters as ``ChangeCloudParams`` in ``@aio/schema``.
"""

from __future__ import annotations

from ..stub import NotBuiltYet


class ChangeCloud(NotBuiltYet):
    name = "change.cloud"
    title = "Point cloud change"
    description = "Cloud-to-cloud distance as a COPC Distance field, and regions of moved points."
    keys = frozenset(
        {"layerFrom", "layerTo", "captures", "minDistM", "maxDistM", "signed", "spacingM", "region", "out"}
    )
