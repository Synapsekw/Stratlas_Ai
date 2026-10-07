"""Tileset files shared by ``tiles.mesh`` and ``tiles.cloud``.

- ``Tile``: one node of the tree (bounding box in the root's east-north-up frame, geometric error,
  content file, children) and its ``tileset.json`` form (3D Tiles 1.1, explicit tiling).
- ``tilesets.json`` (``aio.tilesets/1``, data-conventions section 22): the entry of a new tileset
  is added or replaced, the previous file kept as ``tilesets.json.bak``, written atomically.
- ``check_tileset``: the structural checks our tests run on every tileset we write (the full
  3d-tiles-validator runs in CI only, a development tool, never shipped).
"""

from __future__ import annotations

import json
import re
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from ..runtime import JobError, atomic_write_json, safe_project_path

TILESETS_FILE = "tilesets.json"
TILESET_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")


@dataclass
class Tile:
    key: str
    box: list[float]
    error: float
    content: str | None = None
    children: list[Tile] = field(default_factory=list)
    count: int = 0  # triangles or points in the content

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {"boundingVolume": {"box": self.box}, "geometricError": self.error}
        if self.content:
            out["content"] = {"uri": self.content}
        if self.children:
            out["children"] = [c.to_json() for c in self.children]
        return out

    def walk(self) -> list[Tile]:
        out = [self]
        for c in self.children:
            out.extend(c.walk())
        return out


def tileset_json(
    root: Tile, *, transform: list[float], refine: str, generator: str, extras: dict[str, Any]
) -> dict[str, Any]:
    r = root.to_json()
    r["transform"] = transform
    r["refine"] = refine
    half = np.asarray(root.box[3:], dtype=np.float64).reshape(3, 3)
    diag = float(2 * np.linalg.norm(half.sum(axis=0)))
    return {
        "asset": {"version": "1.1", "generator": generator},
        "geometricError": max(diag, root.error * 2, 1.0),
        "root": r,
        "extras": {"aio": extras},
    }


def safe_tileset_id(raw: str) -> str:
    s = re.sub(r"[^A-Za-z0-9._-]+", "-", raw).strip("-._")[:80] or "tileset"
    if not s[0].isalnum():
        s = "t" + s
    return s[:80]


def read_tilesets(project: Path) -> dict[str, Any]:
    path = safe_project_path(project, TILESETS_FILE)
    if not path.is_file():
        return {"schema": "aio.tilesets/1", "entries": []}
    try:
        data = json.loads(path.read_text("utf-8-sig"))
    except (OSError, ValueError) as e:
        raise JobError(f"tilesets.json could not be read: {e}") from e
    if (
        not isinstance(data, dict)
        or data.get("schema") != "aio.tilesets/1"
        or not isinstance(data.get("entries"), list)
    ):
        raise JobError("tilesets.json is not an aio.tilesets/1 file; fix or remove it first.")
    return data


def upsert_tileset(project: Path, entry: dict[str, Any]) -> None:
    """Add or replace one entry of ``tilesets.json``; the previous file is kept as ``.bak``."""
    path = safe_project_path(project, TILESETS_FILE)
    data = read_tilesets(project)
    entries = [e for e in data["entries"] if not (isinstance(e, dict) and e.get("id") == entry["id"])]
    at = next(
        (i for i, e in enumerate(data["entries"]) if isinstance(e, dict) and e.get("id") == entry["id"]), None
    )
    if at is None:
        entries.append(entry)
    else:
        # Keep what the person set on the old entry (visibility, placement), refresh the rest.
        old = data["entries"][at]
        merged = {**old, **entry, "visible": old.get("visible", True)}
        entries.insert(at, merged)
    if path.is_file():
        shutil.copyfile(path, path.with_name(TILESETS_FILE + ".bak"))
    atomic_write_json(path, {**data, "entries": entries})


def replace_folder(project: Path, rel: str) -> Path:
    """The project folder a tileset is written to, emptied of an older build."""
    folder = safe_project_path(project, rel)
    if folder.exists():
        shutil.rmtree(folder)
    return folder


def _box_corners(box: list[float]) -> np.ndarray:
    c = np.asarray(box[:3])
    h = np.asarray(box[3:], dtype=np.float64).reshape(3, 3)
    signs = np.array([[sx, sy, sz] for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)], dtype=np.float64)
    return c + signs @ h


def _inside(points: np.ndarray, box: list[float], tol: float) -> bool:
    c = np.asarray(box[:3])
    h = np.asarray(box[3:], dtype=np.float64).reshape(3, 3)
    lengths = np.linalg.norm(h, axis=1)
    axes = h / np.maximum(lengths, 1e-12)[:, None]
    local = (points - c) @ axes.T
    return bool(np.all(np.abs(local) <= lengths + tol))


def check_tileset(folder: Path, tol: float = 1e-3) -> list[str]:
    """Problems found in a tileset we wrote ([] when it passes). Content positions are read back
    from the GLB (node translation plus positions, y-up to z-up) and must lie in their tile box;
    a child's box lies in its parent's; geometric error falls toward the leaves."""
    from .gltf import read_glb
    from .transform import gltf_to_enu

    problems: list[str] = []
    ts = json.loads((folder / "tileset.json").read_text("utf-8"))
    if ts.get("asset", {}).get("version") not in ("1.0", "1.1"):
        problems.append("asset.version must be 1.0 or 1.1")
    root = ts.get("root") or {}
    if len(root.get("transform") or []) != 16:
        problems.append("the root has no 4 x 4 transform")
    if ts.get("geometricError", -1) < root.get("geometricError", 0):
        problems.append("the tileset error is below the root's")

    def visit(t: dict[str, Any], parent: dict[str, Any] | None, path: str) -> None:
        box = t.get("boundingVolume", {}).get("box")
        if not isinstance(box, list) or len(box) != 12:
            problems.append(f"{path}: no bounding box")
            return
        if parent is not None:
            if t["geometricError"] > parent["geometricError"]:
                problems.append(f"{path}: geometric error above its parent's")
            if not _inside(_box_corners(box), parent["boundingVolume"]["box"], tol):
                problems.append(f"{path}: box outside its parent's")
        content = t.get("content", {}).get("uri")
        if content:
            f = folder / content
            if not f.is_file():
                problems.append(f"{path}: content {content} is missing")
            else:
                gltf, prims = read_glb(f.read_bytes())
                tr = np.asarray(gltf["nodes"][0].get("translation", [0, 0, 0]), dtype=np.float64)
                for p in prims:
                    pos = gltf_to_enu(p["POSITION"].astype(np.float64) + tr)
                    if not _inside(pos, box, tol):
                        problems.append(f"{path}: content outside its box")
                    if "indices" in p and len(p["indices"]) and p["indices"].max() >= len(p["POSITION"]):
                        problems.append(f"{path}: an index points past the vertices")
        for i, c in enumerate(t.get("children") or []):
            visit(c, t, f"{path}/{i}")

    visit(root, None, "root")
    return problems


def is_tileset_id(s: Any) -> bool:
    return isinstance(s, str) and bool(TILESET_ID.match(s))
