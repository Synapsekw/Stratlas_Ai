"""Stratlas pipeline pack.

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
