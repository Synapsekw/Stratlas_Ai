"""CSV formula injection guard, as the app's ``csvText`` (``@aio/schema``).

A text cell that a spreadsheet would run as a formula (it starts with ``=``, ``+``, ``-``, ``@``, a
tab or a carriage return) gets a leading apostrophe, so it shows as the text it is. Numbers, and
strings that are plain numbers such as ``-1.20``, are left as they are.
"""

from __future__ import annotations

from typing import Any

_FORMULA = ("=", "+", "-", "@", "\t", "\r")


def csv_text(v: Any) -> Any:
    if not isinstance(v, str) or not v.startswith(_FORMULA):
        return v
    try:
        float(v)
    except ValueError:
        return "'" + v
    return v
