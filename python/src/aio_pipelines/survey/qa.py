"""survey.qa: a surface against checkpoints and against the previous survey at the site QA level.

G0 stub (M11 stream G8 builds it): parameters as ``SurveyQaParams`` in packages/schema/src/jobs.ts.
"""

from __future__ import annotations

from ..stub import NotBuiltYet


class SurveyQa(NotBuiltYet):
    name = "survey.qa"
    title = "Survey QA"
    description = "Checks a surface against checkpoints and against the previous survey at the site QA level."
    keys = frozenset({"capture", "surface", "level", "checkpoints", "previous"})
    required = frozenset({"capture", "surface", "level"})
    choices = {  # noqa: RUF012 - read only, as the base class declares
        "level": frozenset({"strict", "moderate", "lenient", "off"}),
    }
