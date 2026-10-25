"""What the cloud and model change pipelines share: layers, dates, frames and derived layers.

- Layers are read from the project manifest by id; packages (``hash`` sources) are refused.
- The date pair comes from the ``captures`` parameter, else from the layers' own ``capture``
  (Python cannot apply the app's naming rules, data-conventions section 13).
- The project local frame is x east, y up, z south from the manifest ``origin`` [E, N, H]
  (data-conventions section 1).
- A derived layer is added to the manifest last, replacing an earlier one with the same id, with
  ``manifest.json.bak`` kept as the app's own saves do (data-conventions section 14). Every change
  to the manifest goes through ``update_manifest``, under the project's manifest lock.
- An area comparison (a run with a ``scope``) leaves one layer, ``area_layer_id``, whichever of
  its producers ends first; each of its change sets lists it, so removing that row removes them.
"""

from __future__ import annotations

import json
import shutil
from collections.abc import Callable, Iterable, Sequence
from pathlib import Path, PurePosixPath
from typing import Any

import numpy as np

from ..runtime import JobError, atomic_write_json, manifest_lock, safe_project_path
from .changeset import change_set_id

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


def update_manifest(project: Path, change: Callable[[dict[str, Any]], None]) -> dict[str, Any]:
    """Read the manifest, apply ``change`` to it and write it back (with a .bak), all under the
    project's manifest lock so that two jobs committing at once both keep what they added."""
    mpath = safe_project_path(project, "manifest.json")
    with manifest_lock(project):
        manifest = read_manifest(project)
        change(manifest)
        shutil.copyfile(mpath, mpath.with_name("manifest.json.bak"))
        atomic_write_json(mpath, manifest, indent=2)
    return manifest


def _is_change(layer: Any) -> bool:
    derived = layer.get("derived") if isinstance(layer, dict) else None
    return isinstance(derived, dict) and derived.get("kind") == "change"


def _own_layer(layer_id: str) -> JobError:
    return JobError(f'The project already has a layer "{layer_id}" of its own; rename it first.')


def upsert_layer(project: Path, layer: dict[str, Any]) -> None:
    """Add a derived layer to the manifest, replacing the one with the same id (with a .bak)."""

    def change(manifest: dict[str, Any]) -> None:
        layers = manifest.setdefault("layers", [])
        for i, existing in enumerate(layers):
            if isinstance(existing, dict) and existing.get("id") == layer["id"]:
                if not _is_change(existing):
                    raise _own_layer(layer["id"])
                # keep what the person set on it (shown or hidden, its date)
                layers[i] = {**layer, "visible": existing.get("visible", True)}
                return
        layers.append(layer)

    update_manifest(project, change)


def area_layer_id(from_capture: str, to_capture: str, scope_id: str) -> str:
    """The one layer of an area's comparison of a date pair, shared by its producers."""
    return change_set_id(from_capture, to_capture, "change.change", scope_id)


def area_layer_name(scope_name: str, when: str) -> str:
    return f"{scope_name}: change, {when}"


def place_area_layer(
    manifest: dict[str, Any], layer: dict[str, Any], *, replace: bool, drop: Iterable[str] = ()
) -> None:
    """Put an area comparison's one layer in ``manifest``.

    The first producer to end adds it. A later one replaces it when ``replace`` (the imagery heat
    map is the row's picture), else keeps it; either way the person's visibility stays and the
    row's ``derived.source`` takes the later run's layers too, so removing any of them removes the
    row and, through it, every set of the comparison. ``drop`` are the per-set rows that area runs
    made before (``<set>-heat``, ``<set>-regions``): removed when they are change layers.
    """
    gone = set(drop)
    layers = [
        x
        for x in manifest.get("layers") or []
        if not (isinstance(x, dict) and x.get("id") in gone and _is_change(x))
    ]
    manifest["layers"] = layers
    for i, existing in enumerate(layers):
        if not (isinstance(existing, dict) and existing.get("id") == layer["id"]):
            continue
        if not _is_change(existing):
            raise _own_layer(layer["id"])
        source = list(existing["derived"].get("source") or [])
        for s in layer.get("derived", {}).get("source") or []:
            if s not in source:
                source.append(s)
        base = layer if replace else existing
        layers[i] = {
            **base,
            "visible": existing.get("visible", True),
            "derived": {**base["derived"], "source": source},
        }
        return
    layers.append(layer)
