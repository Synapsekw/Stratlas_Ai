"""The pack declares the app versions it works with (``appRange``, M9 T8).

The app refuses a pack outside the range with a clear message (``packRangeRefusal`` in
``packages/schema/src/versions.ts``); the range syntax here must stay what that parser reads:
space-separated comparators ``>=``, ``>``, ``<=``, ``<`` or ``=`` and a dotted version.
"""

import json
import re
import subprocess
import sys

from aio_pipelines import APP_RANGE, PROTOCOL
from aio_pipelines.rpc import Server

COMPARATOR = re.compile(r"^(>=|<=|>|<|=)?\d+(\.\d+){0,2}(-[0-9A-Za-z.-]+)?$")


def test_app_range_is_readable_by_the_app():
    parts = APP_RANGE.split()
    assert parts, "empty app range"
    assert all(COMPARATOR.match(p) for p in parts), APP_RANGE


def test_app_range_covers_0_11_and_1_x_but_not_0_10():
    # Pack 0.5.0 (M11) runs pipelines an 0.10 app does not know; decision 11 ships M11 as 1.2.0.
    assert APP_RANGE == ">=0.11.0 <2.0.0"


def test_version_flag_reports_the_range():
    out = subprocess.run(
        [sys.executable, "-m", "aio_pipelines", "--version"], capture_output=True, text=True, check=True
    )
    info = json.loads(out.stdout)
    assert info["appRange"] == APP_RANGE
    assert info["protocol"] == PROTOCOL


def test_version_method_reports_the_range():
    result = Server.__dict__["_version"](None, 1, {})
    assert result["appRange"] == APP_RANGE
