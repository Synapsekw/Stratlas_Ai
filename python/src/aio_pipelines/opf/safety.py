"""Checks an OPF project folder before pyopf reads anything (hostile inputs, plan "Review focus").

pyopf follows every URI it is given: absolute ``file://`` URIs, ``..`` and glTF buffers anywhere
on disk, and it memory-maps glTF accessors at whatever size they declare. So before it opens the
project, every resource URI and every glTF buffer is checked here:

- relative URI references only, no ``..``, no drive letter, no scheme, resolving inside the OPF
  folder (symbolic links included); anything else refuses the whole import with the URI named;
- JSON resources and glTF files have a size limit; glTF buffers must be separate files in the
  folder, and every accessor must fit inside its buffer file (a declared count larger than the
  data refuses the import instead of mapping memory that is not there).

Photo URIs are not resources: they are resolved by the importer (``photos.py`` rules), and an
absolute photo path is only ever looked up inside the photos folder the person chose.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import unquote, urlparse

from ..runtime import JobError

MAX_PROJECT_BYTES = 64 * 1024**2
MAX_JSON_BYTES = 512 * 1024**2
MAX_GLTF_BYTES = 64 * 1024**2
MAX_ITEMS = 10_000
#: Points per point cloud this build imports (positions are converted in memory).
MAX_CLOUD_POINTS = 60_000_000

GLTF_COMPONENT_BYTES = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}
GLTF_TYPE_COUNT = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def _gb(n: int) -> str:
    return f"{n / 1024**3:.1f} GB" if n >= 1024**3 else f"{n / 1024**2:.0f} MB"


def relative_uri(uri: Any) -> str | None:
    """The relative POSIX path of a URI reference, or None when it is absolute or leaves its folder."""
    if not isinstance(uri, str) or not uri.strip():
        return None
    u = uri.strip()
    if re.match(r"^[A-Za-z]:[\\/]", u) or u.startswith(("/", "\\")):
        return None
    parsed = urlparse(u)
    if parsed.scheme or parsed.netloc:
        return None
    path = unquote(parsed.path).replace("\\", "/")
    pp = PurePosixPath(path)
    if not path or pp.is_absolute() or ".." in pp.parts or re.match(r"^[A-Za-z]:", path):
        return None
    return pp.as_posix()


def inside(root: Path, rel: str) -> Path | None:
    """``root/rel`` resolved, or None when it resolves outside ``root`` (a link pointing out)."""
    try:
        full = (root / rel).resolve()
        full.relative_to(root.resolve())
        return full
    except (OSError, ValueError):
        return None


def resource_path(root: Path, uri: Any, what: str) -> Path:
    rel = relative_uri(uri)
    full = inside(root, rel) if rel is not None else None
    if full is None:
        raise JobError(
            f'The OPF project refers to "{str(uri)[:200]}" ({what}), which is an absolute path or outside the '
            "OPF folder. Only files inside the OPF folder are read; move the files next to the project and "
            "import again."
        )
    return full


@dataclass
class Checked:
    """The project file as parsed, with what the check found."""

    project: dict[str, Any]
    missing: list[str] = field(default_factory=list)
    clouds: dict[str, int] = field(default_factory=dict)  # glTF relative path -> points


def _json_file(path: Path, limit: int, what: str) -> Any:
    size = path.stat().st_size
    if size > limit:
        raise JobError(f"{what} {path.name} is {_gb(size)}; the limit is {_gb(limit)}.")
    try:
        return json.loads(path.read_text("utf-8-sig"))
    except (OSError, UnicodeDecodeError, ValueError) as e:
        raise JobError(f"{what} {path.name} is not valid JSON: {e}") from e


def check_gltf(root: Path, gltf_path: Path) -> int:
    """Check an OPF glTF point cloud's buffers and accessors; return its point count."""
    rel_name = gltf_path.relative_to(root.resolve()).as_posix()
    doc = _json_file(gltf_path, MAX_GLTF_BYTES, "The point cloud")
    if not isinstance(doc, dict):
        raise JobError(f"The point cloud {rel_name} is not a glTF file.")
    buffers = doc.get("buffers") or []
    sizes: list[int] = []
    for b in buffers:
        uri = b.get("uri") if isinstance(b, dict) else None
        if not isinstance(uri, str) or uri.startswith("data:"):
            raise JobError(
                f"The point cloud {rel_name} embeds its data; OPF point clouds keep it in .bin files."
            )
        rel = relative_uri(uri)
        full = inside(gltf_path.parent, rel) if rel is not None else None
        if full is None or not full.is_relative_to(root.resolve()):
            raise JobError(
                f'The point cloud {rel_name} refers to "{uri[:200]}", which is an absolute path or outside the '
                "OPF folder."
            )
        if not full.is_file():
            raise JobError(f"The point cloud {rel_name} needs {uri}, which is missing.")
        sizes.append(full.stat().st_size)
    views = doc.get("bufferViews") or []
    for i, v in enumerate(views):
        if (
            not isinstance(v, dict)
            or not isinstance(v.get("buffer"), int)
            or not 0 <= v["buffer"] < len(sizes)
        ):
            raise JobError(f"The point cloud {rel_name} has a broken buffer view {i}.")
        off, length = int(v.get("byteOffset") or 0), int(v.get("byteLength") or 0)
        if off < 0 or length < 0 or off + length > sizes[v["buffer"]]:
            raise JobError(
                f"The point cloud {rel_name} declares {length} bytes at {off} in a buffer of "
                f"{sizes[v['buffer']]} bytes; the file is damaged or incomplete."
            )
    points = 0
    for i, a in enumerate(doc.get("accessors") or []):
        if (
            not isinstance(a, dict)
            or not isinstance(a.get("bufferView"), int)
            or not 0 <= a["bufferView"] < len(views)
        ):
            raise JobError(f"The point cloud {rel_name} has a broken accessor {i}.")
        count = a.get("count")
        each = GLTF_COMPONENT_BYTES.get(a.get("componentType"), 0) * GLTF_TYPE_COUNT.get(a.get("type"), 0)
        if not isinstance(count, int) or count < 0 or each == 0:
            raise JobError(f"The point cloud {rel_name} has an accessor {i} this build cannot read.")
        view = views[a["bufferView"]]
        off = int(view.get("byteOffset") or 0)
        if off + count * each > sizes[view["buffer"]]:
            raise JobError(
                f"The point cloud {rel_name} declares {count:,} values in accessor {i}, more than its data "
                "holds; the file is damaged or not an OPF point cloud."
            )
    for mesh in doc.get("meshes") or []:
        for prim in (mesh or {}).get("primitives") or []:
            pos = ((prim or {}).get("attributes") or {}).get("POSITION")
            if isinstance(pos, int) and 0 <= pos < len(doc.get("accessors") or []):
                points += int(doc["accessors"][pos]["count"])
    if points > MAX_CLOUD_POINTS:
        raise JobError(
            f"The point cloud {rel_name} has {points:,} points; this build imports up to {MAX_CLOUD_POINTS:,}. "
            "Import a thinned cloud."
        )
    return points


def check_project(src: Path) -> Checked:
    """Check the ``.opf`` project and everything it refers to (see the module notes)."""
    if not src.is_file():
        raise JobError(f'The OPF project "{src}" does not exist.')
    root = src.parent
    doc = _json_file(src, MAX_PROJECT_BYTES, "The OPF project")
    if not isinstance(doc, dict) or doc.get("format") != "application/opf-project+json":
        raise JobError(f"{src.name} is not an OPF project (format application/opf-project+json).")
    version = str(doc.get("version") or "")
    if not re.match(r"^1\.\d+", version):
        raise JobError(f"{src.name} is OPF version {version or 'unknown'}; this build reads OPF 1.x.")
    items = doc.get("items")
    if not isinstance(items, list) or len(items) > MAX_ITEMS:
        raise JobError(f"{src.name} has no item list, or more than {MAX_ITEMS} items.")
    out = Checked(doc)
    for item in items:
        if not isinstance(item, dict):
            raise JobError(f"{src.name} has an item that is not an object.")
        for res in item.get("resources") or []:
            uri = res.get("uri") if isinstance(res, dict) else None
            fmt = str(res.get("format") or "") if isinstance(res, dict) else ""
            path = resource_path(root, uri, f"a {item.get('type')} resource")
            rel = path.relative_to(root.resolve()).as_posix()
            if not path.is_file():
                out.missing.append(rel)
                continue
            if fmt.endswith("+json") and fmt != "model/gltf+json":
                size = path.stat().st_size
                if size > MAX_JSON_BYTES:
                    raise JobError(f"The OPF file {rel} is {_gb(size)}; the limit is {_gb(MAX_JSON_BYTES)}.")
            if fmt == "model/gltf+json" or path.suffix.lower() == ".gltf":
                out.clouds[rel] = check_gltf(root, path)
    return out
