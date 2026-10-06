"""What the cloud and model change pipelines share: layers, dates, frames and derived layers.

- Layers are read from the project manifest by id; packages (``hash`` sources) are refused.
- The date pair comes from the ``captures`` parameter, else from the layers' own ``capture``
  (Python cannot apply the app's naming rules, data-conventions section 13).
- The project local frame is x east, y up, z south from the manifest ``origin`` [E, N, H]
  (data-conventions section 1).
- A derived layer is added to the manifest last, replacing an earlier one with the same id, with
  ``manifest.json.bak`` kept as the app's own saves do (data-conventions section 14).
"""

from __future__ import annotations

import json
import shutil
from collections.abc import Iterable, Sequence
from pathlib import Path, PurePosixPath
from typing import Any

import numpy as np

from ..runtime import JobError, atomic_write_json, safe_project_path

NO_DATES = (
    "Say which survey date each layer belongs to (Belongs to date... in the layer menu), "
    "or run the comparison from Compare dates."
)


def read_manifest(project: Path) -> dict[str, Any]:
    path = safe_project_path(project, "manifest.json")
    try:
        return json.loads(path.read_text("utf-8-sig"))
    except (OSError, ValueError) as e:
        raise JobError(f"The project manifest could not be read: {e}") from e


def find_layer(manifest: dict[str, Any], layer_id: str, kind: str, what: str) -> dict[str, Any]:
    for layer in manifest.get("layers") or []:
        if isinstance(layer, dict) and layer.get("id") == layer_id:
            if layer.get("kind") != kind:
                raise JobError(f'The layer "{layer_id}" is not a {what}.')
            return layer
    raise JobError(f'The project has no layer "{layer_id}".')


def layer_file(project: Path, layer: dict[str, Any]) -> Path:
    src = layer.get("src") or {}
    rel = src.get("path")
    if not isinstance(rel, str) or not rel:
        raise JobError(
            f'The layer "{layer.get("id")}" is stored inside a package; open the project folder instead.'
        )
    path = Path(rel) if Path(rel).is_absolute() else safe_project_path(project, rel)
    if not path.is_file():
        raise JobError(f'The file of the layer "{layer.get("id")}" is missing: {rel}')
    return path


def capture_pair(params: dict[str, Any], a: dict[str, Any], b: dict[str, Any]) -> tuple[str, str]:
    given = params.get("captures")
    if isinstance(given, dict) and given.get("from") and given.get("to"):
        pair = (str(given["from"]), str(given["to"]))
    elif a.get("capture") and b.get("capture"):
        pair = (str(a["capture"]), str(b["capture"]))
    else:
        raise JobError(NO_DATES)
    if pair[0] == pair[1]:
        raise JobError("The two layers belong to the same survey date; pick one layer of each date.")
    return pair


def capture_label(manifest: dict[str, Any], capture_id: str) -> str:
    for c in manifest.get("captures") or []:
        if isinstance(c, dict) and c.get("id") == capture_id:
            return str(c.get("date") or c.get("label") or capture_id)
    return capture_id


def origin_of(manifest: dict[str, Any]) -> np.ndarray:
    o = manifest.get("origin")
    if not (isinstance(o, list) and len(o) == 3 and all(isinstance(v, int | float) for v in o)):
        raise JobError("The project has no origin, so its layers cannot be compared.")
    return np.array(o, dtype=np.float64)


def crs_to_local(xyz: np.ndarray, origin: np.ndarray) -> np.ndarray:
    """[E, N, H] rows to the local frame [x east, y up, z south]."""
    xyz = np.asarray(xyz, dtype=np.float64).reshape(-1, 3)
    return np.column_stack([xyz[:, 0] - origin[0], xyz[:, 2] - origin[2], origin[1] - xyz[:, 1]])


def local_to_crs(xyz: np.ndarray, origin: np.ndarray) -> np.ndarray:
    xyz = np.asarray(xyz, dtype=np.float64).reshape(-1, 3)
    return np.column_stack([origin[0] + xyz[:, 0], origin[1] - xyz[:, 2], origin[2] + xyz[:, 1]])


def lonlat(
    manifest: dict[str, Any], east: Sequence[float], north: Sequence[float]
) -> list[list[float]] | None:
    """Longitude and latitude of project CRS points; None when the CRS is unknown."""
    epsg = (manifest.get("crs") or {}).get("epsg")
    if not isinstance(epsg, int) or not len(east):
        return None
    try:
        from rasterio.warp import transform

        lon, lat = transform(f"EPSG:{epsg}", "EPSG:4326", list(map(float, east)), list(map(float, north)))
    except Exception:
        return None
    return [[round(a, 8), round(b, 8)] for a, b in zip(lon, lat, strict=True)]


def rounded(values: Iterable[float], digits: int = 3) -> list[float]:
    return [round(float(v), digits) for v in values]


def default_out(set_id: str) -> str:
    return f"change/{set_id}"


def project_rel(path: str) -> str:
    return PurePosixPath(path.replace("\\", "/")).as_posix()


def upsert_layer(project: Path, layer: dict[str, Any]) -> None:
    """Add a derived layer to the manifest, replacing the one with the same id (with a .bak)."""
    mpath = safe_project_path(project, "manifest.json")
    manifest = read_manifest(project)
    layers = manifest.setdefault("layers", [])
    for i, existing in enumerate(layers):
        if isinstance(existing, dict) and existing.get("id") == layer["id"]:
            derived = existing.get("derived")
            if not isinstance(derived, dict) or derived.get("kind") != "change":
                raise JobError(
                    f'The project already has a layer "{layer["id"]}" of its own; rename it first.'
                )
            # keep what the person set on it (shown or hidden, its date)
            layer = {**layer, "visible": existing.get("visible", True)}
            layers[i] = layer
            break
    else:
        layers.append(layer)
    shutil.copyfile(mpath, mpath.with_name("manifest.json.bak"))
    atomic_write_json(mpath, manifest, indent=2)
