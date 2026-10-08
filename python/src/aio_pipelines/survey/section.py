"""survey.section: a multi-surface cross-section as DXF (2D or 3D) or CSV.

G0 stub (M11 stream G5 builds it): parameters as ``SurveySectionParams`` in packages/schema/src/jobs.ts.
"""

from __future__ import annotations

from ..stub import NotBuiltYet


class SurveySection(NotBuiltYet):
    name = "survey.section"
    title = "Cross-section"
    description = "A multi-surface cross-section as DXF (2D or 3D) or CSV."
    keys = frozenset({"line", "surfaces", "format", "capture", "out"})
    required = frozenset({"line", "surfaces", "format", "out"})
    choices = {  # noqa: RUF012 - read only, as the base class declares
        "format": frozenset({"dxf-2d-xy", "dxf-2d-xz", "dxf-2d-yz", "dxf-3d-zup", "dxf-3d-yup", "csv"}),
    }
