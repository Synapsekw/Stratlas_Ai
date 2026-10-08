"""Pipelines the app already names (contracts first, M11 step G0) whose work is not built yet.

A stub checks its parameters like the real pipeline will (the names, the required ones and the
fixed choices of ``@aio/schema`` ``jobs.ts``), then fails its one step with a clear ``JobError``
the Jobs panel shows as is. Each M11 stream replaces the stub class in its own module
(``survey/compare.py`` and so on) without touching ``pipelines.py``; the last one deletes this file.
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
    #: The names the contract requires.
    required: ClassVar[frozenset[str]] = frozenset()
    #: Parameters with a fixed set of text values (a list parameter checks each item).
    choices: ClassVar[dict[str, frozenset[str]]] = {}

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(params, set(self.keys), self.name)
        missing = sorted(k for k in self.required if params.get(k) is None)
        if missing:
            raise JobError(f"{self.name} needs: {', '.join(missing)}.")
        for key, allowed in self.choices.items():
            if key not in params:
                continue
            value = params[key]
            values = value if isinstance(value, list) else [value]
            bad = [v for v in values if not isinstance(v, str) or v not in allowed]
            if bad or (isinstance(value, list) and not value):
                raise JobError(f"{key} must be one of: {', '.join(sorted(allowed))}.")
        return dict(params)

    def plan(self, params: dict[str, Any]) -> list[Step]:
        def not_built(ctx: StepContext) -> dict[str, Any]:
            raise JobError(NOT_IMPLEMENTED.format(title=self.title, name=self.name))

        return [Step("not-built", self.title, not_built)]


def exactly_one(a: bool, b: bool, message: str) -> None:
    """The contract's ``refine``: exactly one of two alternatives is given."""
    if a == b:
        raise JobError(message)
