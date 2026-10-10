"""Renames in the pipelines go through ``runtime.replace_over``.

Windows refuses to rename over a file (or to rename a file) that another process holds open: the
app reading an output again, a search indexer, antivirus scanning the file just written.
``replace_over`` waits for that reader; a direct ``os.replace``, ``Path.replace`` or ``shutil.move``
fails the job with ``PermissionError`` instead. This scan fails on a direct rename outside
``runtime.py`` that is not listed in ``ALLOWED``.
"""

import ast
from pathlib import Path

import aio_pipelines

SRC = Path(aio_pipelines.__file__).parent

#: The direct moves left on purpose, as "<file>: <call>" (the call as ``ast.unparse`` writes it).
ALLOWED = {
    # A folder moved aside (the earlier ortho tiles, into the job folder), not a file replaced:
    # ``os.replace`` cannot replace a folder that is not empty and a retry does not help it.
    "road/pipeline.py: shutil.move(str(old), str(keep))",
    # A pack built again while the app shows it: the rename is refused for as long as the app has
    # the old pack open, and ``shutil.move`` then copies over it. ``replace_over`` would fail there.
    "packs/raster.py: shutil.move(str(self.building), str(self.final))",
}

RENAMES = {"os": {"replace", "rename", "renames"}, "shutil": {"move"}}


def direct_renames(source: str) -> list[tuple[int, str]]:
    """(line, call) of each direct rename: ``os.replace`` / ``os.rename`` / ``shutil.move``, those
    names imported bare, and ``x.replace(target)`` / ``x.rename(target)`` (``pathlib``: one
    argument, where ``str.replace`` takes two and ``datetime.replace`` keywords)."""
    found = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.ImportFrom) and node.module in RENAMES:
            if any(a.name in RENAMES[node.module] for a in node.names):
                found.append((node.lineno, ast.unparse(node)))
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            owner = node.func.value.id if isinstance(node.func.value, ast.Name) else None
            if owner in RENAMES:
                direct = node.func.attr in RENAMES[owner]
            else:
                direct = node.func.attr in ("replace", "rename") and len(node.args) == 1 and not node.keywords
            if direct:
                found.append((node.lineno, ast.unparse(node)))
    return found


def test_the_scan_tells_a_rename_from_a_text_replace():
    source = (
        "from os import replace\n"
        "os.replace(tmp, dst)\n"
        "os.rename(tmp, dst)\n"
        "shutil.move(str(a), str(b))\n"
        "tmp.replace(dst)\n"
        "raw.with_suffix('.tmp.tif').rename(raw)\n"
        "name.replace('\\\\', '/')\n"
        "stamp.replace(tzinfo=None)\n"
        "replace_over(tmp, dst)\n"
        "shutil.copyfile(a, b)\n"
    )
    assert [line for line, _ in direct_renames(source)] == [1, 2, 3, 4, 5, 6]


def test_no_pipeline_renames_a_file_without_waiting_for_a_reader():
    found = {}
    for path in sorted(SRC.rglob("*.py")):
        rel = path.relative_to(SRC).as_posix()
        if rel == "runtime.py":
            continue
        for line, call in direct_renames(path.read_text("utf-8")):
            found.setdefault(f"{rel}: {call}", f"{rel}:{line}: {call}")
    direct = [where for key, where in found.items() if key not in ALLOWED]
    assert not direct, "Use runtime.replace_over (or atomic_write_bytes / AtomicPath):\n" + "\n".join(direct)
    stale = sorted(ALLOWED - set(found))
    assert not stale, "No longer in the code; take them off ALLOWED:\n" + "\n".join(stale)
