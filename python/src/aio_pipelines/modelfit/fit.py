"""model.fit_cloud: draft model parts (tanks, boxes, buildings, pipes) fitted to a point cloud.

C0 stub (M8 stream C5 builds it): parameters as ``ModelFitParams`` in ``@aio/schema``; parts go
to ``models/<id>.procmodel.json`` (``aio.procmodel/1``).
"""

from __future__ import annotations

from ..stub import NotBuiltYet


class ModelFitCloud(NotBuiltYet):
    name = "model.fit_cloud"
    title = "Model from point cloud"
    description = "Ground removal, clustering and primitive fitting into draft model parts."
    keys = frozenset({"layer", "region", "kinds", "distM", "minInliers", "model"})
