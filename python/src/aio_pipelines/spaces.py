"""The spaces of a project: the frame (crs and origin) a layer's files are written in.

Mirrors ``spacesOf``, ``spaceOfLayer`` and ``layerFrame`` in packages/schema/src/spaces.ts
(data-conventions section 40). A layer that names a listed space (a confined-space drone's local
space, for one) is read against that space's origin; every other layer against the project's.
"""

from __future__ import annotations

from typing import Any

from .runtime import JobError

DEFAULT_SPACE_ID = "main"


def space_of_layer(layer: dict[str, Any]) -> str:
    """The space a layer is in (``main`` when it names none)."""
    return str(layer.get("space") or DEFAULT_SPACE_ID)


def _listed_space(manifest: dict[str, Any], sid: str) -> dict[str, Any] | None:
    listed = [s for s in manifest.get("spaces") or [] if isinstance(s, dict)]
    every_named = bool(listed) and all(
        isinstance(x, dict) and x.get("space") is not None for x in manifest.get("layers") or []
    )
    if not every_named:
        if sid == DEFAULT_SPACE_ID:
            return None  # the implicit main space: the project's own frame
        listed = [s for s in listed if s.get("id") != DEFAULT_SPACE_ID]
    return next((s for s in listed if s.get("id") == sid), None)


def layer_frame(manifest: dict[str, Any], layer: dict[str, Any]) -> dict[str, Any]:
    """``{"crs", "origin"}`` of the layer's space, else the project's (a space it does not list)."""
    s = _listed_space(manifest, space_of_layer(layer))
    src = s if s is not None else manifest
    return {"crs": src.get("crs"), "origin": [float(v) for v in (src.get("origin") or [0, 0, 0])]}


def layer_frame_origin(manifest: dict[str, Any], layer: dict[str, Any]) -> list[float]:
    """The origin a layer's local coordinates are read against: its space's, else the project's."""
    return layer_frame(manifest, layer)["origin"]


def in_project_frame(manifest: dict[str, Any], layer: dict[str, Any], origin: bool = True) -> bool:
    """Whether a layer is read in the project's own frame: its crs, and (unless ``origin`` is
    False) its origin too."""
    f = layer_frame(manifest, layer)
    if f["crs"] != manifest.get("crs"):
        return False
    return not origin or f["origin"] == [float(v) for v in (manifest.get("origin") or [0, 0, 0])]


def require_project_frame(
    manifest: dict[str, Any], layers: list[dict[str, Any]], outcome: str, origin: bool = True
) -> None:
    """Refuse a layer whose space has coordinates of its own, for a job whose results are in the
    project's frame. ``outcome`` finishes the sentence ("so it cannot be exported in one")."""
    for x in layers:
        if not in_project_frame(manifest, x, origin):
            raise JobError(
                f'"{x.get("name") or x.get("id")}" is in a space with its own local coordinates, '
                f"not the project's, {outcome}."
            )


def one_frame(manifest: dict[str, Any], layers: list[dict[str, Any]], what: str) -> None:
    """Refuse layers that sit in different spaces, so a job never mixes two frames."""
    frames = {space_of_layer(x) if _listed_space(manifest, space_of_layer(x)) else "" for x in layers}
    if len(frames) > 1:
        names = ", ".join(f'"{x.get("name") or x.get("id")}"' for x in layers)
        raise JobError(
            f"Cannot {what}: {names} are in different spaces, each with its own coordinates. "
            "Pick layers of one space."
        )
