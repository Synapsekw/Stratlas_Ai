"""The pipelines this pack offers. Heavy libraries load inside the steps, so listing is fast."""

from __future__ import annotations

from .runtime import Pipeline
from .selftest import SelfTest


def all_pipelines() -> dict[str, Pipeline]:
    items: list[Pipeline] = [SelfTest()]
    return {p.name: p for p in items}
