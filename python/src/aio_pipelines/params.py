"""Small parameter checks shared by the pipelines (the app validates the same shapes with zod)."""

from __future__ import annotations

from typing import Any

from .runtime import JobError


def known_keys(params: dict[str, Any], allowed: set[str], pipeline: str) -> None:
    extra = sorted(set(params) - allowed)
    if extra:
        raise JobError(f"{pipeline} does not take: {', '.join(extra)}.")


def text(params: dict[str, Any], key: str, default: str | None = None, required: bool = False) -> str | None:
    v = params.get(key, default)
    if v is None:
        if required:
            raise JobError(f"{key} is required.")
        return None
    if not isinstance(v, str) or not v.strip():
        raise JobError(f"{key} must be a non-empty text.")
    return v


def number(
    params: dict[str, Any],
    key: str,
    default: float | None = None,
    lo: float | None = None,
    hi: float | None = None,
    integer: bool = False,
) -> float | None:
    v = params.get(key, default)
    if v is None:
        return None
    if isinstance(v, bool) or not isinstance(v, int | float):
        raise JobError(f"{key} must be a number.")
    if integer and int(v) != v:
        raise JobError(f"{key} must be a whole number.")
    if (lo is not None and v < lo) or (hi is not None and v > hi):
        raise JobError(f"{key} must be between {lo} and {hi}.")
    return int(v) if integer else float(v)


def numbers(params: dict[str, Any], key: str, n: int) -> list[float] | None:
    v = params.get(key)
    if v is None:
        return None
    if (
        not isinstance(v, list)
        or len(v) != n
        or not all(isinstance(x, int | float) and not isinstance(x, bool) for x in v)
    ):
        raise JobError(f"{key} must be a list of {n} numbers.")
    return [float(x) for x in v]
