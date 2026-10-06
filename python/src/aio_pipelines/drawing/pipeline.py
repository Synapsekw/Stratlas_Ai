"""drawing.import: a DXF plot plan in its units, placed by control points. DWG is not supported.

C0 stub (M8 stream C5 builds it): parameters as ``DrawingImportParams`` in ``@aio/schema``.
"""

from __future__ import annotations

from ..stub import NotBuiltYet


class DrawingImport(NotBuiltYet):
    name = "drawing.import"
    title = "Drawing import (DXF)"
    description = "A DXF plot plan placed by control points: vector layers, a plan raster and height hints."
    keys = frozenset({"src", "units", "layers", "control", "out"})
