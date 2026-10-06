"""change.mesh: deviation of the later model from the earlier one, and the tagged part diff.

C0 stub (M8 stream C3 builds it): parameters as ``ChangeMeshParams`` in ``@aio/schema``.
"""

from __future__ import annotations

from ..stub import NotBuiltYet


class ChangeMesh(NotBuiltYet):
    name = "change.mesh"
    title = "3D model change"
    description = "Model deviation colours, and tagged parts added, removed, moved or changed."
    keys = frozenset({"layerFrom", "layerTo", "captures", "samples", "minDistM", "maxDistM", "out"})
