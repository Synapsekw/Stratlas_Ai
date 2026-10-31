"""Ids the import writes, kept within the schema's 128 characters (`Id` in @aio/schema)."""

from __future__ import annotations

import hashlib

ID_MAX = 128


def cap_id(v: str) -> str:
    """``v`` when it fits; else its first characters, ``-`` and 8 hex of its SHA-1, 128 in all.

    Deterministic, so a re-import finds the same layer, photo and finding again, and two long ids
    that share their first 119 characters still differ.
    """
    if len(v) <= ID_MAX:
        return v
    digest = hashlib.sha1(v.encode("utf-8")).hexdigest()[:8]
    return f"{v[: ID_MAX - 9]}-{digest}"
