"""packs.terrain: a DEM to Terrarium-encoded tiles in PMTiles, with its vertical datum.

G0 stub (M10 stream G7 builds it): parameters as ``TerrainPackParams`` in ``@aio/schema``.
Writes ``<id>.pmtiles`` and ``<id>.json`` (``aio.raster-pack/1``) into ``dest`` when built.
"""

from __future__ import annotations

from ..stub import NotBuiltYet


class TerrainPack(NotBuiltYet):
    name = "packs.terrain"
    title = "Terrain pack"
    description = "A DEM to an offline terrain pack (Terrarium tiles) with its vertical datum."
    keys = frozenset(
        {
            "src",
            "dest",
            "id",
            "label",
            "licence",
            "attribution",
            "provenance",
            "minZoom",
            "maxZoom",
            "verticalDatum",
            "format",
        }
    )
    required = frozenset({"src", "dest", "id", "label", "licence", "attribution", "verticalDatum"})
    choices = {  # noqa: RUF012 - read only, as the base class declares
        "verticalDatum": frozenset({"egm2008", "egm96", "ellipsoid"}),
        "format": frozenset({"webp", "png"}),
    }
