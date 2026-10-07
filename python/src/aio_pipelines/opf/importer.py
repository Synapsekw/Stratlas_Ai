"""opf.import: an OPF project to a photos layer with calibrated cameras, GCPs and output layers.

G0 stub (M10 stream G5 builds it): parameters as ``OpfImportParams`` in ``@aio/schema``.
"""

from __future__ import annotations

from ..stub import NotBuiltYet


class OpfImport(NotBuiltYet):
    name = "opf.import"
    title = "OPF import"
    description = "An Open Photogrammetry Format project: cameras, control points and outputs."
    keys = frozenset({"src", "products", "photosRoot"})
    required = frozenset({"src"})
    choices = {  # noqa: RUF012 - read only, as the base class declares
        "products": frozenset({"cloud", "ortho", "dsm", "mesh"}),
    }
