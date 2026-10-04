"""``python -m aio_pipelines``: serve JSON-RPC 2.0 on stdio. ``--version`` and ``--list`` print and exit."""

from __future__ import annotations

import io
import json
import os
import sys

from . import PROTOCOL, __version__


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    from .pipelines import all_pipelines

    if "--version" in args:
        print(json.dumps({"version": __version__, "protocol": PROTOCOL}))
        return 0
    if "--list" in args:
        print(json.dumps([{"name": p.name, "title": p.title} for p in all_pipelines().values()]))
        return 0

    from .rpc import Server

    return Server(*protocol_streams(), all_pipelines()).serve()


def protocol_streams() -> tuple[io.TextIOWrapper, io.TextIOWrapper]:
    """Move the protocol off fds 0 and 1 onto private duplicates.

    - Anything a library prints (Python or C) lands on stderr, which the app writes to the job
      log, so a stray print can never corrupt the message stream.
    - On Windows a blocking read on a synchronous pipe stalls every other operation on that same
      handle; libraries that probe stdin while importing (numpy does) would hang the job threads
      while the main thread waits for the next request. fd 0 becomes NUL, so nothing else
      touches the pipe.
    """
    proto_in = os.dup(0)
    proto_out = os.dup(1)
    nul = os.open(os.devnull, os.O_RDWR)
    os.dup2(nul, 0)
    os.dup2(2, 1)
    os.close(nul)
    sys.stdin = open(os.devnull, encoding="utf-8")  # noqa: SIM115 - lives for the whole process
    sys.stdout = sys.stderr
    reader = open(proto_in, encoding="utf-8", newline="\n")  # noqa: SIM115
    writer = open(proto_out, "w", encoding="utf-8", newline="\n")  # noqa: SIM115
    return reader, writer


if __name__ == "__main__":
    sys.exit(main())
