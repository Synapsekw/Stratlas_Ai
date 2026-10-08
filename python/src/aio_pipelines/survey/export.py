"""survey.export: surfaces, orthos, clouds, contours, measurements and sections to survey formats.

G0 stub (M11 stream G7 builds it): parameters as ``SurveyExportParams`` in packages/schema/src/jobs.ts.
"""

from __future__ import annotations

from typing import Any

from ..runtime import JobError
from ..stub import NotBuiltYet

#: Named grids ``crs`` takes besides ``{"epsg": n}``.
NAMED_CRS = frozenset({"site", "wgs84"})


class SurveyExport(NotBuiltYet):
    name = "survey.export"
    title = "Survey export"
    description = (
        "Surfaces, orthos, clouds, contours, measurements and sections as GeoTIFF, LAZ, DXF, "
        "LandXML, 12da, CSV, KML, SHP or GeoJSON in the site grid or WGS84."
    )
    keys = frozenset(
        {
            "what",
            "format",
            "crs",
            "units",
            "decimate",
            "surface",
            "layer",
            "overlay",
            "measurements",
            "out",
        }
    )
    required = frozenset({"what", "format", "crs", "out"})
    choices = {  # noqa: RUF012 - read only, as the base class declares
        "what": frozenset({"surface", "ortho", "cloud", "contours", "measurements", "section"}),
        "format": frozenset({"geotiff", "laz", "dxf", "landxml", "12da", "csv", "kml", "shp", "geojson"}),
        "units": frozenset({"mm", "cm", "m", "km", "ft", "us-ft", "in", "yd", "mi", "us-mi"}),
    }

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        out = super().validate(params)
        crs = params["crs"]
        if isinstance(crs, str) and crs not in NAMED_CRS:
            raise JobError("crs must be site, wgs84 or an EPSG code.")
        return out
