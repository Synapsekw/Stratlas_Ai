"""Individual component records; all coordinates are project-local x-east/y-up/z-south metres."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ALGORITHM = "components/7"


@dataclass
class Observation:
    id: str
    kind: str
    centre: tuple[float, float, float]
    size: tuple[float, float, float]
    azimuth_deg: float
    tilt_deg: float
    quality: dict[str, dict[str, Any]]
    sources: list[dict[str, str]]
    name: str | None = None
    parent: str | None = None
    notes: list[str] | None = None

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "id": self.id,
            "kind": self.kind,
            "centre": [float(v) for v in self.centre],
            "size": [float(v) for v in self.size],
            "azimuthDeg": float(self.azimuth_deg) % 360,
            "tiltDeg": float(self.tilt_deg),
            "quality": self.quality,
            "sources": self.sources,
        }
        for key in ("name", "parent", "notes"):
            v = getattr(self, key)
            if v is not None:
                d[key] = v
        return d


def measurement_frame(project: Path, manifest: dict, params: dict) -> dict:
    """Record the *effective* source frame; never bake the cloud offset into the project origin.

    The signature also covers source identity/stat information and algorithm version. The runtime
    owns input-resume checks; this record lets assemblers reject a pack made in another frame.
    It is a local cache signature, not a content hash or permission to send sources externally.
    """
    sources, files = [], []
    selected = [*params.get("clouds", []), *params.get("meshes", [])]
    for ref in selected:
        layer = next((x for x in manifest.get("layers", []) if x["id"] == ref["layer"]), None)
        if layer is None:
            continue
        src = layer.get("src", {})
        record = {
            "layer": ref["layer"],
            "kind": "cloud" if layer["kind"] == "pointcloud" else "mesh",
            "heightOffsetM": float(layer.get("heightOffsetM") or 0),
        }
        if layer.get("transform") is not None:
            record["transform"] = layer["transform"]
        if src.get("hash"):
            record["contentHash"] = src["hash"]
        sources.append(record)
        if src.get("path"):
            files.append(src["path"])
    files += [p["path"] for p in [*params.get("photos", []), *params.get("drawings", [])]]
    if params.get("cameraPoses"):
        files.append(params["cameraPoses"]["path"])
    inventory = []
    for name in sorted(set(files)):
        path = Path(name)
        path = path if path.is_absolute() else project / path
        try:
            stat = path.stat()
            inventory.append([name, stat.st_size, stat.st_mtime_ns])
        except OSError:
            inventory.append([name, None, None])
    frame = {
        "coordinates": "project-local",
        "origin": manifest.get("origin", [0, 0, 0]),
        "algorithm": ALGORITHM,
        "sources": sources,
    }
    blob = json.dumps([frame, manifest.get("crs"), inventory], sort_keys=True, separators=(",", ":"))
    return {**frame, "signature": hashlib.sha256(blob.encode()).hexdigest()}
