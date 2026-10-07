"""opf.export: a processing run to an OPF 1.x project another OPF reader opens.

G0 stub (M10 stream G5 builds it): parameters as ``OpfExportParams`` in ``@aio/schema``.
"""

from __future__ import annotations

from ..stub import NotBuiltYet


class OpfExport(NotBuiltYet):
    name = "opf.export"
    title = "OPF export"
    description = "A processing run as an OPF project: cameras, calibration, control points, CRS."
    keys = frozenset({"run", "out"})
    required = frozenset({"run", "out"})
