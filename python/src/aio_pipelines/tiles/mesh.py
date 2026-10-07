"""tiles.mesh: a GLB or OBJ mesh to a 3D Tiles 1.1 tileset placed through the project CRS.

G0 stub (M10 stream G7 builds it): parameters as ``TilesMeshParams`` in ``@aio/schema``.
"""

from __future__ import annotations

from typing import Any

from ..runtime import JobError
from ..stub import NotBuiltYet


class TilesMesh(NotBuiltYet):
    name = "tiles.mesh"
    title = "Mesh to 3D Tiles"
    description = "A large mesh to a 3D Tiles tileset for the site view and the Globe."
    keys = frozenset(
        {"layer", "src", "id", "name", "run", "compression", "maxTrianglesPerTile", "textureMaxPx"}
    )
    choices = {  # noqa: RUF012 - read only, as the base class declares
        "compression": frozenset({"meshopt", "draco", "none"}),
    }

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        out = super().validate(params)
        if (params.get("layer") is None) == (params.get("src") is None):
            raise JobError("Give a mesh layer or a mesh file, not both.")
        return out
