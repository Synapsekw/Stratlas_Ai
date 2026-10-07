"""photo.georef: bundle adjustment with ground control points; checkpoints measured, never used.

G0 stub (M10 stream G2 builds it): parameters as ``PhotoGeorefParams`` in ``@aio/schema``.
Writes ``report/accuracy.json`` (``aio.photo-accuracy/1``) when built.
"""

from __future__ import annotations

from ..stub import NotBuiltYet


class PhotoGeoref(NotBuiltYet):
    name = "photo.georef"
    title = "Adjust with ground control"
    description = "Bundle adjustment with marked control points, and the accuracy report."
    keys = frozenset({"run", "gcp", "useGnss"})
    required = frozenset({"run"})
