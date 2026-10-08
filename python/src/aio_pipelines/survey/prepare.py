"""survey.prepare: a DSM, DTM, cloud, design or cleaned surface to height tiles, plus site tables.

G0 stub (M11 stream G2 builds it): parameters as ``SurveyPrepareParams`` in packages/schema/src/jobs.ts.
"""

from __future__ import annotations

from ..stub import NotBuiltYet


class SurveyPrepare(NotBuiltYet):
    name = "survey.prepare"
    title = "Prepare surfaces"
    description = (
        "A DSM, DTM, cloud, design or cleaned surface to height tiles for measuring, "
        "plus the site coordinate tables."
    )
    keys = frozenset({"surfaces", "cellM", "geodesy"})
    required = frozenset({"surfaces"})
