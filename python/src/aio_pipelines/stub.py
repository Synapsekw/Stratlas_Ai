"""Pipelines the app already names (contracts first, M8 step C0) whose work is not built yet.

A stub checks its parameter names like the real pipeline will, then fails its one step with a
clear ``JobError`` the Jobs panel shows as is. Each M8 stream replaces the stub class in its own
module (``change/raster.py`` and so on) without touching ``pipelines.py``.
"""

from __future__ import annotations

from typing import Any, ClassVar

from .params import known_keys
from .runtime import JobError, Step, StepContext

NOT_IMPLEMENTED = "{title} ({name}) is not implemented in this pipeline pack yet."


class NotBuiltYet:
    name: ClassVar[str]
    title: ClassVar[str]
    description: ClassVar[str]
    #: The parameter names of the contract (``@aio/schema`` ``jobs.ts``).
    keys: ClassVar[frozenset[str]]

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(params, set(self.keys), self.name)
        return dict(params)

    def plan(self, params: dict[str, Any]) -> list[Step]:
        def not_built(ctx: StepContext) -> dict[str, Any]:
            raise JobError(NOT_IMPLEMENTED.format(title=self.title, name=self.name))

        return [Step("not-built", self.title, not_built)]
