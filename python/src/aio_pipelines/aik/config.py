"""A kit job: job.yaml (or the same structure inline) merged with its vertical profile.

Ported from Asset Inspection Kit ``kit/config.py``. Brands are not needed by the pipelines here
(they style the viewer and PDF), so a missing brand is not an error.
"""

from __future__ import annotations

import copy
import os
from pathlib import Path
from typing import Any

import yaml

from ..runtime import JobError

PROFILES = Path(__file__).parent / "profiles"


def deep_merge(base: dict[str, Any], over: dict[str, Any] | None) -> dict[str, Any]:
    out = copy.deepcopy(base)
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


def profile_ids() -> list[str]:
    return sorted(p.stem for p in PROFILES.glob("*.yaml"))


class KitJob:
    def __init__(self, raw: dict[str, Any], base_dir: Path | str):
        if not isinstance(raw, dict):
            raise JobError("The kit job must be an object with job, inputs and asset sections.")
        self.raw = raw
        self.dir = str(base_dir)
        self.job = raw.get("job", {}) or {}
        prof_id = self.job.get("profile") or self.job.get("asset_type") or "stack"
        pf = PROFILES / f"{prof_id}.yaml"
        if not pf.exists():
            raise JobError(f'Unknown profile "{prof_id}". Known profiles: {", ".join(profile_ids())}.')
        self.profile = deep_merge(yaml.safe_load(pf.read_text("utf-8")), raw.get("profile", {}))
        self.inputs = raw.get("inputs", {}) or {}
        self.asset = raw.get("asset", {}) or {}

    @classmethod
    def load(cls, path: Path) -> KitJob:
        try:
            raw = yaml.safe_load(path.read_text("utf-8"))
        except (OSError, yaml.YAMLError) as e:
            raise JobError(f"Could not read the kit job {path.name}: {e}") from e
        return cls(raw, path.parent)

    def p(self, rel: str | None) -> str | None:
        """Resolve a job-relative path."""
        if rel is None:
            return None
        return rel if os.path.isabs(rel) else os.path.normpath(os.path.join(self.dir, rel))
