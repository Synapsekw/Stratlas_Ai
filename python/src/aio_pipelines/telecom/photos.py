"""Best photos of each antenna unit and a crop of the best one.

Every posed photo (a `photos` layer item with `pos` and `q`) is a three.js camera in the project's
local frame: it looks along its local -Z, +Y is up in the image, and the focal length in pixels is
`(W / 2) / tan(hfov / 2)` (square pixels, principal point in the middle; a photo without a lens
gets the kit's 70 degree default). A unit's box corners are projected into it and the photo is
scored on how much of the box is in the frame, how squarely it looks at the face and how near it
is (no occlusion test in v1); a camera that is not on the unit's front side (a dish: its reflector
side) does not count. The top three are kept.

The crop is the projected box plus a margin, cut from the upright photo and written as a JPEG with
no metadata, at most `CROP_MAX_PX` on its longest side: the AI labelling's cost estimate and its
request size assume 512 px (packages/ai/src/antennaLabel.ts `CROP_PX`).
"""

from __future__ import annotations

import math
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np

from ..inspection.frame import KIT_DEFAULT_HFOV, asset_path, photo_layers
from ..runtime import AtomicPath
from .measure import from_project

CROP_MAX_PX = 512
CROP_MARGIN = 0.15
TOP_PHOTOS = 3
MIN_IN_FRAME = 0.25
CROP_MIN_PX = 16  # a projected box smaller than this on both sides is not worth a crop
_CORNERS = np.array([[sx, sy, sz] for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)], dtype=float) / 2


def _rotation(q: Any) -> np.ndarray:
    """Rotation matrix of the unit quaternion [x, y, z, w] (three.js order); columns are the
    camera's right, up and back axes in the local frame."""
    x, y, z, w = (float(v) for v in q)
    n = math.sqrt(x * x + y * y + z * z + w * w) or 1.0
    x, y, z, w = x / n, y / n, z / n, w / n
    return np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ]
    )


def _hfov(lens: dict | None) -> float:
    try:
        hf = float((lens or {}).get("hfovDeg") or KIT_DEFAULT_HFOV)
    except (TypeError, ValueError):
        hf = KIT_DEFAULT_HFOV
    return min(max(hf, 1.0), 170.0)


def project_points(
    item: dict, lens: dict | None, size: tuple[int, int], pts_local: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """Pixel positions (n, 2) (x right, y down from the top-left corner) and depths (n,) in front
    of the camera of local points; a point behind the camera has depth <= 0."""
    W, H = size
    R = _rotation(item["q"])
    rel = np.asarray(pts_local, dtype=float) - np.asarray(item["pos"], dtype=float)
    cam = rel @ R  # R^T (p - pos) for each row
    depth = -cam[:, 2]
    f = (W / 2) / math.tan(math.radians(_hfov(lens)) / 2)
    safe = np.where(np.abs(depth) > 1e-9, depth, 1e-9)
    px = np.column_stack([W / 2 + f * cam[:, 0] / safe, H / 2 - f * cam[:, 1] / safe])
    return px, depth


def _bbox_share(
    corners_px: np.ndarray, size: tuple[int, int]
) -> tuple[float, tuple[float, float, float, float]]:
    W, H = size
    x0, y0 = corners_px.min(axis=0)
    x1, y1 = corners_px.max(axis=0)
    area = max(x1 - x0, 1e-9) * max(y1 - y0, 1e-9)
    ix = max(0.0, min(x1, W) - max(x0, 0.0))
    iy = max(0.0, min(y1, H) - max(y0, 0.0))
    return float(ix * iy / area), (float(x0), float(y0), float(x1), float(y1))


def score_photo(
    corners_px: np.ndarray,
    depth: np.ndarray,
    size: tuple[int, int],
    view_dir: np.ndarray,
    normal: np.ndarray,
    distance_m: float,
) -> float:
    """0 when any corner is behind the camera, the camera is not on the unit's front side
    ((camera - centre) . normal <= 0, i.e. view_dir . normal >= 0) or under 25 percent of the
    projected box is in the frame; else 0.4 x in-frame share + 0.4 x frontalness (-view_dir . normal, at least 0) + 0.2 /
    (1 + distance / 20 m). In [0, 1]."""
    if np.any(np.asarray(depth) <= 0):
        return 0.0
    v = np.asarray(view_dir, dtype=float)
    n = np.asarray(normal, dtype=float)
    if float(v @ n) >= 0:  # the camera is behind the unit's front (for a dish: its back)
        return 0.0
    share, _ = _bbox_share(np.asarray(corners_px, dtype=float), size)
    if share < MIN_IN_FRAME:
        return 0.0
    v = v / (np.linalg.norm(v) or 1.0)
    n = n / (np.linalg.norm(n) or 1.0)
    facing = max(0.0, float(-(v @ n)))
    return float(min(1.0, 0.4 * share + 0.4 * facing + 0.2 / (1.0 + float(distance_m) / 20.0)))


def _local_box(unit: dict, origin) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Centre, axes (rows across, up, outward) and extents of a unit's box in the local frame."""
    box = unit["box"]
    centre = from_project(np.asarray(box["centre"], dtype=float), origin)
    axes_enu = np.asarray(box["axes"], dtype=float)
    axes = np.column_stack([axes_enu[:, 0], axes_enu[:, 2], -axes_enu[:, 1]])  # E, N, U -> x, y, z
    return centre, axes, np.asarray(box["extents"], dtype=float)


def box_corners(unit: dict, origin) -> np.ndarray:
    centre, axes, ext = _local_box(unit, origin)
    return centre + (_CORNERS * ext) @ axes


def _image_size(path: Path) -> tuple[int, int] | None:
    """Upright size (EXIF orientation applied) without decoding the pixels."""
    from PIL import Image

    try:
        with Image.open(path) as im:
            w, h = im.size
            orientation = int(im.getexif().get(0x0112, 1) or 1)
    except Exception:
        return None
    return (h, w) if orientation in (5, 6, 7, 8) else (w, h)


def posed_photos(manifest: dict, project: Path) -> list[dict]:
    """Every photo with a position, an orientation and a readable file: the item plus `_layer`,
    `_file` and `_size`."""
    out = []
    for layer in photo_layers(manifest):
        for item in layer.get("items") or []:
            if not isinstance(item, dict) or not item.get("pos") or not item.get("q") or not item.get("id"):
                continue
            path = asset_path(project, item.get("src"))
            if path is None or not path.is_file():
                continue
            size = _image_size(path)
            if size is None:
                continue
            out.append({**item, "_layer": str(layer.get("id")), "_file": path, "_size": size})
    return out


def _origin(manifest: dict) -> tuple[float, float, float]:
    o = manifest.get("origin") or [0.0, 0.0, 0.0]
    return float(o[0]), float(o[1]), float(o[2])


def best_photos(
    units: list[dict], manifest: dict, project: Path, check: Callable[[], None] | None = None
) -> dict[str, list[dict]]:
    """Unit id -> its best photos, best first: up to `TOP_PHOTOS` of {layer, id, score}; photos
    that do not see the unit (score 0) are left out."""
    origin = _origin(manifest)
    out: dict[str, list[dict]] = {u["id"]: [] for u in units}
    photos = posed_photos(manifest, project)
    if not photos or not units:
        return out
    boxes = [_local_box(u, origin) for u in units]
    corners = np.stack([c + (_CORNERS * e) @ a for c, a, e in boxes])  # (units, 8, 3)
    centres = np.stack([c for c, _, _ in boxes])
    normals = np.stack([a[2] for _, a, _ in boxes])
    scores: list[list[tuple[float, dict]]] = [[] for _ in units]
    for ph in photos:
        if check:
            check()
        px, depth = project_points(ph, ph.get("lens"), ph["_size"], corners.reshape(-1, 3))
        px, depth = px.reshape(len(units), 8, 2), depth.reshape(len(units), 8)
        cam = np.asarray(ph["pos"], dtype=float)
        for k in range(len(units)):
            view = centres[k] - cam
            dist = float(np.linalg.norm(view))
            s = score_photo(px[k], depth[k], ph["_size"], view, normals[k], dist)
            if s > 0:
                scores[k].append((s, ph))
    for k, u in enumerate(units):
        top = sorted(scores[k], key=lambda t: (-t[0], t[1]["_layer"], str(t[1]["id"])))[:TOP_PHOTOS]
        out[u["id"]] = [
            {"layer": ph["_layer"][:128], "id": str(ph["id"])[:128], "score": round(s, 3)} for s, ph in top
        ]
    return out


def write_crop(project: Path, unit: dict, photo: dict, manifest: dict, out: Path) -> Path | None:
    """A JPEG of the unit's projected box plus `CROP_MARGIN` on each side, cut from the photo
    `photo` ({layer, id}) and at most `CROP_MAX_PX` on its longest side. None when the photo is
    not found, not posed, or does not see the box."""
    from PIL import Image, ImageOps

    item = next(
        (
            p
            for p in posed_photos(manifest, project)
            if p["_layer"] == photo.get("layer") and str(p["id"]) == photo.get("id")
        ),
        None,
    )
    if item is None:
        return None
    px, depth = project_points(item, item.get("lens"), item["_size"], box_corners(unit, _origin(manifest)))
    if np.any(depth <= 0):
        return None
    W, H = item["_size"]
    x0, y0 = px.min(axis=0)
    x1, y1 = px.max(axis=0)
    mx, my = CROP_MARGIN * (x1 - x0), CROP_MARGIN * (y1 - y0)
    left, top = max(0, math.floor(x0 - mx)), max(0, math.floor(y0 - my))
    right, bottom = min(W, math.ceil(x1 + mx)), min(H, math.ceil(y1 + my))
    if (right - left < CROP_MIN_PX and bottom - top < CROP_MIN_PX) or right <= left or bottom <= top:
        return None
    try:
        with Image.open(item["_file"]) as raw:
            up = ImageOps.exif_transpose(raw)
            up = (up if up is not None else raw).convert("RGB")
    except Exception:
        return None
    crop = up.crop((left, top, right, bottom))
    crop.thumbnail((CROP_MAX_PX, CROP_MAX_PX), Image.LANCZOS)
    with AtomicPath(Path(out)) as tmp:
        crop.save(tmp, format="JPEG", quality=85)  # no exif argument: no metadata of the photo
    return Path(out)
