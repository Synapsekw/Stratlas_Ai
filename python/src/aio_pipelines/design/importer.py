"""design.import: LandXML, DXF, 12da or CSV designs to TIN surfaces, linework, alignments and points.

G0 stub (M11 stream G6 builds it): parameters as ``DesignImportParams`` in packages/schema/src/jobs.ts.
"""

from __future__ import annotations

from ..stub import NotBuiltYet


class DesignImport(NotBuiltYet):
    name = "design.import"
    title = "Import design"
    description = (
        "LandXML, DXF, 12da or CSV designs to TIN surfaces, linework, alignments and points, "
        "keeping the original file."
    )
    keys = frozenset({"src", "format", "id", "name", "crs", "useCalibration", "units", "layers"})
    required = frozenset({"src"})
    choices = {  # noqa: RUF012 - read only, as the base class declares
        "format": frozenset({"landxml", "dxf", "12da", "csv", "ttm"}),
        "units": frozenset({"m", "mm", "cm", "ft", "us-ft", "in"}),
    }
