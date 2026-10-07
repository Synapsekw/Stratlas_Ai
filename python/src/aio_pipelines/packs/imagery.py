"""packs.imagery: GeoTIFF or COG imagery to a raster PMTiles pack (WebP, Web Mercator).

G0 stub (M10 stream G7 builds it): parameters as ``ImageryPackParams`` in ``@aio/schema``.
Writes ``<id>.pmtiles`` and ``<id>.json`` (``aio.raster-pack/1``) into ``dest`` when built.
"""

from __future__ import annotations

from ..stub import NotBuiltYet


class ImageryPack(NotBuiltYet):
    name = "packs.imagery"
    title = "Imagery pack"
    description = "GeoTIFF or COG imagery to an offline raster pack with its licence and attribution."
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
            "customerLicence",
            "format",
            "quality",
            "tileSize",
        }
    )
    required = frozenset({"src", "dest", "id", "label", "licence", "attribution", "customerLicence"})
    choices = {  # noqa: RUF012 - read only, as the base class declares
        "format": frozenset({"webp", "png", "jpeg"}),
    }
