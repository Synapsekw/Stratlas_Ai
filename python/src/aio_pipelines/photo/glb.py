"""GLB helpers for the photo pipelines: a mesh in the scene frame as a GLB, and a GLB's JSON.

Self-contained on purpose (its only project import is ``volumetric.terrain.encode_glb``): the
frame and normal helpers were copied from the retired mesh and texture modules.
"""

from __future__ import annotations

import io
import json

import numpy as np

from ..volumetric.terrain import encode_glb

GENERATOR = "Quadrion AI photo.products"
JPEG_QUALITY = 88


def jpeg_bytes(img: np.ndarray, quality: int = JPEG_QUALITY) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.fromarray(img).convert("RGB").save(buf, "JPEG", quality=quality, optimize=True)
    return buf.getvalue()


def enu_to_local(v: np.ndarray) -> np.ndarray:
    """Run-local ENU (metres from the origin: E, N, H) to the scene frame (x east, y up, z south)."""
    return np.column_stack([v[:, 0], v[:, 2], -v[:, 1]])


def vertex_normals(vertices: np.ndarray, faces: np.ndarray) -> np.ndarray:
    v = vertices[faces]
    n = np.cross(v[:, 1] - v[:, 0], v[:, 2] - v[:, 0])
    out = np.zeros_like(vertices)
    for k in range(3):
        np.add.at(out, faces[:, k], n)
    ln = np.linalg.norm(out, axis=1, keepdims=True)
    return np.where(ln > 1e-12, out / np.maximum(ln, 1e-12), [0.0, 0.0, 1.0])


def glb_bytes(parts: list[dict], images: list[bytes], name: str = "mesh") -> bytes:
    """GLB of primitives ``{positions (scene frame), indices, uvs?, texture?, color?}``."""
    materials, prims = [], []
    for i, p in enumerate(parts):
        mat: dict = {"name": f"{name}-{i}"}
        if p.get("texture") is not None:
            mat["texture"] = p["texture"]
        else:
            mat["color"] = p.get("color", [0.7, 0.7, 0.7, 1.0])
        materials.append(mat)
        pos = np.asarray(p["positions"], np.float64)
        prims.append(
            {
                "material": i,
                "positions": pos.astype(np.float32),
                "normals": vertex_normals(pos, p["indices"]).astype(np.float32),
                "uvs": None if p.get("uvs") is None else np.asarray(p["uvs"], np.float32),
                "indices": np.asarray(p["indices"], np.uint32).ravel(),
            }
        )
    return encode_glb(
        [{"name": name, "mesh": 0}],
        [0],
        [{"name": name, "primitives": prims}],
        materials,
        [("image/jpeg", b) for b in images],
        GENERATOR,
    )


def glb_info(data: bytes) -> dict:
    """The JSON chunk of a GLB (for checks)."""
    length = int.from_bytes(data[12:16], "little")
    return json.loads(data[20 : 20 + length])
