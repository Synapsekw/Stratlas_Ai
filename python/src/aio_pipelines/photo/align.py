"""photo.align: EXIF and DJI XMP (GPS, RTK), features, matching, structure from motion, GNSS georef.

G0 stub (M10 stream G2 builds it): parameters as ``PhotoAlignParams`` in ``@aio/schema``.
"""

from __future__ import annotations

from ..stub import NotBuiltYet


class PhotoAlign(NotBuiltYet):
    name = "photo.align"
    title = "Align photos"
    description = "Drone photos to calibrated cameras and a sparse model, georeferenced by GNSS."
    keys = frozenset({"photos", "run", "preset", "matching", "mapper", "gnss", "ppk", "crs", "maxImageSize"})
    required = frozenset({"photos", "preset"})
    choices = {  # noqa: RUF012 - read only, as the base class declares
        "preset": frozenset({"fast", "standard", "high"}),
        "matching": frozenset({"auto", "gps", "sequential", "exhaustive"}),
        "mapper": frozenset({"auto", "global", "incremental"}),
        "gnss": frozenset({"auto", "rtk", "standard", "ignore"}),
    }
