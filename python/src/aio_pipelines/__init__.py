"""Quadrion AI pipeline pack.

The desktop app spawns ``python -m aio_pipelines`` and talks JSON-RPC 2.0 over stdio, one JSON
object per line. Bulk data never crosses the pipe: pipelines read and write files in the project
folder, staging their outputs under ``<project>/jobs/<jobId>/`` and moving them into place at the
end so a cancelled or crashed job never leaves the project half-written.
"""

from importlib.metadata import PackageNotFoundError, version

try:
    __version__ = version("aio-pipelines")
except PackageNotFoundError:  # running from a source checkout without an install
    __version__ = "0.0.0+src"

PROTOCOL = "aio.pipelines/1"

# App versions this pack works with (M9; pack 0.5.0 of M11 needs app 0.11). The app refuses a pack
# outside the range; the syntax is read by `appRangeAllows` in packages/schema/src/versions.ts
# (space-separated >=, >, <=, <, =).
APP_RANGE = ">=0.11.0 <2.0.0"
